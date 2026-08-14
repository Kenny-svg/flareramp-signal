import {
  iAssetManagerAbi,
} from "@flarenetwork/flare-wagmi-periphery-package/contracts/coston2";
import {
  getAddress,
  isAddressEqual,
  parseEventLogs,
  type Address,
  type Hex,
  type TransactionReceipt,
} from "viem";
import { DEFAULT_COSTON2_RPC_URL } from "./config";
import {
  validateXrpPaymentProof,
  type ExpectedXrpPayment,
  type XrpPaymentProof,
} from "./fdcProof";
import { getExecutorClients } from "./flareClients";
import { resolveContractAddress } from "./flareContracts";

export { getExecutorClients } from "./flareClients";

export interface DirectMintingParams {
  proof: XrpPaymentProof;
  expectedPayment: ExpectedXrpPayment;
  executorPrivateKey: Hex;
  coston2RpcUrl?: string;
  /** ABI-encoded PackedUserOperation for 0xFE custom instructions. */
  userOpData?: Hex;
  onSubmitted?: (
    transactionHash: Hex,
    assetManager: Address,
  ) => void | Promise<void>;
}

export interface SubmittedDirectMinting {
  transactionHash: Hex;
  assetManager: Address;
}

export interface DirectMintingSettlement {
  status: "executed";
  assetManager: Address;
  flareTransactionHash: Hex;
  blockNumber: bigint;
  blockHash: Hex;
  xrplTransactionId: Hex;
  recipient: Address;
  executor: Address;
  mintedAmountUBA: bigint;
  mintingFeeUBA: bigint;
  executorFeeUBA: bigint;
  gasUsed: bigint;
  effectiveGasPrice: bigint;
  vaultDeposit?: boolean;
}

export type DirectMintingErrorCode =
  | "PAYMENT_MISMATCH"
  | "SIMULATION_FAILED"
  | "ALREADY_EXECUTED"
  | "SUBMISSION_FAILED"
  | "CHECKPOINT_FAILED"
  | "EXECUTION_REVERTED"
  | "MINTING_DELAYED"
  | "PAYMENT_TOO_SMALL"
  | "UNEXPECTED_OUTCOME"
  | "MISSING_USER_OP";

export class DirectMintingError extends Error {
  constructor(
    public readonly code: DirectMintingErrorCode,
    message: string,
    public readonly cause?: unknown,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "DirectMintingError";
  }
}

export interface DirectMintingDependencies {
  resolveAssetManager: () => Promise<Address>;
  getCoreVaultAddress: (assetManager: Address) => Promise<string>;
  simulate: (
    assetManager: Address,
    proof: XrpPaymentProof,
    userOpData?: Hex,
  ) => Promise<void>;
  submit: (
    assetManager: Address,
    proof: XrpPaymentProof,
    userOpData?: Hex,
  ) => Promise<Hex>;
  waitForReceipt: (transactionHash: Hex) => Promise<TransactionReceipt>;
}

/** Cap public/UI-facing executor errors so viem dumps cannot blow up the status panel. */
export const MAX_PUBLIC_ERROR_MESSAGE_LENGTH = 280;

const KNOWN_REVERT_SELECTORS: Record<string, string> = {
  "0xa5fa8d2b": "CallFailed (Smart Account vault call reverted)",
  "0x95dece8d":
    "NoWithdrawalAmount (Firelight claim period has nothing to claim — use the vault period id from withdraw, after the period ends)",
};

export function truncatePublicErrorMessage(
  message: string,
  maxLength = MAX_PUBLIC_ERROR_MESSAGE_LENGTH,
): string {
  const cleaned = message.replace(/\s+/g, " ").trim();
  const known =
    summarizeOperationalFailure(cleaned) ??
    summarizeRevertSignature(cleaned);
  const text = known ?? cleaned;
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

/**
 * Turn executor error codes + nested viem causes into short operator/user copy.
 * Used when persisting job.lastError for the web UI.
 */
export function publicExecutorErrorMessage(params: {
  code: string;
  message: string;
  cause?: unknown;
}): string {
  const causeText = params.cause ? errorDescription(params.cause) : "";
  const combined = `${params.code} ${params.message} ${causeText}`;
  const operational = summarizeOperationalFailure(combined);
  if (operational) {
    return truncatePublicErrorMessage(operational);
  }
  const known =
    summarizeRevertSignature(causeText) ??
    summarizeRevertSignature(params.message);
  if (known) {
    return truncatePublicErrorMessage(known);
  }
  if (/FdcHub|XRPPayment request|Payment request to FdcHub/i.test(params.message)) {
    return truncatePublicErrorMessage(
      "Could not submit the FDC attestation on Coston2. The operator wallet may need more C2FLR for the FDC fee and gas — fund it and retry.",
    );
  }
  return truncatePublicErrorMessage(params.message);
}

function summarizeOperationalFailure(text: string): string | undefined {
  if (/insufficient funds|exceeds the balance|gas required exceeds/i.test(text)) {
    return "Operator Coston2 wallet needs more C2FLR (FDC attestation fee + gas). Fund the executor address on the Coston2 faucet, then retry.";
  }
  if (/nonce too low|replacement transaction underpriced/i.test(text)) {
    return "Coston2 transaction nonce conflict — the executor will retry shortly.";
  }
  if (/FdcHub transaction reverted/i.test(text)) {
    return "FDC Hub rejected the attestation request on Coston2. Check operator C2FLR balance and try again.";
  }
  return undefined;
}

function summarizeRevertSignature(text: string): string | undefined {
  const match = text.match(/0x[a-fA-F0-9]{8}/);
  if (!match) return undefined;
  const selector = match[0].toLowerCase();
  return KNOWN_REVERT_SELECTORS[selector];
}

export function errorDescription(error: unknown): string {
  const visited = new Set<unknown>();
  let current: unknown = error;
  let errorName: string | undefined;
  let shortMessage: string | undefined;
  let message: string | undefined;

  while (
    typeof current === "object" &&
    current !== null &&
    !visited.has(current)
  ) {
    visited.add(current);
    const value = current as Record<string, unknown>;
    if (!errorName && typeof value.errorName === "string") {
      errorName = value.errorName;
    }
    if (!shortMessage && typeof value.shortMessage === "string") {
      shortMessage = value.shortMessage;
    }
    if (!message && typeof value.message === "string") {
      message = value.message;
    }
    current = value.cause;
  }

  const raw = shortMessage || errorName || message || "unknown error";
  const operational = summarizeOperationalFailure(`${raw} ${message ?? ""}`);
  if (operational) {
    return truncatePublicErrorMessage(operational);
  }
  const known = summarizeRevertSignature(raw) ?? summarizeRevertSignature(message ?? "");
  if (known) {
    return truncatePublicErrorMessage(known);
  }
  // Drop viem "Contract Call:" / hex dumps; keep the first sentence-ish chunk.
  const withoutDump = raw.split(/Contract Call:|Raw Call Arguments:|Request body:/i)[0];
  return truncatePublicErrorMessage(withoutDump);
}

function isAlreadyExecutedError(error: unknown): boolean {
  return /PaymentAlreadyConfirmed/i.test(errorDescription(error));
}

export function createDirectMintingDependencies(
  privateKey: Hex,
  rpcUrl = DEFAULT_COSTON2_RPC_URL,
): DirectMintingDependencies {
  const { account, publicClient, walletClient } = getExecutorClients(
    privateKey,
    rpcUrl,
  );

  return {
    resolveAssetManager: () =>
      resolveContractAddress(publicClient, "AssetManagerFXRP"),

    getCoreVaultAddress: (assetManager) =>
      publicClient.readContract({
        address: assetManager,
        abi: iAssetManagerAbi,
        functionName: "directMintingPaymentAddress",
      }),

    async simulate(assetManager, proof, userOpData) {
      if (userOpData && userOpData !== "0x") {
        await publicClient.simulateContract({
          account,
          address: assetManager,
          abi: iAssetManagerAbi,
          functionName: "executeDirectMintingWithData",
          args: [proof, userOpData],
        });
        return;
      }
      await publicClient.simulateContract({
        account,
        address: assetManager,
        abi: iAssetManagerAbi,
        functionName: "executeDirectMinting",
        args: [proof],
      });
    },

    submit: (assetManager, proof, userOpData) => {
      if (userOpData && userOpData !== "0x") {
        return walletClient.writeContract({
          account,
          address: assetManager,
          abi: iAssetManagerAbi,
          functionName: "executeDirectMintingWithData",
          args: [proof, userOpData],
        });
      }
      return walletClient.writeContract({
        account,
        address: assetManager,
        abi: iAssetManagerAbi,
        functionName: "executeDirectMinting",
        args: [proof],
      });
    },

    waitForReceipt: (transactionHash) =>
      publicClient.waitForTransactionReceipt({ hash: transactionHash }),
  };
}

export function decodeDirectMintingSettlement(
  receipt: TransactionReceipt,
  transactionHash: Hex,
  assetManager: Address,
  expectedTransactionId: Hex,
): DirectMintingSettlement {
  const events = parseEventLogs({
    abi: iAssetManagerAbi,
    logs: receipt.logs,
    eventName: [
      "DirectMintingExecuted",
      "DirectMintingExecutedToSmartAccount",
      "DirectMintingDelayed",
      "LargeDirectMintingDelayed",
      "DirectMintingPaymentTooSmallForFee",
    ],
    strict: false,
  });

  for (const event of events) {
    if (!isAddressEqual(event.address, assetManager)) continue;

    if (event.eventName === "DirectMintingExecuted") {
      const {
        transactionId,
        targetAddress,
        executor,
        mintedAmountUBA,
        mintingFeeUBA,
        executorFeeUBA,
      } = event.args;
      if (
        typeof transactionId !== "string" ||
        typeof targetAddress !== "string" ||
        typeof executor !== "string" ||
        typeof mintedAmountUBA !== "bigint" ||
        typeof mintingFeeUBA !== "bigint" ||
        typeof executorFeeUBA !== "bigint"
      ) {
        throw new DirectMintingError(
          "UNEXPECTED_OUTCOME",
          "DirectMintingExecuted event is missing required fields",
        );
      }
      if (
        transactionId.toLowerCase() !== expectedTransactionId.toLowerCase()
      ) {
        throw new DirectMintingError(
          "UNEXPECTED_OUTCOME",
          "DirectMintingExecuted contains a different XRPL transaction id",
        );
      }
      return {
        status: "executed",
        assetManager,
        flareTransactionHash: transactionHash,
        blockNumber: receipt.blockNumber,
        blockHash: receipt.blockHash,
        xrplTransactionId: transactionId as Hex,
        recipient: getAddress(targetAddress),
        executor: getAddress(executor),
        mintedAmountUBA,
        mintingFeeUBA,
        executorFeeUBA,
        gasUsed: receipt.gasUsed,
        effectiveGasPrice: receipt.effectiveGasPrice,
      };
    }

    if (event.eventName === "DirectMintingExecutedToSmartAccount") {
      const {
        transactionId,
        executor,
        mintedAmountUBA,
        mintingFeeUBA,
      } = event.args;
      if (
        typeof transactionId !== "string" ||
        typeof executor !== "string" ||
        typeof mintedAmountUBA !== "bigint" ||
        typeof mintingFeeUBA !== "bigint"
      ) {
        throw new DirectMintingError(
          "UNEXPECTED_OUTCOME",
          "DirectMintingExecutedToSmartAccount is missing required fields",
        );
      }
      if (
        transactionId.toLowerCase() !== expectedTransactionId.toLowerCase()
      ) {
        throw new DirectMintingError(
          "UNEXPECTED_OUTCOME",
          "Smart Account mint event contains a different XRPL transaction id",
        );
      }
      return {
        status: "executed",
        assetManager,
        flareTransactionHash: transactionHash,
        blockNumber: receipt.blockNumber,
        blockHash: receipt.blockHash,
        xrplTransactionId: transactionId as Hex,
        recipient: getAddress(executor),
        executor: getAddress(executor),
        mintedAmountUBA,
        mintingFeeUBA,
        executorFeeUBA: 0n,
        gasUsed: receipt.gasUsed,
        effectiveGasPrice: receipt.effectiveGasPrice,
        vaultDeposit: true,
      };
    }

    if (
      event.eventName === "DirectMintingDelayed" ||
      event.eventName === "LargeDirectMintingDelayed"
    ) {
      throw new DirectMintingError(
        "MINTING_DELAYED",
        "Direct minting was accepted but delayed by protocol limits",
        undefined,
        {
          transactionId: event.args.transactionId,
          executionAllowedAt: event.args.executionAllowedAt,
          delayType: event.eventName,
        },
      );
    }

    if (event.eventName === "DirectMintingPaymentTooSmallForFee") {
      throw new DirectMintingError(
        "PAYMENT_TOO_SMALL",
        "XRPL payment was consumed by the minimum minting fee",
        undefined,
        {
          transactionId: event.args.transactionId,
          receivedAmountUBA: event.args.receivedAmountUBA,
          minimumMintingFeeUBA: event.args.minimumMintingFeeUBA,
        },
      );
    }
  }

  throw new DirectMintingError(
    "UNEXPECTED_OUTCOME",
    "Successful receipt did not contain a direct-mint settlement event",
  );
}

export async function executeDirectMinting(
  params: DirectMintingParams,
  dependencies: DirectMintingDependencies = createDirectMintingDependencies(
    params.executorPrivateKey,
    params.coston2RpcUrl,
  ),
): Promise<DirectMintingSettlement> {
  const { account } = getExecutorClients(
    params.executorPrivateKey,
    params.coston2RpcUrl,
  );
  if (!isAddressEqual(account.address, params.expectedPayment.proofOwner)) {
    throw new DirectMintingError(
      "PAYMENT_MISMATCH",
      "Configured executor does not match the FDC proof owner",
    );
  }

  try {
    validateXrpPaymentProof(
      params.proof,
      params.expectedPayment,
      params.proof.data.votingRound,
    );
  } catch (error) {
    throw new DirectMintingError(
      "PAYMENT_MISMATCH",
      "XRPPayment proof does not match the intended payment",
      error,
    );
  }

  const assetManager = await dependencies.resolveAssetManager();
  const coreVaultAddress =
    await dependencies.getCoreVaultAddress(assetManager);
  if (coreVaultAddress !== params.expectedPayment.destinationAddress) {
    throw new DirectMintingError(
      "PAYMENT_MISMATCH",
      "XRPL payment destination is not the current FXRP Core Vault",
    );
  }

  try {
    await dependencies.simulate(
      assetManager,
      params.proof,
      params.userOpData,
    );
  } catch (error) {
    if (isAlreadyExecutedError(error)) {
      throw new DirectMintingError(
        "ALREADY_EXECUTED",
        "XRPL payment has already been executed",
        error,
      );
    }
    const detail = errorDescription(error);
    throw new DirectMintingError(
      "SIMULATION_FAILED",
      params.userOpData
        ? `executeDirectMintingWithData simulation failed; no transaction was signed${detail ? `: ${detail}` : ""}`
        : `executeDirectMinting simulation failed; no transaction was signed${detail ? `: ${detail}` : ""}`,
      error,
    );
  }

  let transactionHash: Hex;
  try {
    transactionHash = await dependencies.submit(
      assetManager,
      params.proof,
      params.userOpData,
    );
  } catch (error) {
    throw new DirectMintingError(
      "SUBMISSION_FAILED",
      params.userOpData
        ? "Failed to submit executeDirectMintingWithData"
        : "Failed to submit executeDirectMinting",
      error,
    );
  }
  try {
    await params.onSubmitted?.(transactionHash, assetManager);
  } catch (error) {
    throw new DirectMintingError(
      "CHECKPOINT_FAILED",
      "Transaction was submitted but its durable checkpoint failed",
      error,
      { transactionHash, assetManager },
    );
  }

  const receipt = await dependencies.waitForReceipt(transactionHash);
  if (receipt.status !== "success") {
    throw new DirectMintingError(
      "EXECUTION_REVERTED",
      "executeDirectMinting transaction reverted",
      undefined,
      {
        transactionHash,
        blockNumber: receipt.blockNumber,
      },
    );
  }

  const settlement = decodeDirectMintingSettlement(
    receipt,
    transactionHash,
    assetManager,
    params.proof.data.requestBody.transactionId,
  );
  if (!isAddressEqual(settlement.executor, account.address)) {
    throw new DirectMintingError(
      "UNEXPECTED_OUTCOME",
      "Settlement event executor does not match the configured executor",
    );
  }
  return settlement;
}

export async function recoverSubmittedDirectMinting(
  submission: SubmittedDirectMinting,
  proof: XrpPaymentProof,
  executorPrivateKey: Hex,
  coston2RpcUrl?: string,
  dependencies: DirectMintingDependencies = createDirectMintingDependencies(
    executorPrivateKey,
    coston2RpcUrl,
  ),
): Promise<DirectMintingSettlement> {
  const { account } = getExecutorClients(executorPrivateKey, coston2RpcUrl);
  const receipt = await dependencies.waitForReceipt(submission.transactionHash);
  if (receipt.status !== "success") {
    throw new DirectMintingError(
      "EXECUTION_REVERTED",
      "Previously submitted executeDirectMinting transaction reverted",
      undefined,
      {
        transactionHash: submission.transactionHash,
        blockNumber: receipt.blockNumber,
      },
    );
  }
  const settlement = decodeDirectMintingSettlement(
    receipt,
    submission.transactionHash,
    submission.assetManager,
    proof.data.requestBody.transactionId,
  );
  if (!isAddressEqual(settlement.executor, account.address)) {
    throw new DirectMintingError(
      "UNEXPECTED_OUTCOME",
      "Recovered settlement executor does not match the configured executor",
    );
  }
  return settlement;
}
