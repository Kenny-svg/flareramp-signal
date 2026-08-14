import * as dotenv from "dotenv";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  Client,
  isValidClassicAddress,
  type Payment,
  type TxResponse,
} from "xrpl";
import { Xumm } from "xumm";
import {
  getAddress,
  isAddressEqual,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import {
  iFdcHubAbi,
  iRelayAbi,
  iAssetManagerAbi,
  ifAssetAbi,
} from "@flarenetwork/flare-wagmi-periphery-package/contracts/coston2";
import { parseExecutorConfig, parseFdcConfig } from "./config";
import {
  createCoston2PublicClient,
  resolveContractAddress,
  resolveFxrpContracts,
} from "./flareContracts";
import { getExecutorClients } from "./flareClients";
import {
  createFdcProofDependencies,
  decodeXrpPaymentResponse,
  requestPaymentProof,
  validateXrpPaymentProof,
  type ExpectedXrpPayment,
  type FdcProofConfig,
  type XrpPaymentProof,
} from "./fdcProof";
import {
  createDirectMintingDependencies,
  decodeDirectMintingSettlement,
  executeDirectMinting,
  type DirectMintingSettlement,
} from "./flareExecutor";

dotenv.config();

const DIRECT_MINTING_PREFIX = "4642505266410018";
const ZERO_PADDING = "00000000";
const PENDING_FILE = resolve("data/coston2-integration.json");
const RECEIPT_FILE = resolve(
  "fixtures/proof-receipt.coston2.json",
);

interface PendingIntegration {
  version: 1;
  network: "XRPL Testnet / Coston2";
  sourceAddress: string;
  recipient: Address;
  amountDrops: string;
  memoData: Hex;
  xrplTransactionId: Hex;
  xrplLedgerIndex: number;
  coreVaultAddress: string;
  assetManager: Address;
  fAsset: Address;
  balanceBeforeUBA: string;
  xamanPayloadId: string;
  createdAt: string;
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function stringifyPublic(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, entry) =>
      typeof entry === "bigint" ? entry.toString() : entry,
    2,
  );
}

async function writePublicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${stringifyPublic(value)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

export function buildDirectMintingMemo(recipient: Address): Hex {
  return `0x${DIRECT_MINTING_PREFIX}${ZERO_PADDING}${recipient
    .slice(2)
    .toLowerCase()}` as Hex;
}

function normalizeTransactionId(value: string): Hex {
  const normalized = value.startsWith("0x") ? value : `0x${value}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(normalized)) {
    throw new Error("XRPL transaction id is malformed");
  }
  return normalized.toLowerCase() as Hex;
}

function verifySignedPayment(
  response: TxResponse<Payment>,
  expected: {
    sourceAddress: string;
    coreVaultAddress: string;
    amountDrops: string;
    memoData: Hex;
  },
): void {
  const transaction = response.result;
  const memo = transaction.Memos?.[0]?.Memo?.MemoData;
  const result =
    typeof transaction.meta === "object" &&
    transaction.meta !== null
      ? transaction.meta.TransactionResult
      : undefined;
  if (!transaction.validated || result !== "tesSUCCESS") {
    throw new Error("XRPL payment is not validated with tesSUCCESS");
  }
  if (
    transaction.TransactionType !== "Payment" ||
    transaction.Account !== expected.sourceAddress ||
    transaction.Destination !== expected.coreVaultAddress ||
    transaction.Amount !== expected.amountDrops ||
    `0x${memo ?? ""}`.toLowerCase() !== expected.memoData.toLowerCase()
  ) {
    throw new Error("Signed XRPL payment differs from the approved template");
  }
}

async function findExistingSettlement(
  client: PublicClient,
  assetManager: Address,
  transactionId: Hex,
): Promise<DirectMintingSettlement | null> {
  const latest = await client.getBlockNumber();
  for (let to = latest; to > latest - 3_000n; to -= 30n) {
    const events = await client.getContractEvents({
      address: assetManager,
      abi: iAssetManagerAbi,
      eventName: "DirectMintingExecuted",
      fromBlock: to - 29n,
      toBlock: to,
      strict: true,
    });
    const event = events.find(
      (candidate) =>
        candidate.args.transactionId.toLowerCase() ===
        transactionId.toLowerCase(),
    );
    if (event?.transactionHash) {
      const receipt = await client.getTransactionReceipt({
        hash: event.transactionHash,
      });
      return decodeDirectMintingSettlement(
        receipt,
        event.transactionHash,
        assetManager,
        transactionId,
      );
    }
  }
  return null;
}

async function recoverExistingProof(
  client: PublicClient,
  config: FdcProofConfig,
  expected: ExpectedXrpPayment,
): Promise<XrpPaymentProof | null> {
  const [fdcHub, relay] = await Promise.all([
    resolveContractAddress(client, "FdcHub"),
    resolveContractAddress(client, "Relay"),
  ]);
  const latest = await client.getBlockNumber();
  for (let to = latest; to > latest - 3_000n; to -= 30n) {
    const events = await client.getContractEvents({
      address: fdcHub,
      abi: iFdcHubAbi,
      eventName: "AttestationRequest",
      fromBlock: to - 29n,
      toBlock: to,
      strict: true,
    });
    for (const event of events) {
      const request = event.args.data;
      if (
        !request
          .toLowerCase()
          .includes(normalizeTransactionId(expected.transactionId).slice(2))
      ) {
        continue;
      }
      if (!event.transactionHash || event.blockNumber === null) continue;
      const transaction = await client.getTransaction({
        hash: event.transactionHash,
      });
      if (!isAddressEqual(transaction.from, expected.proofOwner)) continue;
      const block = await client.getBlock({
        blockNumber: event.blockNumber,
      });
      const votingRoundId = await client.readContract({
        address: relay,
        abi: iRelayAbi,
        functionName: "getVotingRoundId",
        args: [block.timestamp],
      });
      const dependencies = createFdcProofDependencies(config);
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const daProof = await dependencies.retrieveProof(
          request,
          votingRoundId,
          AbortSignal.timeout(15_000),
        );
        if (daProof) {
          const proof = {
            merkleProof: daProof.proof,
            data: decodeXrpPaymentResponse(daProof.responseHex),
          } as XrpPaymentProof;
          validateXrpPaymentProof(proof, expected, votingRoundId);
          return proof;
        }
        await new Promise((resolve) => setTimeout(resolve, 3_000));
      }
    }
  }
  return null;
}

async function prepare(): Promise<void> {
  const sourceAddress = requireEnv("INTEGRATION_XRPL_SOURCE_ADDRESS");
  if (!isValidClassicAddress(sourceAddress)) {
    throw new Error("INTEGRATION_XRPL_SOURCE_ADDRESS is invalid");
  }
  const recipient = getAddress(
    requireEnv("INTEGRATION_FXRP_RECIPIENT"),
  );
  const amountDrops = requireEnv("INTEGRATION_AMOUNT_DROPS");
  if (!/^[1-9][0-9]*$/.test(amountDrops)) {
    throw new Error("INTEGRATION_AMOUNT_DROPS must be a positive integer");
  }
  const apiKey = requireEnv("XAMAN_API_KEY");
  const apiSecret = requireEnv("XAMAN_API_SECRET");
  const memoData = buildDirectMintingMemo(recipient);

  const publicClient = createCoston2PublicClient();
  const { assetManager, fAsset } =
    await resolveFxrpContracts(publicClient);
  const [
    coreVaultAddress,
    minimumFeeUBA,
    executorFeeUBA,
    balanceBeforeUBA,
  ] = await Promise.all([
    publicClient.readContract({
      address: assetManager,
      abi: iAssetManagerAbi,
      functionName: "directMintingPaymentAddress",
    }),
    publicClient.readContract({
      address: assetManager,
      abi: iAssetManagerAbi,
      functionName: "getDirectMintingMinimumFeeUBA",
    }),
    publicClient.readContract({
      address: assetManager,
      abi: iAssetManagerAbi,
      functionName: "getDirectMintingExecutorFeeUBA",
    }),
    publicClient.readContract({
      address: fAsset,
      abi: ifAssetAbi,
      functionName: "balanceOf",
      args: [recipient],
    }),
  ]);
  if (BigInt(amountDrops) <= minimumFeeUBA + executorFeeUBA) {
    throw new Error(
      "Payment must exceed the current minimum and executor fees",
    );
  }

  const xrpl = new Client(
    process.env.XRPL_WSS_URL ??
      "wss://testnet.xrpl-labs.com",
    { connectionTimeout: 20_000 },
  );
  await xrpl.connect();
  try {
    const account = await xrpl.request({
      command: "account_info",
      account: sourceAddress,
      ledger_index: "validated",
    });
    if (BigInt(account.result.account_data.Balance) <= BigInt(amountDrops)) {
      throw new Error("XRPL Testnet account balance is insufficient");
    }
  } finally {
    await xrpl.disconnect();
  }

  const xaman = new Xumm(apiKey, apiSecret);
  const payloadApi = xaman.payload;
  if (!payloadApi) throw new Error("Xaman payload API is unavailable");
  const existingPayloadId = process.env.XAMAN_PAYLOAD_ID?.trim();
  const created = existingPayloadId
    ? {
        uuid: existingPayloadId,
        next: {
          always: `https://xumm.app/sign/${existingPayloadId}`,
        },
        refs: {
          qr_png: `https://xumm.app/sign/${existingPayloadId}_q.png`,
        },
      }
    : await payloadApi.create({
        txjson: {
          TransactionType: "Payment",
          Destination: coreVaultAddress,
          Amount: amountDrops,
          Memos: [{ Memo: { MemoData: memoData.slice(2) } }],
          LastLedgerSequence: 120,
        },
        options: {
          submit: true,
          expire: 10,
          force_network: "TESTNET",
        },
        custom_meta: {
          identifier: `flareramp-${Date.now()}`,
          instruction:
            `Mint FXRP to ${recipient}. Verify ${Number(amountDrops) / 1_000_000} TestXRP and the Core Vault destination before signing.`,
        },
      });
  if (!created) throw new Error("Xaman could not create the signing request");

  console.log(
    stringifyPublic({
      stage: "awaiting_user_signature",
      transaction: {
        network: "XRPL Testnet",
        sourceAddress,
        destination: coreVaultAddress,
        amountDrops,
        amountTestXrp: Number(amountDrops) / 1_000_000,
        memoData,
        recipient,
      },
      xaman: {
        payloadId: created.uuid,
        deepLink: created.next.always,
        qrCode: created.refs.qr_png,
      },
    }),
  );

  let payload = await payloadApi.get(created.uuid);
  while (payload && !payload.meta.resolved && !payload.meta.expired) {
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    payload = await payloadApi.get(created.uuid);
  }
  if (!payload?.meta.signed || !payload.response.txid) {
    throw new Error(
      payload?.meta.expired
        ? "Xaman signing request expired"
        : "User rejected the Xaman signing request",
    );
  }
  console.log(
    stringifyPublic({
      stage: "xaman_signature_received",
      signer: payload.response.account,
      transactionId: payload.response.txid,
    }),
  );
  if (payload.response.account !== sourceAddress) {
    throw new Error("Xaman payload was signed by a different XRPL account");
  }

  const txid = payload.response.txid;
  await xrpl.connect();
  let transaction: TxResponse<Payment>;
  try {
    transaction = await xrpl.request({
      command: "tx",
      transaction: txid,
    }) as TxResponse<Payment>;
  } finally {
    await xrpl.disconnect();
  }
  verifySignedPayment(transaction, {
    sourceAddress,
    coreVaultAddress,
    amountDrops,
    memoData,
  });

  const pending: PendingIntegration = {
    version: 1,
    network: "XRPL Testnet / Coston2",
    sourceAddress,
    recipient,
    amountDrops,
    memoData,
    xrplTransactionId: normalizeTransactionId(txid),
    xrplLedgerIndex: transaction.result.ledger_index ?? 0,
    coreVaultAddress,
    assetManager,
    fAsset,
    balanceBeforeUBA: balanceBeforeUBA.toString(),
    xamanPayloadId: created.uuid,
    createdAt: new Date().toISOString(),
  };
  await writePublicJson(PENDING_FILE, pending);
  console.log(
    stringifyPublic({
      stage: "xrpl_payment_validated",
      transactionId: txid,
      next:
        "Review the public transaction, then run integration:settle with CONFIRM_COSTON2_EXECUTION=YES.",
    }),
  );
}

async function settle(): Promise<void> {
  if (process.env.CONFIRM_COSTON2_EXECUTION !== "YES") {
    throw new Error(
      "CONFIRM_COSTON2_EXECUTION=YES is required after reviewing the XRPL payment",
    );
  }
  const pending = JSON.parse(
    await readFile(PENDING_FILE, "utf8"),
  ) as PendingIntegration;
  const executorConfig = parseExecutorConfig();
  const fdcEnvironment = parseFdcConfig();
  const { account } = getExecutorClients(
    executorConfig.executorPrivateKey,
    executorConfig.coston2RpcUrl,
  );
  const expectedPayment = {
    transactionId: pending.xrplTransactionId,
    proofOwner: account.address,
    sourceAddress: pending.sourceAddress,
    destinationAddress: pending.coreVaultAddress,
    amountDrops: BigInt(pending.amountDrops),
    memoData: pending.memoData,
    destinationTag: null,
  };
  const fdcConfig = {
    ...fdcEnvironment,
    coston2RpcUrl: executorConfig.coston2RpcUrl,
    executorPrivateKey: executorConfig.executorPrivateKey,
  };
  const publicClient = createCoston2PublicClient(
    executorConfig.coston2RpcUrl,
  );
  let settlement = await findExistingSettlement(
    publicClient,
    pending.assetManager,
    pending.xrplTransactionId,
  );
  const recoveredExistingSettlement = settlement !== null;
  const proof =
    (await recoverExistingProof(
      publicClient,
      fdcConfig,
      expectedPayment,
    )) ??
    (await requestPaymentProof(
      expectedPayment,
      fdcConfig,
      createFdcProofDependencies(fdcConfig),
    ));

  if (!settlement) {
    console.log(
      stringifyPublic({
        stage: "simulation_ready",
        function: "AssetManagerFXRP.executeDirectMinting",
        assetManager: pending.assetManager,
        xrplTransactionId: pending.xrplTransactionId,
        proofOwner: account.address,
        nativeValue: "0",
      }),
    );
    settlement = await executeDirectMinting(
      {
        proof,
        expectedPayment,
        executorPrivateKey: executorConfig.executorPrivateKey,
        coston2RpcUrl: executorConfig.coston2RpcUrl,
      },
      createDirectMintingDependencies(
        executorConfig.executorPrivateKey,
        executorConfig.coston2RpcUrl,
      ),
    );
  } else {
    console.log(
      stringifyPublic({
        stage: "existing_settlement_recovered",
        flareTransactionHash: settlement.flareTransactionHash,
      }),
    );
  }

  const balanceAfterUBA = await publicClient.readContract({
    address: pending.fAsset,
    abi: ifAssetAbi,
    functionName: "balanceOf",
    args: [pending.recipient],
  });
  let balanceBeforeUBA = BigInt(pending.balanceBeforeUBA);
  let balanceDeltaUBA = balanceAfterUBA - balanceBeforeUBA;
  if (
    recoveredExistingSettlement &&
    balanceDeltaUBA !== settlement.mintedAmountUBA &&
    balanceAfterUBA >= settlement.mintedAmountUBA
  ) {
    balanceBeforeUBA = balanceAfterUBA - settlement.mintedAmountUBA;
    balanceDeltaUBA = settlement.mintedAmountUBA;
  }
  if (balanceDeltaUBA !== settlement.mintedAmountUBA) {
    throw new Error(
      "FXRP balance delta does not match DirectMintingExecuted",
    );
  }

  const fixture = {
    version: 1,
    network: pending.network,
    contracts: {
      assetManager: pending.assetManager,
      fAsset: pending.fAsset,
      coreVaultAddress: pending.coreVaultAddress,
    },
    xrpl: {
      transactionId: pending.xrplTransactionId,
      ledgerIndex: pending.xrplLedgerIndex,
      sourceAddress: pending.sourceAddress,
      amountDrops: pending.amountDrops,
      memoData: pending.memoData,
    },
    fdc: {
      votingRound: proof.data.votingRound,
      proofOwner: proof.data.requestBody.proofOwner,
      merkleProof: proof.merkleProof,
      response: proof.data,
    },
    settlement,
    fxrp: {
      recipient: pending.recipient,
      balanceBeforeUBA,
      balanceAfterUBA,
      balanceDeltaUBA,
    },
    completedAt: new Date().toISOString(),
  };
  await writePublicJson(RECEIPT_FILE, fixture);
  console.log(
    stringifyPublic({
      stage: "complete",
      xrplTransactionId: pending.xrplTransactionId,
      flareTransactionHash: settlement.flareTransactionHash,
      mintedAmountUBA: settlement.mintedAmountUBA,
      proofReceipt: RECEIPT_FILE,
    }),
  );
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "prepare") return prepare();
  if (command === "settle") return settle();
  throw new Error("Usage: coston2Integration.ts prepare|settle");
}

main().catch((error) => {
  console.error(
    stringifyPublic({
      stage: "failed",
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exitCode = 1;
});
