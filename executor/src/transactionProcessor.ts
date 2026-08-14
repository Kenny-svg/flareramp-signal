import type { Address, Hex } from "viem";
import {
  DirectMintingError,
  publicExecutorErrorMessage,
  type DirectMintingSettlement,
  type SubmittedDirectMinting,
} from "./flareExecutor";
import {
  FdcProofError,
  type ExpectedXrpPayment,
  type FdcProofLifecycle,
  type FdcProofResumeState,
  type XrpPaymentProof,
} from "./fdcProof";
import type { StructuredLogger } from "./logger";
import {
  type TransactionJob,
  type TransactionStage,
  type TransactionStore,
} from "./transactionStore";
import type { IncomingInstruction } from "./xrplWatcher";

const TERMINAL_STAGES = new Set<TransactionStage>([
  "minted",
  "instruction_executed",
  "failed",
  "recovery_required",
]);

export interface TransactionProcessorDependencies {
  requestProof(
    expected: ExpectedXrpPayment,
    lifecycle: FdcProofLifecycle,
    resume: FdcProofResumeState,
  ): Promise<XrpPaymentProof>;
  executeMinting(
    proof: XrpPaymentProof,
    expected: ExpectedXrpPayment,
    onSubmitted: (
      transactionHash: Hex,
      assetManager: Address,
    ) => void | Promise<void>,
    userOpData?: Hex,
  ): Promise<DirectMintingSettlement>;
  recoverMinting(
    submission: SubmittedDirectMinting,
    proof: XrpPaymentProof,
  ): Promise<DirectMintingSettlement>;
  /** Resolve off-chain 0xFE userOp bytes for a Core Vault payment memo. */
  resolveUserOp?(instruction: IncomingInstruction): Promise<Hex | undefined>;
  now(): number;
}

export interface TransactionProcessorOptions {
  proofOwner: Address;
  maxAttempts?: number;
  retryBaseDelayMs?: number;
  autoProcessObserved?: boolean;
}

function normalizeTransactionId(value: string): string {
  return value.replace(/^0x/i, "").toUpperCase();
}

function expectedPayment(
  job: TransactionJob,
  proofOwner: Address,
): ExpectedXrpPayment {
  return {
    transactionId: job.instruction.txHash,
    proofOwner,
    sourceAddress: job.instruction.sourceXrplAddress,
    destinationAddress: job.instruction.destinationXrplAddress,
    amountDrops: job.instruction.amountDrops,
    memoData: job.instruction.memoHex,
    destinationTag: job.instruction.destinationTag,
  };
}

function errorDetails(error: unknown): {
  code: string;
  message: string;
  retryable: boolean;
} {
  if (error instanceof DirectMintingError) {
    const permanent = new Set([
      "PAYMENT_MISMATCH",
      "ALREADY_EXECUTED",
      "CHECKPOINT_FAILED",
      "EXECUTION_REVERTED",
      "PAYMENT_TOO_SMALL",
      "UNEXPECTED_OUTCOME",
    ]);
    // Vault CallFailed / bad userOp will not heal on retry — stop quickly.
    const simulationPermanent = /CallFailed|hash mismatch|WrongExecutor/i.test(
      error.message,
    );
    return {
      code: error.code,
      message: publicExecutorErrorMessage({
        code: error.code,
        message: error.message,
        cause: error.cause,
      }),
      retryable:
        error.code === "SIMULATION_FAILED"
          ? !simulationPermanent
          : !permanent.has(error.code),
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

export class TransactionProcessor {
  private readonly active = new Set<string>();
  private readonly maxAttempts: number;
  private readonly retryBaseDelayMs: number;

  constructor(
    private readonly store: TransactionStore,
    private readonly dependencies: TransactionProcessorDependencies,
    private readonly logger: StructuredLogger,
    private readonly options: TransactionProcessorOptions,
  ) {
    this.maxAttempts = options.maxAttempts ?? 5;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 5_000;
  }

  async observe(instruction: IncomingInstruction): Promise<{
    job: TransactionJob;
    created: boolean;
  }> {
    const now = this.dependencies.now();
    const id = normalizeTransactionId(instruction.txHash);
    const userOpData = await this.dependencies.resolveUserOp?.(instruction);
    const result = await this.store.createIfAbsent({
      id,
      kind: "mint",
      stage: "observed",
      instruction,
      attempts: 0,
      nextAttemptAt: null,
      createdAt: now,
      updatedAt: now,
      stageHistory: [{ stage: "observed", at: now }],
      userOpData,
    });
    if (result.created === false && userOpData && !result.job.userOpData) {
      await this.store.update(id, (job) => ({ ...job, userOpData }));
    }
    this.logger.info(result.created ? "transaction_observed" : "duplicate_event", {
      transactionId: id,
      stage: result.job.stage,
      hasUserOp: Boolean(userOpData ?? result.job.userOpData),
    });
    if (
      this.options.autoProcessObserved !== false &&
      !TERMINAL_STAGES.has(result.job.stage)
    ) {
      void this.process(id).catch((error) => {
        this.logger.error("transaction_process_crashed", {
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
            (job.kind ?? "mint") === "mint" &&
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
      if ((job.kind ?? "mint") !== "mint") return;
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

      const expected = expectedPayment(job, this.options.proofOwner);
      let proof = job.proof;
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
                proof: fetchedProof,
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

      let settlement: DirectMintingSettlement;
      if (job.execution) {
        settlement = await this.dependencies.recoverMinting(
          job.execution,
          proof,
        );
      } else {
        settlement = await this.dependencies.executeMinting(
          proof,
          expected,
          async (transactionHash, assetManager) => {
            job = await this.checkpoint(id, {
              stage: "execution_submitted",
              proof,
              execution: { transactionHash, assetManager },
            });
          },
          job.userOpData,
        );
      }

      await this.checkpoint(id, {
        stage: "minted",
        proof,
        settlement,
        lastError: undefined,
        nextAttemptAt: null,
      });
      this.logger.info("transaction_minted", {
        transactionId: id,
        flareTransactionHash: settlement.flareTransactionHash,
        mintedAmountUBA: settlement.mintedAmountUBA.toString(),
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
        stageHistory,
        updatedAt: now,
      };
    });
    this.logger.info("transaction_stage_changed", {
      transactionId: id,
      stage: updated.stage,
    });
    return updated;
  }

  private async recordFailure(id: string, error: unknown): Promise<void> {
    const details = errorDetails(error);
    const job = await this.store.get(id);
    if (!job) return;
    const attempts = job.attempts + 1;
    const exhausted = attempts >= this.maxAttempts;
    let stage: TransactionStage = !details.retryable
      ? "recovery_required"
      : exhausted
        ? "failed"
        : job.stage;
    const delay = this.retryBaseDelayMs * 2 ** Math.max(0, attempts - 1);
    let nextAttemptAt =
      details.retryable && !exhausted
        ? this.dependencies.now() + delay
        : null;
    let execution = job.execution;

    if (
      error instanceof DirectMintingError &&
      error.code === "MINTING_DELAYED" &&
      !exhausted
    ) {
      stage = "proof_fetched";
      execution = undefined;
      const allowedAt = error.details?.executionAllowedAt;
      if (typeof allowedAt === "bigint") {
        nextAttemptAt = Math.max(nextAttemptAt ?? 0, Number(allowedAt) * 1_000);
      }
    }
    if (
      error instanceof DirectMintingError &&
      error.code === "CHECKPOINT_FAILED"
    ) {
      const transactionHash = error.details?.transactionHash;
      const assetManager = error.details?.assetManager;
      if (
        typeof transactionHash === "string" &&
        typeof assetManager === "string"
      ) {
        execution = {
          transactionHash: transactionHash as Hex,
          assetManager: assetManager as Address,
        };
        stage = "execution_submitted";
        nextAttemptAt = this.dependencies.now() + delay;
      }
    }

    await this.checkpoint(id, {
      stage,
      attempts,
      execution,
      nextAttemptAt,
      lastError: {
        ...details,
        occurredAt: this.dependencies.now(),
      },
    });
    this.logger.error("transaction_processing_failed", {
      transactionId: id,
      stage,
      attempt: attempts,
      error: details,
    });
  }
}
