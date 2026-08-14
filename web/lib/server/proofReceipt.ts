import "server-only";

import type { Payment, TxResponse } from "xrpl";
import {
  getPublicExecutorJob,
  type PublicExecutorJob,
} from "./mintStatus";
import { getWebServerConfig } from "./config";

const RIPPLE_EPOCH_OFFSET_SECONDS = 946_684_800;

function withTimeout<T>(
  operation: Promise<T>,
  milliseconds: number,
  label: string,
): Promise<T> {
  return Promise.race([
    operation,
    new Promise<never>((_resolve, reject) => {
      setTimeout(
        () => reject(new Error(`${label} timed out after ${milliseconds}ms`)),
        milliseconds,
      );
    }),
  ]);
}

export interface RecoveryDiagnosis {
  severity: "info" | "warn" | "error";
  title: string;
  evidence: string[];
  guidance: string[];
}

export interface ProofReceipt {
  version: 1;
  network: "XRPL Testnet / Coston2";
  generatedAt: string;
  status: string;
  elapsedSeconds: number;
  xrpl: {
    transactionHash: string;
    validated: boolean;
    ledgerIndex: number | null;
    confirmations: number | null;
    timestamp: string | null;
    explorerUrl: string;
  };
  fdc: {
    attestationRequestTransactionHash: string | null;
    attestationRequestExplorerUrl: string | null;
    votingRoundId: string | null;
    finalized: boolean;
    merkleProofStatus: "pending" | "available" | "rejected";
    sourceTimestamp: string | null;
  };
  flare: {
    transactionHash: string | null;
    blockNumber: string | null;
    explorerUrl: string | null;
    timestamp: string | null;
  };
  fxrp: {
    recipient: string | null;
    receivedUBA: string | null;
    mintingFeeUBA: string | null;
    executorFeeUBA: string | null;
  };
  timeline: Array<{
    stage: string;
    timestamp: string;
    source: string;
  }>;
  diagnosis: RecoveryDiagnosis;
  recoveryBoundary: string;
  sources: Array<{
    label: string;
    url: string;
    timestamp: string;
  }>;
}

interface XrplEvidence {
  validated: boolean;
  ledgerIndex: number | null;
  confirmations: number | null;
  timestamp: string | null;
}

async function readXrplEvidence(
  transactionId: string,
): Promise<XrplEvidence> {
  const { Client } = await import("xrpl");
  const client = new Client(getWebServerConfig().xrplWssUrl, {
    connectionTimeout: 20_000,
  });
  await withTimeout(client.connect(), 10_000, "XRPL connection");
  try {
    const [transaction, ledger] = await withTimeout(Promise.all([
      client.request({
        command: "tx",
        transaction: transactionId,
      }) as Promise<TxResponse<Payment>>,
      client.request({
        command: "ledger",
        ledger_index: "validated",
      }),
    ]), 10_000, "XRPL evidence request");
    const result = transaction.result;
    const transactionResult =
      typeof result.meta === "object" && result.meta !== null
        ? result.meta.TransactionResult
        : undefined;
    const validated =
      result.validated === true && transactionResult === "tesSUCCESS";
    const ledgerIndex =
      typeof result.ledger_index === "number" ? result.ledger_index : null;
    const currentLedger =
      typeof ledger.result.ledger_index === "number"
        ? ledger.result.ledger_index
        : null;
    const timestamp =
      typeof result.date === "number"
        ? new Date(
            (result.date + RIPPLE_EPOCH_OFFSET_SECONDS) * 1_000,
          ).toISOString()
        : null;
    return {
      validated,
      ledgerIndex,
      confirmations:
        ledgerIndex !== null && currentLedger !== null
          ? Math.max(0, currentLedger - ledgerIndex + 1)
          : null,
      timestamp,
    };
  } finally {
    await client.disconnect();
  }
}

function hasProof(job: PublicExecutorJob | null): boolean {
  return Boolean(
    job &&
      [
        "proof_fetched",
        "execution_submitted",
        "minted",
        "instruction_executed",
      ].includes(job.stage),
  );
}

function stageTimestamp(
  job: PublicExecutorJob | null,
  stage: string,
): string | null {
  return (
    job?.stageHistory.find((entry) => entry.stage === stage)?.at ?? null
  );
}

export function diagnoseReceipt(
  job: PublicExecutorJob | null,
  executorReachable: boolean,
  now: number,
): RecoveryDiagnosis {
  if (!executorReachable) {
    return {
      severity: "warn",
      title: "Executor status is unavailable",
      evidence: ["The operator executor status service did not respond."],
      guidance: [
        "Restart or reconnect the configured executor.",
        "Do not resend the XRPL payment; the existing transaction remains the source of truth.",
      ],
    };
  }
  if (!job) {
    return {
      severity: "warn",
      title: "Payment has not been observed by the executor",
      evidence: ["No durable transaction job exists for this XRPL hash yet."],
      guidance: [
        "Confirm the executor watches the current Core Vault XRPL address.",
        "Resume the watcher and ingest the existing validated payment; do not create a duplicate payment.",
      ],
    };
  }
  const ageSeconds = Math.max(
    0,
    Math.floor((now - Date.parse(job.updatedAt)) / 1_000),
  );
  if (
    job.stage === "attestation_requested" &&
    ageSeconds > 240
  ) {
    return {
      severity: "warn",
      title: "FDC attestation is taking longer than expected",
      evidence: [
        `The job has remained in attestation_requested for ${ageSeconds} seconds.`,
        `Voting round: ${job.attestation?.votingRoundId ?? "not checkpointed"}.`,
      ],
      guidance: [
        "Check Relay finalization for the recorded voting round and verify the FDC request transaction succeeded.",
        "If finalized, retry DA Layer proof retrieval with the same request and round.",
        "Do not resend the XRPL payment.",
      ],
    };
  }
  if (
    job.error?.code === "MALFORMED_PROOF" ||
    job.error?.code === "PAYMENT_MISMATCH"
  ) {
    return {
      severity: "error",
      title: "FDC proof was rejected",
      evidence: [
        `${job.error.code}: ${job.error.message}`,
        `Retryable: ${job.error.retryable ? "yes" : "no"}.`,
      ],
      guidance: [
        "Compare the validated XRPL destination, amount, memo, and transaction hash with the attestation response.",
        "Prepare a corrected proof for the same payment only if those fields match; otherwise stop for manual review.",
        "Do not use Smart Accounts skip-memo recovery for this plain direct mint.",
      ],
    };
  }
  if (
    job.error?.code === "MINTING_DELAYED" ||
    (job.stage === "proof_fetched" && job.nextAttemptAt)
  ) {
    return {
      severity: "info",
      title: "Direct mint is delayed by protocol limits",
      evidence: [
        job.nextAttemptAt
          ? `Next execution attempt is scheduled for ${job.nextAttemptAt}.`
          : "The AssetManager reported a delayed direct mint.",
      ],
      guidance: [
        "Wait until executionAllowedAt, then retry executeDirectMinting with the same verified proof.",
        "Do not resend the XRPL payment; delayed mints are queued, not rejected.",
      ],
    };
  }
  if (
    job.stage === "execution_submitted" &&
    ageSeconds > 60
  ) {
    return {
      severity: "warn",
      title: "Flare execution is submitted but not settled",
      evidence: [
        `The execution checkpoint is ${ageSeconds} seconds old.`,
        `Transaction: ${job.execution?.transactionHash ?? "not checkpointed"}.`,
      ],
      guidance: [
        "Inspect the Coston2 transaction receipt and recover from the checkpointed hash.",
        "Do not submit a second XRPL payment.",
      ],
    };
  }
  if (
    job.stage === "failed" ||
    job.stage === "recovery_required"
  ) {
    const instructionJob = job.kind === "instruction";
    return {
      severity: "error",
      title:
        job.stage === "failed"
          ? "Executor retries are exhausted"
          : instructionJob
            ? "Smart Account instruction requires manual recovery"
            : "Direct mint requires manual recovery",
      evidence: [
        job.error
          ? `${job.error.code}: ${
              job.error.message.length > 280
                ? `${job.error.message.slice(0, 279)}…`
                : job.error.message
            }`
          : "No structured executor error was checkpointed.",
      ],
      guidance: instructionJob
        ? [
            "Inspect the FDC Payment proof and MasterAccountController.executeInstruction checkpoint.",
            "Do not resend the XRPL payment; recover the same instruction payment if needed.",
          ]
        : [
            "Inspect the recorded FDC proof and Flare execution checkpoint before retrying the same payment.",
            "Use the normal executeDirectMinting path for this 48-byte direct-mint memo.",
            "Do not apply 0xE0; it is only defined for failed Smart Accounts custom-instruction mints.",
          ],
    };
  }
  return {
    severity: "info",
    title:
      job.stage === "minted"
        ? "Public evidence confirms the mint"
        : job.stage === "instruction_executed"
          ? "Public evidence confirms the Smart Account instruction"
          : job.kind === "instruction"
            ? "Smart Account instruction is progressing normally"
            : "Mint is progressing normally",
    evidence: [
      `Current durable stage: ${job.stage}.`,
      `Executor attempts: ${job.attempts}.`,
    ],
    guidance:
      job.stage === "minted" || job.stage === "instruction_executed"
        ? ["No recovery action is required."]
        : ["Keep this receipt open; the executor resumes from its latest checkpoint."],
  };
}

export async function buildProofReceipt(
  transactionId: string,
): Promise<ProofReceipt> {
  const normalized = transactionId.replace(/^0x/i, "").toUpperCase();
  if (!/^[0-9A-F]{64}$/.test(normalized)) {
    throw new Error("Malformed XRPL transaction identifier");
  }
  const generatedAt = new Date().toISOString();
  const [executor, xrplResult] = await Promise.all([
    getPublicExecutorJob(normalized),
    readXrplEvidence(normalized).catch(() => null),
  ]);
  const job = executor.job;
  const proofAvailable = hasProof(job);
  const proofRejected = Boolean(
    job?.error &&
      ["MALFORMED_PROOF", "PAYMENT_MISMATCH"].includes(job.error.code),
  );
  const startTimestamp =
    xrplResult?.timestamp ??
    job?.stageHistory[0]?.at ??
    generatedAt;
  const instructionJob = job?.kind === "instruction";
  const endTimestamp =
    stageTimestamp(job, "minted") ??
    stageTimestamp(job, "instruction_executed") ??
    generatedAt;
  const fdcTimestamp =
    stageTimestamp(job, "attestation_requested");
  const flareTimestamp =
    stageTimestamp(job, "minted") ??
    stageTimestamp(job, "instruction_executed") ??
    stageTimestamp(job, "execution_submitted");
  const xrplExplorerUrl =
    `https://testnet.xrpl.org/transactions/${normalized}`;
  const fdcHash =
    job?.attestation?.submissionTransactionHash ?? null;
  const flareHash =
    job?.settlement?.flareTransactionHash ??
    job?.execution?.transactionHash ??
    null;
  const sources: ProofReceipt["sources"] = [
    {
      label: "Validated XRPL transaction",
      url: xrplExplorerUrl,
      timestamp: xrplResult?.timestamp ?? generatedAt,
    },
  ];
  if (fdcHash) {
    sources.push({
      label: instructionJob
        ? "FDC Payment attestation request"
        : "FDC attestation request",
      url: `https://coston2-explorer.flare.network/tx/${fdcHash}`,
      timestamp: fdcTimestamp ?? job?.updatedAt ?? generatedAt,
    });
  }
  if (flareHash) {
    sources.push({
      label: instructionJob
        ? "Coston2 executeInstruction"
        : "Coston2 direct-mint execution",
      url: `https://coston2-explorer.flare.network/tx/${flareHash}`,
      timestamp: flareTimestamp ?? job?.updatedAt ?? generatedAt,
    });
  }

  return {
    version: 1,
    network: "XRPL Testnet / Coston2",
    generatedAt,
    status: job?.stage ?? "waiting_for_executor",
    elapsedSeconds: Math.max(
      0,
      Math.floor(
        (Date.parse(endTimestamp) - Date.parse(startTimestamp)) / 1_000,
      ),
    ),
    xrpl: {
      transactionHash: normalized,
      validated: xrplResult?.validated ?? false,
      ledgerIndex: xrplResult?.ledgerIndex ?? null,
      confirmations: xrplResult?.confirmations ?? null,
      timestamp: xrplResult?.timestamp ?? null,
      explorerUrl: xrplExplorerUrl,
    },
    fdc: {
      attestationRequestTransactionHash: fdcHash,
      attestationRequestExplorerUrl: fdcHash
        ? `https://coston2-explorer.flare.network/tx/${fdcHash}`
        : null,
      votingRoundId: job?.attestation?.votingRoundId ?? null,
      finalized: Boolean(job?.attestation?.finalized),
      merkleProofStatus: proofRejected
        ? "rejected"
        : proofAvailable
          ? "available"
          : "pending",
      sourceTimestamp: fdcTimestamp,
    },
    flare: {
      transactionHash: flareHash,
      blockNumber: job?.settlement?.blockNumber ?? null,
      explorerUrl: flareHash
        ? `https://coston2-explorer.flare.network/tx/${flareHash}`
        : null,
      timestamp: flareTimestamp,
    },
    fxrp: {
      recipient:
        job?.settlement?.recipient ??
        job?.settlement?.personalAccount ??
        null,
      receivedUBA: job?.settlement?.mintedAmountUBA ?? null,
      mintingFeeUBA: job?.settlement?.mintingFeeUBA ?? null,
      executorFeeUBA: job?.settlement?.executorFeeUBA ?? null,
    },
    timeline: (job?.stageHistory ?? []).map((entry) => ({
      stage: entry.stage,
      timestamp: entry.at,
      source: "FlareRamp durable executor checkpoint",
    })),
    diagnosis: diagnoseReceipt(job, executor.reachable, Date.now()),
    recoveryBoundary: instructionJob
      ? "This receipt is for a proof-based Smart Account instruction (operator XRPL payment → FDC Payment → executeInstruction). Do not confuse it with Core Vault mint recovery (0xE0)."
      : "0xE0 is not applicable to this plain 48-byte direct mint. It is only an official recovery instruction for failed Smart Accounts 0xFE/0xFF executeDirectMintingWithData flows.",
    sources,
  };
}
