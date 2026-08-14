"use client";

import { useCallback, useEffect, useState } from "react";
import { MintDestinationChooser } from "./MintDestinationChooser";
import { VaultDetailsModal } from "./VaultDetailsModal";
import {
  destinationLabel,
  isVaultDestination,
  type MintDestinationKind,
} from "@/lib/mintDestination";
import type { LiquidityNode, LiquidityOverview } from "@/lib/liquidityTypes";
import { humanizeExecutorError } from "@/lib/executorErrorMessage";

type CheckStatus = "pass" | "warn" | "fail";
type SigningStage =
  | "awaiting"
  | "submitting"
  | "signed"
  | "rejected"
  | "cancelled"
  | "expired"
  | "malformed";

interface MintReview {
  checkedAt: string;
  smartAccountRequired: boolean;
  destination: MintDestinationKind;
  path: string;
  transaction: {
    network: "XRPL Testnet";
    sourceAddress: string;
    destination: string;
    amountXrp: string;
    amountDrops: string;
    recipient: string;
    executorAddress: string;
    memoData: string;
    vaultAddress?: string;
    personalAccount?: string;
    shareReceiver?: string;
    shareReceiverIsPersonalAccount?: boolean;
  };
  fees: {
    mintingFeeDrops: string;
    executorFeeDrops: string;
    expectedFxrpDrops: string;
    paymentUsd: string | null;
  };
  ftso: {
    value: string;
    decimals: number;
    timestamp: string;
  } | null;
  checks: Array<{
    id: string;
    status: CheckStatus;
    message: string;
    source: string;
    timestamp: string;
  }>;
}

interface SigningRequest {
  payloadId: string;
  deepLink: string;
  qrCode: string;
}

interface SigningStatus {
  stage: SigningStage;
  payloadId: string;
  transactionId?: string;
  signer?: string;
  message: string;
}

interface MintProgressStatus {
  transactionId: string;
  stage:
    | "waiting_for_executor"
    | "observed"
    | "confirming"
    | "attestation_requested"
    | "finalized"
    | "proof_fetched"
    | "execution_submitted"
    | "minted"
    | "failed"
    | "recovery_required";
  phase: "prove" | "mint" | "complete" | "attention";
  message: string;
  expectedTiming: string;
  executorReachable: boolean;
  attempts: number;
  updatedAt: string;
  nextAttemptAt: string | null;
  votingRoundId?: string;
  fdcSubmissionTransactionHash?: string;
  flareTransactionHash?: string;
  settlement?: {
    flareTransactionHash: string;
    blockNumber: string;
    recipient: string;
    executor: string;
    mintedAmountUBA: string;
    mintingFeeUBA: string;
    executorFeeUBA: string;
  };
  error?: {
    code: string;
    message: string;
    retryable: boolean;
    occurredAt: string;
  };
  fxrpBalance?: {
    recipient: string;
    balanceUBA: string;
    source: string;
    timestamp: string;
  };
}

interface StoredSession {
  version: 2;
  review: MintReview;
  signing: SigningRequest;
  transactionId?: string;
}

const STORAGE_KEY = "flareramp.directMintSigning.v2";

function dropsToXrp(drops: string): string {
  const padded = drops.padStart(7, "0");
  const whole = padded.slice(0, -6);
  const fraction = padded.slice(-6).replace(/0+$/, "");
  return `${whole}${fraction ? `.${fraction}` : ""}`;
}

function formatTimestamp(dateStr: string | null | undefined): string {
  if (!dateStr) return "Pending";
  try {
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) return dateStr;
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const month = months[date.getUTCMonth()];
    const day = date.getUTCDate();
    const year = date.getUTCFullYear();
    let hours = date.getUTCHours();
    const minutes = String(date.getUTCMinutes()).padStart(2, "0");
    const seconds = String(date.getUTCSeconds()).padStart(2, "0");
    const ampm = hours >= 12 ? "PM" : "AM";
    hours = hours % 12;
    hours = hours ? hours : 12;
    return `${month} ${day}, ${year} ${hours}:${minutes}:${seconds} ${ampm} (UTC)`;
  } catch {
    return dateStr;
  }
}


function messageFromResponse(value: unknown, fallback: string): string {
  return typeof value === "object" &&
    value !== null &&
    "error" in value &&
    typeof value.error === "string"
    ? value.error
    : fallback;
}

export function DirectMintSigning() {
  const [destination, setDestination] = useState<MintDestinationKind>("wallet");
  const [pendingVault, setPendingVault] = useState<
    "firelight" | "upshift" | null
  >(null);
  const [vaultNode, setVaultNode] = useState<LiquidityNode | null>(null);
  const [vaultLoading, setVaultLoading] = useState(false);
  const [vaultError, setVaultError] = useState<string | null>(null);
  const [sourceAddress, setSourceAddress] = useState("");
  const [recipient, setRecipient] = useState("");
  // Vault destinations only. Blank means "credit shares to the Personal
  // Account" — the safe default, kept behind a disclosure because the value is
  // committed in the signed memo and cannot be corrected afterwards.
  const [shareReceiver, setShareReceiver] = useState("");
  const [shareReceiverOpen, setShareReceiverOpen] = useState(false);
  const [amountXrp, setAmountXrp] = useState("1");
  const [review, setReview] = useState<MintReview | null>(null);
  const [signing, setSigning] = useState<SigningRequest | null>(null);
  const [status, setStatus] = useState<SigningStatus | null>(null);
  const [transactionId, setTransactionId] = useState<string | null>(null);
  const [progress, setProgress] = useState<MintProgressStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const readStatus = useCallback(async (payloadId: string) => {
    const response = await fetch(`/api/mint/sign/${payloadId}`, {
      cache: "no-store",
    });
    const data = (await response.json()) as SigningStatus | { error: string };
    if (!response.ok) {
      throw new Error(messageFromResponse(data, "Could not read Xaman status"));
    }
    const nextStatus = data as SigningStatus;
    setStatus(nextStatus);
    if (
      (nextStatus.stage === "signed" || nextStatus.stage === "submitting") &&
      nextStatus.transactionId
    ) {
      setTransactionId(nextStatus.transactionId);
    } else if (
      nextStatus.stage !== "awaiting" &&
      nextStatus.stage !== "submitting"
    ) {
      localStorage.removeItem(STORAGE_KEY);
    }
    return nextStatus;
  }, []);

  useEffect(() => {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    try {
      const stored = JSON.parse(raw) as StoredSession;
      if (
        stored.version !== 2 ||
        !stored.signing?.payloadId ||
        !stored.review?.transaction
      ) {
        throw new Error("Stored signing session is malformed");
      }
      setReview(stored.review);
      setSigning(stored.signing);
      setSourceAddress(stored.review.transaction.sourceAddress);
      setRecipient(stored.review.transaction.recipient);
      setAmountXrp(stored.review.transaction.amountXrp);
      if (
        stored.review.destination === "wallet" ||
        stored.review.destination === "firelight" ||
        stored.review.destination === "upshift"
      ) {
        setDestination(stored.review.destination);
      }
      if (stored.transactionId) {
        setTransactionId(stored.transactionId);
        setStatus({
          stage: "signed",
          payloadId: stored.signing.payloadId,
          transactionId: stored.transactionId,
          message: "Payment signed and validated on XRPL",
        });
      } else {
        void readStatus(stored.signing.payloadId).catch((cause) => {
          setError(cause instanceof Error ? cause.message : String(cause));
        });
      }
    } catch {
      localStorage.removeItem(STORAGE_KEY);
      setError("The saved signing session was malformed and was cleared");
    }
  }, [readStatus]);

  const terminalProgress =
    progress?.stage === "minted" ||
    progress?.stage === "failed" ||
    progress?.stage === "recovery_required";

  useEffect(() => {
    if (!review || !signing) return;
    // Persist only resumable sessions. Terminal outcomes clear storage so a
    // refresh returns to a blank form instead of re-locking the UI.
    if (terminalProgress) {
      localStorage.removeItem(STORAGE_KEY);
      return;
    }
    if (
      status?.stage === "awaiting" ||
      status?.stage === "submitting" ||
      transactionId
    ) {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          version: 2,
          review,
          signing,
          transactionId: transactionId ?? undefined,
        } satisfies StoredSession),
      );
    }
  }, [review, signing, status?.stage, terminalProgress, transactionId]);

  useEffect(() => {
    if (
      !signing ||
      (status?.stage !== "awaiting" && status?.stage !== "submitting")
    ) {
      return;
    }
    const timer = window.setInterval(() => {
      void readStatus(signing.payloadId).catch((cause) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      });
    }, 3_000);
    return () => window.clearInterval(timer);
  }, [readStatus, signing, status?.stage]);

  const readMintProgress = useCallback(
    async (id: string, fxrpRecipient: string) => {
      const response = await fetch(
        `/api/mint/status/${id}?recipient=${encodeURIComponent(fxrpRecipient)}`,
        { cache: "no-store" },
      );
      const data = (await response.json()) as
        | MintProgressStatus
        | { error: string };
      if (!response.ok) {
        throw new Error(
          messageFromResponse(data, "Could not read executor progress"),
        );
      }
      setProgress(data as MintProgressStatus);
    },
    [],
  );

  useEffect(() => {
    if (!transactionId || !review) return;
    if (terminalProgress) {
      localStorage.removeItem(STORAGE_KEY);
      return;
    }
    void readMintProgress(transactionId, review.transaction.recipient).catch(
      (cause) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      },
    );
    const timer = window.setInterval(() => {
      void readMintProgress(transactionId, review.transaction.recipient).catch(
        (cause) => {
          setError(cause instanceof Error ? cause.message : String(cause));
        },
      );
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [readMintProgress, review, terminalProgress, transactionId]);

  async function prepareReview() {
    setBusy(true);
    setError(null);
    setSigning(null);
    setStatus(null);
    setTransactionId(null);
    setProgress(null);
    localStorage.removeItem(STORAGE_KEY);
    try {
      const response = await fetch("/api/mint/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceAddress,
          recipient: isVaultDestination(destination) ? undefined : recipient,
          amountXrp,
          destination,
          shareReceiver: isVaultDestination(destination)
            ? shareReceiver.trim() || undefined
            : undefined,
        }),
      });
      const data = (await response.json()) as MintReview | { error: string };
      if (!response.ok) {
        throw new Error(messageFromResponse(data, "Readiness check failed"));
      }
      setReview(data as MintReview);
    } catch (cause) {
      setReview(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function openXaman() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/mint/sign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceAddress,
          recipient: isVaultDestination(destination) ? undefined : recipient,
          amountXrp,
          destination,
          shareReceiver: isVaultDestination(destination)
            ? shareReceiver.trim() || undefined
            : undefined,
        }),
      });
      const data = (await response.json()) as
        | { review: MintReview; signing: SigningRequest }
        | { error: string };
      if (!response.ok || !("signing" in data)) {
        throw new Error(
          messageFromResponse(data, "Could not create Xaman request"),
        );
      }
      setReview(data.review);
      setSigning(data.signing);
      setStatus({
        stage: "awaiting",
        payloadId: data.signing.payloadId,
        message: "Waiting for approval in Xaman",
      });
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          version: 2,
          review: data.review,
          signing: data.signing,
        } satisfies StoredSession),
      );
      window.open(data.signing.deepLink, "_blank", "noopener,noreferrer");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function selectDestination(kind: MintDestinationKind) {
    if (kind === "wallet") {
      setDestination("wallet");
      setPendingVault(null);
      setVaultNode(null);
      setVaultError(null);
      return;
    }
    setPendingVault(kind);
    setVaultLoading(true);
    setVaultError(null);
    setVaultNode(null);
    try {
      const response = await fetch("/api/liquidity", { cache: "no-store" });
      const data = (await response.json()) as
        | LiquidityOverview
        | { error: string };
      if (!response.ok || !("nodes" in data)) {
        throw new Error(
          messageFromResponse(data, "Could not load vault details"),
        );
      }
      const protocol = kind === "firelight" ? "Firelight" : "Upshift";
      const node = data.nodes.find((entry) => entry.protocol === protocol);
      if (!node) {
        throw new Error(`${protocol} vault is not available on Coston2`);
      }
      setVaultNode(node);
    } catch (cause) {
      setVaultError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setVaultLoading(false);
    }
  }

  async function cancelSigning() {
    if (!signing) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/mint/sign/${signing.payloadId}`,
        { method: "DELETE" },
      );
      const data = (await response.json()) as SigningStatus | { error: string };
      if (!response.ok) {
        throw new Error(messageFromResponse(data, "Cancellation failed"));
      }
      setStatus(data as SigningStatus);
      setTransactionId(null);
      setProgress(null);
      localStorage.removeItem(STORAGE_KEY);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  function resetFlow() {
    const activePayloadId =
      signing &&
      (status?.stage === "awaiting" || status?.stage === "submitting")
        ? signing.payloadId
        : null;
    setReview(null);
    setSigning(null);
    setStatus(null);
    setTransactionId(null);
    setProgress(null);
    setError(null);
    localStorage.removeItem(STORAGE_KEY);
    if (activePayloadId) {
      void fetch(`/api/mint/sign/${activePayloadId}`, { method: "DELETE" }).catch(
        () => undefined,
      );
    }
  }

  const sessionActive = Boolean(review || signing || transactionId);

  const hasFailure = review?.checks.some(
    (check) => check.status === "fail",
  );
  const signingActive =
    signing &&
    (status?.stage === "awaiting" || status?.stage === "submitting");
  const flowLocked = Boolean(signingActive || transactionId);
  const proveComplete =
    progress?.phase === "mint" || progress?.phase === "complete";
  const steps = [
    {
      label: "Check",
      state: review ? "complete" : "active",
    },
    {
      label: "Sign",
      state: transactionId ? "complete" : signing ? "active" : "pending",
    },
    {
      label: "Prove",
      state: proveComplete
        ? "complete"
        : transactionId
          ? "active"
          : "pending",
    },
    {
      label: "Mint",
      state:
        progress?.phase === "complete"
          ? "complete"
          : progress?.phase === "mint"
            ? "active"
            : "pending",
    },
  ] as const;

  return (
    <section className="max-w-4xl mx-auto px-4 pt-8 pb-12">
      <VaultDetailsModal
        open={pendingVault !== null}
        protocol={
          pendingVault === "upshift"
            ? "Upshift"
            : pendingVault === "firelight"
              ? "Firelight"
              : "Firelight"
        }
        node={vaultNode}
        loading={vaultLoading}
        error={vaultError}
        onCancel={() => {
          setPendingVault(null);
          setVaultNode(null);
          setVaultError(null);
        }}
        onProceed={() => {
          if (!pendingVault) return;
          setDestination(pendingVault);
          setPendingVault(null);
        }}
      />
      <header className="mb-10 text-center md:text-left">
        <h1 className="text-4xl md:text-5xl font-black tracking-tight text-white mb-4 bg-clip-text text-transparent bg-gradient-to-r from-white via-zinc-100 to-zinc-400">
          Mint FXRP with Xaman
        </h1>
        <p className="text-zinc-400 max-w-2xl leading-relaxed text-base md:text-lg">
          Review a live protocol quote, then approve one Core Vault payment in
          your own Xaman wallet. Choose wallet delivery or mint-and-deposit into
          Firelight / Upshift. FlareRamp never asks for your seed.
        </p>
      </header>

      <nav
        aria-label="Mint progress"
        className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-10"
      >
        {steps.map((step, index) => {
          const borderClass =
            step.state === "complete"
              ? "border-emerald-500 text-emerald-400 bg-emerald-950/5"
              : step.state === "active"
                ? "border-brand-500 text-brand-400 bg-brand-950/5 shadow-[0_0_15px_rgba(232,93,53,0.05)]"
                : "border-zinc-800 text-zinc-500 bg-zinc-900/10";
          return (
            <div
              key={step.label}
              aria-current={step.state === "active" ? "step" : undefined}
              className={`border-t-4 p-4 transition-all duration-300 rounded-b-lg ${borderClass}`}
            >
              <span className="text-xs font-mono opacity-80 block mb-1">0{index + 1}</span>
              <strong className="text-sm font-semibold uppercase tracking-wider block">{step.label}</strong>
            </div>
          );
        })}
      </nav>

      {sessionActive && (
        <div className="mb-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 rounded-xl border border-zinc-800 bg-zinc-950/50 px-4 py-3">
          <p className="text-sm text-zinc-400">
            {terminalProgress
              ? progress?.stage === "minted"
                ? "This mint finished. Start over whenever you want another payment."
                : "This mint ended with an error. You can keep the details below or start over."
              : transactionId
                ? "Resuming an in-progress mint. You can abandon it and start over anytime."
                : "A signing session is open. Cancel it here if you want to change the payment."}
          </p>
          <button
            type="button"
            onClick={resetFlow}
            className="shrink-0 self-start sm:self-auto border border-zinc-700 hover:border-zinc-500 bg-zinc-900 hover:bg-zinc-800 text-zinc-200 font-semibold px-4 py-2 rounded-xl text-xs uppercase tracking-wider transition-all"
          >
            Start over
          </button>
        </div>
      )}

      <div className="bg-zinc-900/30 border border-zinc-800/80 backdrop-blur-md p-6 rounded-2xl shadow-xl">
        <MintDestinationChooser
          value={destination}
          disabled={flowLocked}
          onSelect={(kind) => {
            if (!flowLocked) void selectDestination(kind);
          }}
        />
        <p className="mb-4 text-xs text-zinc-500">
          Selected: {destinationLabel(destination)}
        </p>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-6 items-end">
          <div className="md:col-span-3 grid grid-cols-1 sm:grid-cols-3 gap-4">
            <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-400">
              XRPL source address
              <input
                value={sourceAddress}
                onChange={(event) => setSourceAddress(event.target.value)}
                placeholder="r..."
                disabled={flowLocked}
                className="mt-2 block w-full bg-zinc-950 border border-zinc-800 text-zinc-100 rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-brand-500/50 focus:border-brand-500 placeholder-zinc-700 transition-all disabled:opacity-50 disabled:cursor-not-allowed font-mono text-sm"
              />
            </label>
            {!isVaultDestination(destination) ? (
              <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-400">
                FXRP recipient on Coston2
                <input
                  value={recipient}
                  onChange={(event) => setRecipient(event.target.value)}
                  placeholder="0x..."
                  disabled={flowLocked}
                  className="mt-2 block w-full bg-zinc-950 border border-zinc-800 text-zinc-100 rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-brand-500/50 focus:border-brand-500 placeholder-zinc-700 transition-all disabled:opacity-50 disabled:cursor-not-allowed font-mono text-sm"
                />
              </label>
            ) : (
              <div className="block text-xs font-semibold uppercase tracking-wider text-zinc-400">
                Smart Account recipient
                <p className="mt-2 text-sm font-mono text-zinc-300 bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-3">
                  Derived from XRPL source
                </p>
                <p className="mt-2 normal-case font-normal tracking-normal text-xs text-zinc-500">
                  FXRP must land in your Smart Account for the vault deposit to
                  execute. Vault shares can go elsewhere.
                </p>
              </div>
            )}
            <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-400">
              TestXRP payment amount
              <input
                value={amountXrp}
                onChange={(event) => setAmountXrp(event.target.value)}
                inputMode="decimal"
                disabled={flowLocked}
                className="mt-2 block w-full bg-zinc-950 border border-zinc-800 text-zinc-100 rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-brand-500/50 focus:border-brand-500 placeholder-zinc-700 transition-all disabled:opacity-50 disabled:cursor-not-allowed font-mono text-sm"
              />
            </label>
          </div>
          {isVaultDestination(destination) && (
            <div className="md:col-span-4">
              {!shareReceiverOpen ? (
                <button
                  type="button"
                  onClick={() => setShareReceiverOpen(true)}
                  disabled={flowLocked}
                  className="text-xs font-semibold uppercase tracking-wider text-zinc-500 hover:text-zinc-300 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  + Send vault shares to a different address
                </button>
              ) : (
                <div className="border border-zinc-800 bg-zinc-950/40 rounded-xl p-4">
                  <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-400">
                    Vault share recipient
                    <input
                      value={shareReceiver}
                      onChange={(event) => setShareReceiver(event.target.value)}
                      placeholder="0x… (leave blank to use your Smart Account)"
                      disabled={flowLocked}
                      className="mt-2 block w-full bg-zinc-950 border border-zinc-800 text-zinc-100 rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-brand-500/50 focus:border-brand-500 placeholder-zinc-700 transition-all disabled:opacity-50 disabled:cursor-not-allowed font-mono text-sm"
                    />
                  </label>
                  <p className="mt-3 text-xs text-amber-400/90 leading-relaxed">
                    This address is committed inside the memo you sign, so it
                    cannot be changed or recovered afterwards. Shares sent to an
                    address you do not control are unrecoverable. Leave blank to
                    credit your Smart Account.
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      setShareReceiver("");
                      setShareReceiverOpen(false);
                    }}
                    disabled={flowLocked}
                    className="mt-3 text-xs font-semibold uppercase tracking-wider text-zinc-500 hover:text-zinc-300 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Use my Smart Account instead
                  </button>
                </div>
              )}
            </div>
          )}
          <button
            onClick={prepareReview}
            disabled={busy || flowLocked}
            className="w-full bg-gradient-to-r from-brand-600 to-brand-500 hover:from-brand-500 hover:to-brand-400 text-white font-bold px-4 py-3 rounded-xl transition-all shadow-[0_4px_20px_rgba(232,93,53,0.15)] disabled:opacity-50 disabled:cursor-not-allowed disabled:shadow-none flex items-center justify-center gap-2 text-sm uppercase tracking-wider font-semibold h-[46px]"
          >
            {busy ? (
              <>
                <svg className="animate-spin h-5 w-5 text-white" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                <span>Checking...</span>
              </>
            ) : (
              "Check readiness"
            )}
          </button>
        </div>

        {error && (
          <div role="alert" className="mt-6 flex items-center gap-3 bg-red-950/20 border border-red-900/50 text-red-400 px-4 py-3 rounded-xl text-sm font-medium">
            <svg className="h-5 w-5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <span>{error}</span>
          </div>
        )}
      </div>

      {review && (
        <div className="mt-10 grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="lg:col-span-2 space-y-6">
            <section className="bg-zinc-900/30 border border-zinc-800/80 backdrop-blur-md p-6 rounded-2xl shadow-xl">
              <h2 className="text-xl font-bold text-white mb-4 flex items-center gap-2 border-b border-zinc-800 pb-3">
                <svg className="h-5 w-5 text-brand-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                Approve Payment Details
              </h2>
              <p className="text-zinc-400 text-sm mb-6 bg-zinc-950/40 p-3 rounded-lg border border-zinc-900">
                <span className="font-semibold text-brand-400">Path:</span>{" "}
                {review.path}.{" "}
                {review.smartAccountRequired
                  ? "A Smart Account personal account receives FXRP and deposits to the vault in one atomic Flare transaction."
                  : "A Smart Account is not required for this mint."}
              </p>
              <dl className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
                <div className="bg-zinc-950/30 p-3 rounded-xl border border-zinc-900">
                  <dt className="text-zinc-500 font-medium text-xs uppercase tracking-wider mb-1">Destination Address</dt>
                  <dd className="text-zinc-200 overflow-wrap-anywhere break-all font-mono font-semibold">{review.transaction.destination}</dd>
                </div>
                <div className="bg-zinc-950/30 p-3 rounded-xl border border-zinc-900">
                  <dt className="text-zinc-500 font-medium text-xs uppercase tracking-wider mb-1">Payment Amount</dt>
                  <dd className="text-zinc-200 font-semibold">{review.transaction.amountXrp} TestXRP ({review.transaction.amountDrops} drops)</dd>
                </div>
                <div className="bg-zinc-950/30 p-3 rounded-xl border border-zinc-900">
                  <dt className="text-zinc-500 font-medium text-xs uppercase tracking-wider mb-1">Protocol Minting Fee</dt>
                  <dd className="text-zinc-200 font-semibold">{dropsToXrp(review.fees.mintingFeeDrops)} TestXRP</dd>
                </div>
                <div className="bg-zinc-950/30 p-3 rounded-xl border border-zinc-900">
                  <dt className="text-zinc-500 font-medium text-xs uppercase tracking-wider mb-1">Operator Executor Fee</dt>
                  <dd className="text-zinc-200 font-semibold">{dropsToXrp(review.fees.executorFeeDrops)} TestXRP</dd>
                </div>
                <div className="bg-zinc-950/30 p-3 rounded-xl border border-zinc-900">
                  <dt className="text-zinc-500 font-medium text-xs uppercase tracking-wider mb-1">Expected FXRP Received</dt>
                  <dd className="text-brand-400 font-bold text-base">{dropsToXrp(review.fees.expectedFxrpDrops)} FXRP</dd>
                </div>
                <div className="bg-zinc-950/30 p-3 rounded-xl border border-zinc-900">
                  <dt className="text-zinc-500 font-medium text-xs uppercase tracking-wider mb-1">Recipient Address (Coston2)</dt>
                  <dd className="text-zinc-200 overflow-wrap-anywhere break-all font-mono font-semibold">{review.transaction.recipient}</dd>
                </div>
                <div className="bg-zinc-950/30 p-3 rounded-xl border border-zinc-900 md:col-span-2">
                  <dt className="text-zinc-500 font-medium text-xs uppercase tracking-wider mb-1">Operator Executor Address</dt>
                  <dd className="text-zinc-200 overflow-wrap-anywhere break-all font-mono text-xs">{review.transaction.executorAddress}</dd>
                </div>
                <div className="bg-zinc-950/30 p-3 rounded-xl border border-zinc-900 md:col-span-2">
                  <dt className="text-zinc-500 font-medium text-xs uppercase tracking-wider mb-1">
                    {review.smartAccountRequired
                      ? "Smart Accounts memo (0xFE)"
                      : "48-byte Encoded Memo"}
                  </dt>
                  <dd className="text-brand-300 overflow-wrap-anywhere break-all font-mono text-xs font-semibold">{review.transaction.memoData}</dd>
                </div>
              </dl>
            </section>
          </div>

          <div className="space-y-6">
            <section className="bg-zinc-900/30 border border-zinc-800/80 backdrop-blur-md p-6 rounded-2xl shadow-xl">
              <h2 className="text-xl font-bold text-white mb-4 border-b border-zinc-800 pb-3 flex items-center gap-2">
                <svg className="h-5 w-5 text-brand-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 002 2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
                </svg>
                Readiness Checks
              </h2>
              <div className="space-y-3">
                {review.checks.map((check) => {
                  const statusColors =
                    check.status === "fail"
                      ? "text-red-400 border-red-500/20 bg-red-950/20"
                      : check.status === "warn"
                        ? "text-amber-400 border-amber-500/20 bg-amber-950/20"
                        : "text-emerald-400 border-emerald-500/20 bg-emerald-950/20";
                  return (
                    <details
                      key={check.id}
                      open={check.status === "fail"}
                      className="border border-zinc-800 bg-zinc-950/20 rounded-xl overflow-hidden group transition-all"
                    >
                      <summary className="cursor-pointer p-4 rounded-xl flex justify-between items-center bg-zinc-950/30 select-none hover:bg-zinc-900/20 transition-all text-sm font-semibold">
                        <span className="flex items-center gap-2">
                          <span className={`px-2 py-0.5 rounded text-[10px] uppercase font-bold border ${statusColors}`}>
                            {check.status}
                          </span>
                          <span className="text-zinc-200 group-open:text-white transition-colors">{check.id}</span>
                        </span>
                        <svg className="h-4 w-4 text-zinc-500 group-open:rotate-180 transition-transform" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" />
                        </svg>
                      </summary>
                      <div className="p-4 bg-zinc-950/50 text-zinc-400 text-xs border-t border-zinc-900 leading-relaxed space-y-2">
                        <p>{check.message}</p>
                        <p className="text-[10px] text-zinc-600 font-mono">
                          Source: {check.source} <br />
                          Time: {formatTimestamp(check.timestamp)}
                        </p>
                      </div>
                    </details>
                  );
                })}
              </div>
            </section>

            {!signing && (
              <button
                onClick={openXaman}
                disabled={busy || hasFailure}
                className="w-full bg-gradient-to-r from-brand-500 to-brand-600 hover:from-brand-400 hover:to-brand-500 text-white font-bold p-4 rounded-xl transition-all shadow-[0_4px_25px_rgba(232,93,53,0.2)] disabled:opacity-50 disabled:cursor-not-allowed disabled:shadow-none flex items-center justify-center gap-2 uppercase tracking-wider font-extrabold text-sm"
              >
                {busy ? "Opening Xaman..." : "Open verified payment in Xaman"}
              </button>
            )}
          </div>
        </div>
      )}

      {signing && status && (
        <section className="bg-zinc-900/30 border border-brand-500/20 shadow-[0_0_40px_rgba(232,93,53,0.06)] backdrop-blur-md p-6 rounded-2xl mt-8">
          <h2 className="text-xl font-bold text-white mb-4 pb-3 border-b border-zinc-800/80 flex items-center gap-2">
            <svg className="h-5 w-5 text-brand-500 animate-pulse" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
            Sign Transaction · Xaman <span className="capitalize text-brand-400">{status.stage}</span>
          </h2>
          <p className="text-zinc-300 text-sm mb-6">{status.message}</p>
          {signingActive && (
            <div className="flex flex-col md:flex-row items-center gap-8 bg-zinc-950/40 p-6 rounded-xl border border-zinc-900">
              <div className="bg-white p-3 rounded-2xl flex-shrink-0 border border-zinc-800 shadow-inner">
                {/* Dynamic Xaman QR URLs are short-lived and must bypass image optimization. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={signing.qrCode}
                  width={200}
                  height={200}
                  alt="Xaman signing QR code"
                  className="rounded-lg"
                />
              </div>
              <div className="flex-grow space-y-4 text-center md:text-left">
                <h3 className="text-white font-semibold">Scan QR Code or Open Link</h3>
                <p className="text-zinc-400 text-xs leading-relaxed max-w-sm">
                  Scan this QR code with your Xaman App to sign the payment securely. If you are on a mobile device, tap the button below.
                </p>
                <div className="flex flex-wrap justify-center md:justify-start gap-4">
                  <a
                    href={signing.deepLink}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-2 bg-white hover:bg-zinc-200 text-zinc-950 font-bold px-4 py-2.5 rounded-xl transition-all text-xs uppercase tracking-wider shadow"
                  >
                    Open Xaman Link
                  </a>
                  <button
                    onClick={cancelSigning}
                    disabled={busy}
                    className="inline-flex items-center gap-2 border border-zinc-800 hover:border-zinc-700 bg-zinc-900/50 hover:bg-zinc-900 text-zinc-400 hover:text-zinc-200 text-xs px-4 py-2.5 rounded-xl transition-all font-semibold uppercase tracking-wider disabled:opacity-50"
                  >
                    Cancel request
                  </button>
                </div>
              </div>
            </div>
          )}
          {status.transactionId && (
            <div className="mt-4 p-4 bg-zinc-950/50 rounded-xl border border-zinc-900 flex items-center justify-between">
              <span className="text-zinc-400 text-sm">XRPL Transaction ID:</span>
              <a
                href={`https://testnet.xrpl.org/transactions/${status.transactionId}`}
                target="_blank"
                rel="noreferrer"
                className="text-brand-400 hover:text-brand-300 font-mono text-xs break-all font-semibold underline"
              >
                {status.transactionId}
              </a>
            </div>
          )}
          {!signingActive && status.stage !== "signed" && (
            <button
              onClick={resetFlow}
              className="mt-6 bg-zinc-800 hover:bg-zinc-700 text-white font-bold px-4 py-2 rounded-xl transition-all text-xs uppercase tracking-wider"
            >
              Start a new request
            </button>
          )}
        </section>
      )}

      {transactionId && (
        <section
          aria-live="polite"
          className="bg-zinc-900/30 border border-zinc-800/80 backdrop-blur-md p-6 rounded-2xl shadow-xl mt-8"
        >
          <div className="flex items-center justify-between border-b border-zinc-800/80 pb-4 mb-6">
            <h2 className="text-xl font-bold text-white flex items-center gap-3">
              {progress?.stage === "minted" ? (
                <svg className="h-5 w-5 text-emerald-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                </svg>
              ) : progress?.stage === "failed" ? (
                <svg className="h-5 w-5 text-red-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
                </svg>
              ) : progress?.stage === "recovery_required" ? (
                <svg className="h-5 w-5 text-amber-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
              ) : (
                <svg className="h-5 w-5 text-brand-500 animate-spin flex-shrink-0" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
              )}
              {progress?.message ?? "Connecting to the executor…"}
            </h2>
            <span className="px-3 py-1 bg-brand-950/30 border border-brand-500/20 text-brand-400 rounded-full text-xs font-bold uppercase tracking-widest font-mono shadow-[0_0_10px_rgba(232,93,53,0.05)]">
              {progress?.phase === "mint"
                ? "MINT"
                : progress?.phase === "complete"
                  ? "COMPLETE"
                  : "PROVE"}
            </span>
          </div>

          <p className="text-zinc-400 text-sm mb-6">
            {progress?.expectedTiming ?? "The executor will observe the validated XRPL payment."}
          </p>

          {progress && !progress.executorReachable && (
            <div role="alert" className="mb-6 flex items-start gap-3 bg-amber-950/20 border border-amber-900/50 text-amber-400 px-4 py-3 rounded-xl text-sm leading-relaxed">
              <svg className="h-5 w-5 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              <div>
                <strong className="font-semibold block mb-1">Executor status offline</strong>
                <span>The payment is safe on XRPL, but the executor status service is offline. Start the executor to continue proving and minting.</span>
              </div>
            </div>
          )}

          {progress?.stage === "attestation_requested" && (
            <div className="bg-brand-950/10 border-l-4 border-brand-500 p-4 rounded-r-xl my-6 text-sm text-brand-200/90 leading-relaxed">
              <strong className="block mb-1 text-white">Why this takes 90–180 seconds</strong>
              <p>
                FDC data providers confirm the XRPL payment, finalize the voting round, and publish a Merkle proof. Do not send another payment while this round is pending.
              </p>
            </div>
          )}

          <dl className="grid grid-cols-1 md:grid-cols-2 gap-4 bg-zinc-950/50 p-4 rounded-xl border border-zinc-900/80 mb-6 text-sm">
            <div className="space-y-1">
              <dt className="text-zinc-500 font-semibold text-xs uppercase tracking-wider">XRPL Payment Hash</dt>
              <dd className="break-all font-mono text-xs">
                <a
                  href={`https://testnet.xrpl.org/transactions/${transactionId}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-brand-400 hover:text-brand-300 font-semibold underline flex items-center gap-1"
                >
                  {transactionId}
                  <svg className="h-3 w-3 inline-block" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                  </svg>
                </a>
              </dd>
            </div>
            {progress?.votingRoundId && (
              <div className="space-y-1">
                <dt className="text-zinc-500 font-semibold text-xs uppercase tracking-wider">FDC Voting Round</dt>
                <dd className="text-zinc-200 font-semibold font-mono">{progress.votingRoundId}</dd>
              </div>
            )}
            {progress?.flareTransactionHash && (
              <div className="space-y-1 md:col-span-2">
                <dt className="text-zinc-500 font-semibold text-xs uppercase tracking-wider">Coston2 Settlement Hash</dt>
                <dd className="break-all font-mono text-xs">
                  <a
                    href={`https://coston2-explorer.flare.network/tx/${progress.flareTransactionHash}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-brand-400 hover:text-brand-300 font-semibold underline flex items-center gap-1"
                  >
                    {progress.flareTransactionHash}
                    <svg className="h-3 w-3 inline-block" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                    </svg>
                  </a>
                </dd>
              </div>
            )}
          </dl>

          <div className="flex justify-between items-center border-t border-zinc-800/80 pt-6">
            <a
              href={`/receipt/${transactionId}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 text-brand-400 hover:text-brand-300 font-semibold text-sm transition-all"
            >
              <span>Open Shareable Proof Receipt</span>
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
              </svg>
            </a>
          </div>

          {progress?.error && (
            <div role="alert" className="mt-4 flex items-start gap-3 bg-red-950/20 border border-red-900/50 text-red-400 px-4 py-3 rounded-xl text-sm font-medium">
              <svg className="h-5 w-5 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              <span className="min-w-0 break-words line-clamp-4">
                {humanizeExecutorError(progress.error)}
              </span>
            </div>
          )}

          {(progress?.stage === "failed" ||
            progress?.stage === "recovery_required") && (
            <button
              type="button"
              onClick={resetFlow}
              className="mt-4 bg-zinc-100 hover:bg-white text-zinc-950 font-bold px-6 py-2.5 rounded-xl transition-all text-xs uppercase tracking-wider"
            >
              Start a new mint
            </button>
          )}

          {progress?.stage === "minted" && progress.settlement && (
            <div className="bg-emerald-950/10 border border-emerald-500/20 p-6 rounded-2xl mt-6 space-y-4 shadow-xl">
              <h3 className="text-lg font-bold text-emerald-400 flex items-center gap-2">
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                Mint Complete
              </h3>
              <p className="text-zinc-200 text-sm">
                <strong className="text-emerald-400 font-extrabold text-base">
                  {dropsToXrp(progress.settlement.mintedAmountUBA)} FXRP
                </strong>{" "}
                has been successfully minted to {progress.settlement.recipient}.
              </p>
              {progress.fxrpBalance && (
                <div className="bg-zinc-950/40 p-4 rounded-xl border border-zinc-900 text-zinc-300 text-sm space-y-1">
                  <p>
                    Final onchain FXRP balance:{" "}
                    <strong className="text-white font-bold">{dropsToXrp(progress.fxrpBalance.balanceUBA)} FXRP</strong>
                  </p>
                  <p className="text-[10px] text-zinc-500 font-mono">
                    {progress.fxrpBalance.source} · {formatTimestamp(progress.fxrpBalance.timestamp)}
                  </p>
                </div>
              )}
              <button
                onClick={resetFlow}
                className="bg-emerald-600 hover:bg-emerald-500 text-white font-bold px-6 py-2.5 rounded-xl transition-all text-xs uppercase tracking-wider shadow"
              >
                Mint another payment
              </button>
            </div>
          )}
        </section>
      )}
    </section>
  );
}

