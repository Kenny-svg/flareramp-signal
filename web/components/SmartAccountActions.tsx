"use client";

import { useCallback, useEffect, useState } from "react";
import {
  actionLabel,
  type SmartAccountActionKind,
} from "@/lib/smartAccountActions";
import { humanizeExecutorError } from "@/lib/executorErrorMessage";

type SigningStage =
  | "awaiting"
  | "submitting"
  | "signed"
  | "rejected"
  | "cancelled"
  | "expired"
  | "malformed";

interface SmartAccountReview {
  checkedAt: string;
  action: SmartAccountActionKind;
  actionLabel: string;
  instructionId: number;
  path: string;
  transaction: {
    sourceAddress: string;
    destination: string;
    amountXrp: string;
    amountDrops: string;
    memoData: string;
    personalAccount: string;
  };
  instruction: {
    hex: string;
    lots?: string;
    amountFxrpWhole?: string;
    claimDate?: string;
    claimPeriod?: string;
    vaultId?: number;
    vaultAddress?: string;
  };
  balances: {
    personalAccountFxrp: string;
    lotSizeUBA: string;
  };
  fees: {
    instructionFeeDrops: string;
    feeSource: string;
  };
  checks: Array<{
    id: string;
    status: "pass" | "warn" | "fail";
    message: string;
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
  message: string;
}

interface ProgressStatus {
  stage: string;
  kind?: string;
  executorReachable?: boolean;
  votingRoundId?: string;
  flareTransactionHash?: string;
  message?: string;
  expectedTiming?: string;
  phase?: string;
  settlement?: {
    flareTransactionHash: string;
    personalAccount?: string;
    instructionId?: string;
  };
  error?: {
    code: string;
    message: string;
    retryable: boolean;
  };
  attestation?: { votingRoundId?: string };
  execution?: { transactionHash: string };
}

interface StoredSession {
  version: 1;
  review: SmartAccountReview;
  signing: SigningRequest;
  transactionId?: string;
}

const STORAGE_KEY = "flareramp.smartAccountActions.v1";

const ACTIONS: SmartAccountActionKind[] = [
  "redeem",
  "firelightWithdraw",
  "firelightClaim",
  "upshiftWithdraw",
  "upshiftClaim",
];

function messageFromResponse(value: unknown, fallback: string): string {
  return typeof value === "object" &&
    value !== null &&
    "error" in value &&
    typeof value.error === "string"
    ? value.error
    : fallback;
}

export function SmartAccountActions() {
  const [action, setAction] = useState<SmartAccountActionKind>("redeem");
  const [sourceAddress, setSourceAddress] = useState("");
  const [amountFxrp, setAmountFxrp] = useState("10");
  const [claimDate, setClaimDate] = useState("");
  const [claimPeriod, setClaimPeriod] = useState("");
  const [review, setReview] = useState<SmartAccountReview | null>(null);
  const [signing, setSigning] = useState<SigningRequest | null>(null);
  const [status, setStatus] = useState<SigningStatus | null>(null);
  const [transactionId, setTransactionId] = useState<string | null>(null);
  const [progress, setProgress] = useState<ProgressStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const terminalProgress =
    progress?.stage === "instruction_executed" ||
    progress?.stage === "failed" ||
    progress?.stage === "recovery_required";

  const readStatus = useCallback(async (payloadId: string) => {
    const response = await fetch(`/api/mint/sign/${payloadId}`, {
      cache: "no-store",
    });
    const data = (await response.json()) as SigningStatus | { error: string };
    if (!response.ok) {
      throw new Error(messageFromResponse(data, "Could not read Xaman status"));
    }
    const next = data as SigningStatus;
    setStatus(next);
    if (next.stage === "signed" && next.transactionId) {
      setTransactionId(next.transactionId);
    } else if (next.stage !== "awaiting" && next.stage !== "submitting") {
      localStorage.removeItem(STORAGE_KEY);
    }
    return next;
  }, []);

  useEffect(() => {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    try {
      const stored = JSON.parse(raw) as StoredSession;
      if (stored.version !== 1 || !stored.signing?.payloadId || !stored.review) {
        throw new Error("bad session");
      }
      setReview(stored.review);
      setSigning(stored.signing);
      setSourceAddress(stored.review.transaction.sourceAddress);
      setAction(stored.review.action);
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
    }
  }, [readStatus]);

  useEffect(() => {
    if (!review || !signing) return;
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
          version: 1,
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

  const readProgress = useCallback(async (id: string) => {
    const response = await fetch(`/api/sa/status/${id}`, { cache: "no-store" });
    const data = (await response.json()) as ProgressStatus & {
      error?: string;
      attestation?: { votingRoundId?: string };
      execution?: { transactionHash: string };
    };
    if (!response.ok && !data.stage) {
      throw new Error(
        typeof data.error === "string"
          ? data.error
          : "Could not read executor progress",
      );
    }
    setProgress({
      ...data,
      votingRoundId: data.attestation?.votingRoundId ?? data.votingRoundId,
      flareTransactionHash:
        data.execution?.transactionHash ??
        data.settlement?.flareTransactionHash ??
        data.flareTransactionHash,
      phase:
        data.stage === "instruction_executed"
          ? "complete"
          : data.stage === "failed" || data.stage === "recovery_required"
            ? "attention"
            : data.stage === "execution_submitted" ||
                data.stage === "proof_fetched"
              ? "settle"
              : "prove",
      message:
        data.stage === "instruction_executed"
          ? "Smart Account instruction executed on Coston2"
          : data.stage === "failed"
            ? "Executor stopped after a non-retryable failure"
            : data.stage === "attestation_requested"
              ? "Waiting for FDC Payment finalization"
              : "Proving the XRPL instruction payment",
    });
  }, []);

  useEffect(() => {
    if (!transactionId) return;
    if (terminalProgress) {
      localStorage.removeItem(STORAGE_KEY);
      return;
    }
    void readProgress(transactionId).catch((cause) => {
      setError(cause instanceof Error ? cause.message : String(cause));
    });
    const timer = window.setInterval(() => {
      void readProgress(transactionId).catch((cause) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      });
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [readProgress, terminalProgress, transactionId]);

  async function prepareReview() {
    setBusy(true);
    setError(null);
    setSigning(null);
    setStatus(null);
    setTransactionId(null);
    setProgress(null);
    localStorage.removeItem(STORAGE_KEY);
    try {
      const response = await fetch("/api/sa/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceAddress,
          action,
          amountFxrp:
            action === "upshiftClaim" || action === "firelightClaim"
              ? undefined
              : amountFxrp,
          claimDate: action === "upshiftClaim" ? claimDate : undefined,
          claimPeriod: action === "firelightClaim" ? claimPeriod : undefined,
        }),
      });
      const data = (await response.json()) as
        | SmartAccountReview
        | { error: string };
      if (!response.ok) {
        throw new Error(messageFromResponse(data, "Review failed"));
      }
      setReview(data as SmartAccountReview);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function openXaman() {
    if (!review) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/sa/sign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceAddress: review.transaction.sourceAddress,
          action: review.action,
          amountFxrp:
            review.action === "upshiftClaim" ||
            review.action === "firelightClaim"
              ? undefined
              : amountFxrp,
          claimDate:
            review.action === "upshiftClaim" ? claimDate : undefined,
          claimPeriod:
            review.action === "firelightClaim" ? claimPeriod : undefined,
          lots: review.instruction.lots,
        }),
      });
      const data = (await response.json()) as
        | { review: SmartAccountReview; signing: SigningRequest }
        | { error: string };
      if (!response.ok || !("signing" in data)) {
        throw new Error(messageFromResponse(data, "Could not open Xaman"));
      }
      setReview(data.review);
      setSigning(data.signing);
      setStatus({
        stage: "awaiting",
        payloadId: data.signing.payloadId,
        message: "Waiting for approval in Xaman",
      });
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
      void fetch(`/api/mint/sign/${activePayloadId}`, {
        method: "DELETE",
      }).catch(() => undefined);
    }
  }

  const hasFailure = review?.checks.some((check) => check.status === "fail");
  const signingActive =
    signing &&
    (status?.stage === "awaiting" || status?.stage === "submitting");
  const sessionActive = Boolean(review || signing || transactionId);

  return (
    <section className="max-w-4xl mx-auto px-4 pt-4 pb-12">
      <header className="mb-8">
        <h2 className="text-2xl font-black text-white mb-2">
          XRPL Smart Account actions
        </h2>
        <p className="text-zinc-400 text-sm leading-relaxed max-w-2xl">
          Redeem FXRP or exit Firelight / Upshift with a Xaman payment to the
          Smart Accounts operator. No MetaMask and no C2FLR — the executor
          proves the payment and calls{" "}
          <code className="text-zinc-300">executeInstruction</code>.
        </p>
      </header>

      {sessionActive && (
        <div className="mb-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 rounded-xl border border-zinc-800 bg-zinc-950/50 px-4 py-3">
          <p className="text-sm text-zinc-400">
            {terminalProgress
              ? "This instruction finished. Start over for another action."
              : "Session in progress — you can abandon it anytime."}
          </p>
          <button
            type="button"
            onClick={resetFlow}
            className="shrink-0 border border-zinc-700 hover:border-zinc-500 bg-zinc-900 text-zinc-200 font-semibold px-4 py-2 rounded-xl text-xs uppercase tracking-wider"
          >
            Start over
          </button>
        </div>
      )}

      <div className="bg-zinc-900/30 border border-zinc-800/80 p-6 rounded-2xl space-y-4">
        <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-400">
          Action
          <select
            value={action}
            disabled={Boolean(signingActive || transactionId)}
            onChange={(e) =>
              setAction(e.target.value as SmartAccountActionKind)
            }
            className="mt-2 block w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-3 text-sm"
          >
            {ACTIONS.map((entry) => (
              <option key={entry} value={entry}>
                {actionLabel(entry)}
              </option>
            ))}
          </select>
        </label>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-400 sm:col-span-2">
            XRPL source address
            <input
              value={sourceAddress}
              disabled={Boolean(signingActive || transactionId)}
              onChange={(e) => setSourceAddress(e.target.value)}
              placeholder="r..."
              className="mt-2 block w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-3 font-mono text-sm"
            />
          </label>
          {action === "upshiftClaim" ? (
            <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-400 sm:col-span-2">
              Claim date (YYYYMMDD)
              <input
                value={claimDate}
                disabled={Boolean(signingActive || transactionId)}
                onChange={(e) => setClaimDate(e.target.value)}
                placeholder="20251218"
                className="mt-2 block w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-3 font-mono text-sm"
              />
            </label>
          ) : action === "firelightClaim" ? (
            <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-400 sm:col-span-2">
              Firelight period id
              <input
                value={claimPeriod}
                disabled={Boolean(signingActive || transactionId)}
                onChange={(e) => setClaimPeriod(e.target.value)}
                placeholder="e.g. 42 — not FXRP amount"
                className="mt-2 block w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-3 font-mono text-sm"
              />
              <span className="mt-1 block normal-case tracking-normal font-normal text-zinc-500">
                Use the period from your Firelight withdraw request after that
                period ends. Check instruction scans recent claimable periods.
              </span>
            </label>
          ) : (
            <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-400 sm:col-span-2">
              {action === "redeem"
                ? "FXRP amount (exact lots)"
                : "FXRP amount (whole units)"}
              <input
                value={amountFxrp}
                disabled={Boolean(signingActive || transactionId)}
                onChange={(e) => setAmountFxrp(e.target.value)}
                className="mt-2 block w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-3 font-mono text-sm"
              />
            </label>
          )}
        </div>

        <button
          type="button"
          disabled={busy || Boolean(signingActive || transactionId)}
          onClick={() => void prepareReview()}
          className="bg-brand-600 hover:bg-brand-500 disabled:opacity-50 text-white font-bold px-4 py-3 rounded-xl text-xs uppercase tracking-wider"
        >
          {busy ? "Checking…" : "Check instruction"}
        </button>
      </div>

      {error && (
        <div
          role="alert"
          className="mt-4 bg-red-950/20 border border-red-900/50 text-red-400 px-4 py-3 rounded-xl text-sm break-words line-clamp-4"
        >
          {error}
        </div>
      )}

      {review && (
        <section className="mt-8 bg-zinc-900/30 border border-zinc-800/80 p-6 rounded-2xl space-y-4">
          <h3 className="text-lg font-bold text-white">
            {review.actionLabel} · live quote
          </h3>
          <dl className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
            <div>
              <dt className="text-zinc-500 text-xs uppercase">Operator</dt>
              <dd className="font-mono text-zinc-200 break-all">
                {review.transaction.destination}
              </dd>
            </div>
            <div>
              <dt className="text-zinc-500 text-xs uppercase">Fee</dt>
              <dd className="text-zinc-200">
                {review.transaction.amountXrp} XRP (
                {review.fees.feeSource} fee)
              </dd>
            </div>
            <div>
              <dt className="text-zinc-500 text-xs uppercase">Personal Account</dt>
              <dd className="font-mono text-zinc-200 break-all">
                {review.transaction.personalAccount}
              </dd>
            </div>
            <div>
              <dt className="text-zinc-500 text-xs uppercase">PA FXRP balance</dt>
              <dd className="text-zinc-200">
                {review.balances.personalAccountFxrp} FXRP
              </dd>
            </div>
            <div className="md:col-span-2">
              <dt className="text-zinc-500 text-xs uppercase">Memo</dt>
              <dd className="font-mono text-xs text-zinc-300 break-all">
                {review.transaction.memoData}
              </dd>
            </div>
          </dl>
          <ul className="space-y-2 text-sm">
            {review.checks.map((check) => (
              <li
                key={check.id}
                className={
                  check.status === "fail"
                    ? "text-red-400"
                    : check.status === "warn"
                      ? "text-amber-400"
                      : "text-emerald-400"
                }
              >
                {check.status.toUpperCase()}: {check.message}
              </li>
            ))}
          </ul>
          {!signing && (
            <button
              type="button"
              disabled={busy || hasFailure}
              onClick={() => void openXaman()}
              className="bg-gradient-to-r from-brand-500 to-brand-600 disabled:opacity-50 text-white font-bold px-4 py-3 rounded-xl text-xs uppercase tracking-wider"
            >
              Open verified payment in Xaman
            </button>
          )}
        </section>
      )}

      {signing && status && (
        <section className="mt-8 bg-zinc-900/30 border border-brand-500/20 p-6 rounded-2xl">
          <h3 className="text-lg font-bold text-white mb-2">
            Sign · Xaman <span className="text-brand-400">{status.stage}</span>
          </h3>
          <p className="text-zinc-400 text-sm mb-4">{status.message}</p>
          {signingActive && (
            <div className="flex flex-col md:flex-row gap-6 items-center">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={signing.qrCode}
                width={180}
                height={180}
                alt="Xaman QR"
                className="bg-white p-2 rounded-xl"
              />
              <a
                href={signing.deepLink}
                target="_blank"
                rel="noreferrer"
                className="bg-white text-zinc-950 font-bold px-4 py-2 rounded-xl text-xs uppercase"
              >
                Open Xaman link
              </a>
            </div>
          )}
          {status.transactionId && (
            <p className="mt-4 font-mono text-xs text-brand-400 break-all">
              {status.transactionId}
            </p>
          )}
        </section>
      )}

      {transactionId && (
        <section className="mt-8 bg-zinc-900/30 border border-zinc-800/80 p-6 rounded-2xl">
          <h3 className="text-lg font-bold text-white mb-2">
            {progress?.message ?? "Connecting to the executor…"}
          </h3>
          <p className="text-zinc-500 text-sm mb-4">
            Stage: {progress?.stage ?? "…"} ·{" "}
            <a
              href={`/receipt/${transactionId}`}
              target="_blank"
              rel="noreferrer"
              className="text-brand-400 underline"
            >
              Open proof receipt
            </a>
          </p>
          {progress?.error && (
            <div
              role="alert"
              className="mb-4 bg-red-950/20 border border-red-900/50 text-red-400 px-4 py-3 rounded-xl text-sm break-words line-clamp-4"
            >
              {humanizeExecutorError(progress.error)}
            </div>
          )}
          {progress?.stage === "instruction_executed" && (
            <button
              type="button"
              onClick={resetFlow}
              className="bg-emerald-600 hover:bg-emerald-500 text-white font-bold px-6 py-2.5 rounded-xl text-xs uppercase"
            >
              Run another action
            </button>
          )}
          {(progress?.stage === "failed" ||
            progress?.stage === "recovery_required") && (
            <button
              type="button"
              onClick={resetFlow}
              className="bg-zinc-100 text-zinc-950 font-bold px-6 py-2.5 rounded-xl text-xs uppercase"
            >
              Start a new instruction
            </button>
          )}
        </section>
      )}
    </section>
  );
}
