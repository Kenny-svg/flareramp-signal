import type { Address, Hex } from "viem";
import {
  FdcProofError,
  type FdcProofResumeState,
  type SubmittedAttestation,
} from "./fdcProof";
import type {
  ExpectedInstructionPayment,
  PaymentProof,
} from "./fdcPaymentProof";
import {
  InstructionExecutorError,
  type InstructionSettlement,
} from "./instructionExecutor";
import { publicExecutorErrorMessage } from "./flareExecutor";
import type { StructuredLogger } from "./logger";
import {
  type TransactionJob,
  type TransactionStage,
  type TransactionStore,
} from "./transactionStore";
import type { IncomingInstruction } from "./xrplWatcher";

const TERMINAL_STAGES = new Set<TransactionStage>([
  "instruction_executed",
  "failed",
  "recovery_required",
]);

export interface InstructionProcessorDependencies {
  requestProof(
    expected: ExpectedInstructionPayment,
    lifecycle: {
      onPrepared?: (request: Hex) => void | Promise<void>;
      onAttestationRequested?: (
        submitted: SubmittedAttestation,
        request: Hex,
      ) => void | Promise<void>;
      onFinalized?: (votingRoundId: bigint) => void | Promise<void>;
      onProofFetched?: (proof: PaymentProof) => void | Promise<void>;
    },
    resume: FdcProofResumeState,
  ): Promise<PaymentProof>;
  executeInstruction(
    proof: PaymentProof,
    xrplAddress: string,
    transactionId: Hex,
    onSubmitted: (
      transactionHash: Hex,
      controller: Address,
    ) => void | Promise<void>,
  ): Promise<InstructionSettlement>;
  now(): number;
}

export interface InstructionProcessorOptions {
  maxAttempts?: number;
  retryBaseDelayMs?: number;
  autoProcessObserved?: boolean;
}

function normalizeTransactionId(value: string): string {
  return value.replace(/^0x/i, "").toUpperCase();
}

function expectedInstruction(
  job: TransactionJob,
): ExpectedInstructionPayment {
  if (!job.instruction.memoHex) {
    throw new FdcProofError(
      "INVALID_INPUT",
      "Instruction payment is missing the 32-byte memo",
    );
  }
  return {
    transactionId: job.instruction.txHash,
    sourceAddress: job.instruction.sourceXrplAddress,
    destinationAddress: job.instruction.destinationXrplAddress,
    amountDrops: job.instruction.amountDrops,
    memoData: job.instruction.memoHex,
  };
}

function errorDetails(error: unknown): {
  code: string;
  message: string;
  retryable: boolean;
} {
  if (error instanceof InstructionExecutorError) {
    const permanent = new Set([
      "ALREADY_EXECUTED",
      "EXECUTION_REVERTED",
      "UNEXPECTED_OUTCOME",
      "SIMULATION_FAILED",
    ]);
    return {
      code: error.code,
      message: publicExecutorErrorMessage({
        code: error.code,
        message: error.message,
        cause: error.cause,
      }),
      retryable: !permanent.has(error.code),
    };
  }
  if (error instanceof FdcProofError) {
    return {
      code: error.code,
      message: publicExecutorErrorMessage({
        code: error.code,
        message: error.message,
        cause: error.cause,
      }),
      retryable: ![
        "INVALID_INPUT",
        "MALFORMED_PROOF",
        "PAYMENT_MISMATCH",
      ].includes(error.code),
    };
  }
  return {
    code: "UNEXPECTED_ERROR",
    message: publicExecutorErrorMessage({
      code: "UNEXPECTED_ERROR",
      message: error instanceof Error ? error.message : "Unknown executor error",
      cause: error instanceof Error ? error.cause : undefined,
    }),
    retryable: true,
  };
}

export class InstructionProcessor {
  private readonly active = new Set<string>();
  private readonly maxAttempts: number;
  private readonly retryBaseDelayMs: number;

  constructor(
    private readonly store: TransactionStore,
    private readonly dependencies: InstructionProcessorDependencies,
    private readonly logger: StructuredLogger,
    private readonly options: InstructionProcessorOptions = {},
  ) {
    this.maxAttempts = options.maxAttempts ?? 5;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 5_000;
  }

  async observe(instruction: IncomingInstruction): Promise<{
    job: TransactionJob;
    created: boolean;
  } | null> {
    const memo = instruction.memoHex.toLowerCase();
    // CRT / proof-based instructions are exactly 32 bytes and are not FAssets
    // direct-mint FBPR / 0xFE memos.
    if (
      memo.length !== 66 ||
      memo.startsWith("0x46425052") ||
      memo.startsWith("0xfe") ||
      memo.startsWith("0xff") ||
      memo.startsWith("0xe0") ||
      memo.startsWith("0xe1") ||
      memo.startsWith("0xe2")
    ) {
      return null;
    }
    if (instruction.destinationTag !== null) {
      this.logger.error("instruction_rejected_destination_tag", {
        transactionId: instruction.txHash,
      });
      return null;
    }
    const now = this.dependencies.now();
    const id = normalizeTransactionId(instruction.txHash);
    const result = await this.store.createIfAbsent({
      id,
      kind: "instruction",
      stage: "observed",
      instruction,
      attempts: 0,
      nextAttemptAt: null,
      createdAt: now,
      updatedAt: now,
      stageHistory: [{ stage: "observed", at: now }],
    });
    this.logger.info(
      result.created ? "instruction_observed" : "duplicate_instruction_event",
      {
        transactionId: id,
        stage: result.job.stage,
        memo: instruction.memoHex,
      },
    );
    if (
      this.options.autoProcessObserved !== false &&
      !TERMINAL_STAGES.has(result.job.stage)
    ) {
      void this.process(id).catch((error) => {
        this.logger.error("instruction_process_crashed", {
          transactionId: id,
          error,
        });
      });
    }
    return result;
  }

  async resumePending(): Promise<void> {
    const now = this.dependencies.now();
    const jobs = await this.store.list();
    await Promise.all(
      jobs
        .filter(
          (job) =>
            (job.kind ?? "mint") === "instruction" &&
            !TERMINAL_STAGES.has(job.stage) &&
            (job.nextAttemptAt === null || job.nextAttemptAt <= now),
        )
        .map((job) => this.process(job.id)),
    );
  }

  async process(id: string): Promise<void> {
    if (this.active.has(id)) return;
    this.active.add(id);
    try {
      let job = await this.store.get(id);
      if (!job || TERMINAL_STAGES.has(job.stage)) return;
      if ((job.kind ?? "mint") !== "instruction") return;
      if (
        job.nextAttemptAt !== null &&
        job.nextAttemptAt > this.dependencies.now()
      ) {
        return;
      }
      job = await this.checkpoint(id, {
        stage: job.stage === "observed" ? "confirming" : job.stage,
        nextAttemptAt: null,
      });

      const expected = expectedInstruction(job);
      let proof = job.paymentProof;
      if (!proof) {
        proof = await this.dependencies.requestProof(
          expected,
          {
            onPrepared: async (request) => {
              job = await this.checkpoint(id, {
                stage: "confirming",
                attestation: { abiEncodedRequest: request },
              });
            },
            onAttestationRequested: async (submitted, request) => {
              job = await this.checkpoint(id, {
                stage: "attestation_requested",
                attestation: {
                  abiEncodedRequest: request,
                  submissionTransactionHash: submitted.transactionHash,
                  votingRoundId: submitted.votingRoundId,
                },
              });
            },
            onFinalized: async () => {
              const attestation = job?.attestation;
              job = await this.checkpoint(id, {
                stage: "finalized",
                attestation: attestation
                  ? { ...attestation, finalized: true }
                  : attestation,
              });
            },
            onProofFetched: async (fetchedProof) => {
              job = await this.checkpoint(id, {
                stage: "proof_fetched",
                paymentProof: fetchedProof,
              });
            },
          },
          {
            abiEncodedRequest: job.attestation?.abiEncodedRequest,
            submitted:
              job.attestation?.submissionTransactionHash &&
              job.attestation.votingRoundId !== undefined
                ? {
                    transactionHash:
                      job.attestation.submissionTransactionHash,
                    votingRoundId: job.attestation.votingRoundId,
                  }
                : undefined,
            finalized: job.attestation?.finalized,
          },
        );
      }

      const settlement = await this.dependencies.executeInstruction(
        proof,
        job.instruction.sourceXrplAddress,
        `0x${normalizeTransactionId(job.instruction.txHash)}` as Hex,
        async (transactionHash, controller) => {
          job = await this.checkpoint(id, {
            stage: "execution_submitted",
            paymentProof: proof,
            execution: {
              transactionHash,
              assetManager: controller,
            },
          });
        },
      );

      await this.checkpoint(id, {
        stage: "instruction_executed",
        paymentProof: proof,
        settlement,
        lastError: undefined,
        nextAttemptAt: null,
      });
      this.logger.info("instruction_executed", {
        transactionId: id,
        flareTransactionHash: settlement.flareTransactionHash,
        instructionId: settlement.instructionId.toString(),
      });
    } catch (error) {
      await this.recordFailure(id, error);
    } finally {
      this.active.delete(id);
    }
  }

  private async checkpoint(
    id: string,
    changes: Partial<TransactionJob>,
  ): Promise<TransactionJob> {
    const now = this.dependencies.now();
    const updated = await this.store.update(id, (job) => {
      const nextStage = changes.stage ?? job.stage;
      const stageHistory =
        nextStage !== job.stage
          ? [
              ...(job.stageHistory ?? [
                { stage: job.stage, at: job.createdAt },
              ]),
              { stage: nextStage, at: now },
            ]
          : job.stageHistory;
      return {
        ...job,
        ...changes,
        kind: "instruction",
        stageHistory,
        updatedAt: now,
      };
    });
    this.logger.info("transaction_stage_changed", {
      transactionId: id,
      stage: updated.stage,
      kind: "instruction",
    });
    return updated;
  }

  private async recordFailure(id: string, error: unknown): Promise<void> {
    const details = errorDetails(error);
    const job = await this.store.get(id);
    if (!job) return;
    const attempts = job.attempts + 1;
    const exhausted = attempts >= this.maxAttempts;
    const stage: TransactionStage = !details.retryable
      ? "recovery_required"
      : exhausted
        ? "failed"
        : job.stage;
    const delay = this.retryBaseDelayMs * 2 ** Math.max(0, attempts - 1);
    const nextAttemptAt =
      details.retryable && !exhausted
        ? this.dependencies.now() + delay
        : null;
    await this.checkpoint(id, {
      stage,
      attempts,
      nextAttemptAt,
      lastError: {
        code: details.code,
        message: details.message,
        retryable: details.retryable,
        occurredAt: this.dependencies.now(),
      },
    });
    this.logger.error("instruction_processing_failed", {
      transactionId: id,
      stage,
      attempt: attempts,
      error: details,
    });
  }
}
