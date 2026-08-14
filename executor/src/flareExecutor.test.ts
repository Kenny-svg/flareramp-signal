import {
  iAssetManagerAbi,
} from "@flarenetwork/flare-wagmi-periphery-package/contracts/coston2";
import {
  encodeAbiParameters,
  encodeEventTopics,
  getAbiItem,
  keccak256,
  stringToHex,
  toHex,
  type Address,
  type Hex,
  type TransactionReceipt,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";
import {
  executeDirectMinting,
  publicExecutorErrorMessage,
  truncatePublicErrorMessage,
  type DirectMintingDependencies,
} from "./flareExecutor";
import type {
  ExpectedXrpPayment,
  XrpPaymentProof,
} from "./fdcProof";

const PRIVATE_KEY = `0x${"1".repeat(64)}` as Hex;
const EXECUTOR = privateKeyToAccount(PRIVATE_KEY).address;
const ASSET_MANAGER = "0x2222222222222222222222222222222222222222";
const RECIPIENT = "0x3333333333333333333333333333333333333333";
const TRANSACTION_ID = `0x${"ab".repeat(32)}` as Hex;
const FLARE_TRANSACTION_HASH = `0x${"cd".repeat(32)}` as Hex;
const BLOCK_HASH = `0x${"ef".repeat(32)}` as Hex;
const SOURCE = "rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY";
const CORE_VAULT = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const MEMO = "0x1234" as Hex;

function addressHash(value: string): Hex {
  return keccak256(toHex(value));
}

const expectedPayment: ExpectedXrpPayment = {
  transactionId: TRANSACTION_ID,
  proofOwner: EXECUTOR,
  sourceAddress: SOURCE,
  destinationAddress: CORE_VAULT,
  amountDrops: 1_000_000n,
  memoData: MEMO,
  destinationTag: null,
};

const proof: XrpPaymentProof = {
  merkleProof: [],
  data: {
    attestationType: stringToHex("XRPPayment", { size: 32 }),
    sourceId: stringToHex("testXRP", { size: 32 }),
    votingRound: 42n,
    lowestUsedTimestamp: 1_700_000_000n,
    requestBody: {
      transactionId: TRANSACTION_ID,
      proofOwner: EXECUTOR,
    },
    responseBody: {
      blockNumber: 10_000n,
      blockTimestamp: 1_700_000_000n,
      sourceAddress: SOURCE,
      sourceAddressHash: addressHash(SOURCE),
      receivingAddressHash: addressHash(CORE_VAULT),
      intendedReceivingAddressHash: addressHash(CORE_VAULT),
      spentAmount: 1_000_012n,
      intendedSpentAmount: 1_000_012n,
      receivedAmount: 1_000_000n,
      intendedReceivedAmount: 1_000_000n,
      hasMemoData: true,
      firstMemoData: MEMO,
      hasDestinationTag: false,
      destinationTag: 0n,
      status: 0,
    },
  },
};

function receipt(
  status: "success" | "reverted",
  logs: TransactionReceipt["logs"] = [],
): TransactionReceipt {
  return {
    blockHash: BLOCK_HASH,
    blockNumber: 123n,
    contractAddress: null,
    cumulativeGasUsed: 100_000n,
    effectiveGasPrice: 25n,
    from: EXECUTOR,
    gasUsed: 90_000n,
    logs,
    logsBloom: `0x${"0".repeat(512)}`,
    status,
    to: ASSET_MANAGER,
    transactionHash: FLARE_TRANSACTION_HASH,
    transactionIndex: 0,
    type: "eip1559",
  };
}

function executedLog(): TransactionReceipt["logs"][number] {
  const event = getAbiItem({
    abi: iAssetManagerAbi,
    name: "DirectMintingExecuted",
  });
  return {
    address: ASSET_MANAGER,
    blockHash: BLOCK_HASH,
    blockNumber: 123n,
    data: encodeAbiParameters(event.inputs, [
      TRANSACTION_ID,
      RECIPIENT,
      EXECUTOR,
      800_000n,
      100_000n,
      100_000n,
    ]),
    logIndex: 0,
    removed: false,
    topics: encodeEventTopics({
      abi: iAssetManagerAbi,
      eventName: "DirectMintingExecuted",
    }) as [Hex, ...Hex[]],
    transactionHash: FLARE_TRANSACTION_HASH,
    transactionIndex: 0,
  };
}

function dependencies(
  overrides: Partial<DirectMintingDependencies> = {},
): DirectMintingDependencies {
  return {
    resolveAssetManager: vi.fn().mockResolvedValue(ASSET_MANAGER),
    getCoreVaultAddress: vi.fn().mockResolvedValue(CORE_VAULT),
    simulate: vi.fn().mockResolvedValue(undefined),
    submit: vi.fn().mockResolvedValue(FLARE_TRANSACTION_HASH),
    waitForReceipt: vi
      .fn()
      .mockResolvedValue(receipt("success", [executedLog()])),
    ...overrides,
  };
}

const params = {
  proof,
  expectedPayment,
  executorPrivateKey: PRIVATE_KEY,
};

describe("executeDirectMinting", () => {
  it("does not sign when simulation fails", async () => {
    const deps = dependencies({
      simulate: vi.fn().mockRejectedValue(new Error("execution reverted")),
    });

    await expect(executeDirectMinting(params, deps)).rejects.toMatchObject({
      code: "SIMULATION_FAILED",
    });
    expect(deps.submit).not.toHaveBeenCalled();
  });

  it("reports a reverted execution receipt", async () => {
    const deps = dependencies({
      waitForReceipt: vi.fn().mockResolvedValue(receipt("reverted")),
    });

    await expect(executeDirectMinting(params, deps)).rejects.toMatchObject({
      code: "EXECUTION_REVERTED",
      details: {
        transactionHash: FLARE_TRANSACTION_HASH,
        blockNumber: 123n,
      },
    });
  });

  it("classifies an already-executed payment before signing", async () => {
    const deps = dependencies({
      simulate: vi.fn().mockRejectedValue({
        cause: { errorName: "PaymentAlreadyConfirmed" },
      }),
    });

    await expect(executeDirectMinting(params, deps)).rejects.toMatchObject({
      code: "ALREADY_EXECUTED",
    });
    expect(deps.submit).not.toHaveBeenCalled();
  });

  it("decodes DirectMintingExecuted into a typed settlement", async () => {
    const deps = dependencies();

    const settlement = await executeDirectMinting(params, deps);

    expect(settlement).toEqual({
      status: "executed",
      assetManager: ASSET_MANAGER,
      flareTransactionHash: FLARE_TRANSACTION_HASH,
      blockNumber: 123n,
      blockHash: BLOCK_HASH,
      xrplTransactionId: TRANSACTION_ID,
      recipient: RECIPIENT,
      executor: EXECUTOR,
      mintedAmountUBA: 800_000n,
      mintingFeeUBA: 100_000n,
      executorFeeUBA: 100_000n,
      gasUsed: 90_000n,
      effectiveGasPrice: 25n,
    });
    expect(deps.resolveAssetManager).toHaveBeenCalledOnce();
    expect(deps.simulate).toHaveBeenCalledBefore(
      deps.submit as ReturnType<typeof vi.fn>,
    );
  });
});

describe("truncatePublicErrorMessage", () => {
  it("keeps short messages intact", () => {
    expect(truncatePublicErrorMessage("SIMULATION_FAILED: boom")).toBe(
      "SIMULATION_FAILED: boom",
    );
  });

  it("maps Firelight NoWithdrawalAmount selector", () => {
    const mapped = truncatePublicErrorMessage(
      "executeInstruction reverted with the following signature: 0x95dece8d",
    );
    expect(mapped).toContain("NoWithdrawalAmount");
    expect(mapped).toContain("period");
  });

  it("maps insufficient funds to operator C2FLR guidance", () => {
    const mapped = truncatePublicErrorMessage(
      "insufficient funds for gas * price + value",
    );
    expect(mapped).toMatch(/C2FLR/i);
    expect(mapped).toMatch(/faucet|fund/i);
  });

  it("collapses whitespace and truncates long dumps", () => {
    const dump = `SIMULATION_FAILED: failed\n\n${"0xab".repeat(400)}`;
    const truncated = truncatePublicErrorMessage(dump);
    expect(truncated.length).toBeLessThanOrEqual(280);
    expect(truncated.endsWith("…")).toBe(true);
    expect(truncated.includes("\n")).toBe(false);
  });
});

describe("publicExecutorErrorMessage", () => {
  it("explains FdcHub submission failures clearly", () => {
    const message = publicExecutorErrorMessage({
      code: "SUBMISSION_FAILED",
      message: "Failed to submit XRPPayment request to FdcHub",
      cause: new Error("insufficient funds for gas * price + value"),
    });
    expect(message).toMatch(/C2FLR/i);
  });
});
