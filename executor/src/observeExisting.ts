import * as dotenv from "dotenv";
import { Client } from "xrpl";
import { parseExecutorConfig, parseFdcConfig } from "./config";
import {
  createFdcProofDependencies,
  requestPaymentProof,
} from "./fdcProof";
import {
  createDirectMintingDependencies,
  executeDirectMinting,
  getExecutorClients,
  recoverSubmittedDirectMinting,
} from "./flareExecutor";
import { createLogger } from "./logger";
import { JsonFileTransactionStore } from "./transactionStore";
import { TransactionProcessor } from "./transactionProcessor";

dotenv.config();

async function main() {
  const txHash = process.argv[2];
  if (!txHash || !/^[0-9A-Fa-f]{64}$/.test(txHash.replace(/^0x/i, ""))) {
    throw new Error("Usage: tsx src/observeExisting.ts <xrplTransactionHash>");
  }

  const config = parseExecutorConfig();
  const fdcConfig = parseFdcConfig();
  const { account } = getExecutorClients(
    config.executorPrivateKey,
    config.coston2RpcUrl,
  );
  const logger = createLogger();
  const store = new JsonFileTransactionStore(config.transactionStorePath);
  await store.initialize();

  const xrpl = new Client(config.xrplWssUrl, { connectionTimeout: 20_000 });
  await xrpl.connect();
  try {
    const response = await xrpl.request({
      command: "tx",
      transaction: txHash.replace(/^0x/i, "").toUpperCase(),
    });
    const tx = response.result as {
      hash?: string;
      Account?: string;
      Destination?: string;
      Amount?: string;
      DestinationTag?: number;
      Memos?: Array<{ Memo?: { MemoData?: string } }>;
      validated?: boolean;
      meta?: { TransactionResult?: string } | string;
    };
    const result =
      typeof tx.meta === "object" && tx.meta !== null
        ? tx.meta.TransactionResult
        : undefined;
    if (!tx.validated || result !== "tesSUCCESS") {
      throw new Error("XRPL payment is not validated with tesSUCCESS");
    }
    if (
      !tx.hash ||
      !tx.Account ||
      !tx.Destination ||
      typeof tx.Amount !== "string" ||
      !tx.Memos?.[0]?.Memo?.MemoData
    ) {
      throw new Error("XRPL payment is missing required Payment fields");
    }
    if (tx.Destination !== config.watchedXrplAddress) {
      throw new Error(
        `Payment destination ${tx.Destination} does not match WATCHED_XRPL_ADDRESS`,
      );
    }

    const processor = new TransactionProcessor(
      store,
      {
        requestProof: (expected, lifecycle, resume) =>
          requestPaymentProof(
            expected,
            {
              ...fdcConfig,
              coston2RpcUrl: config.coston2RpcUrl,
              executorPrivateKey: config.executorPrivateKey,
            },
            createFdcProofDependencies({
              ...fdcConfig,
              coston2RpcUrl: config.coston2RpcUrl,
              executorPrivateKey: config.executorPrivateKey,
            }),
            lifecycle,
            resume,
          ),
        executeMinting: (proof, expectedPayment, onSubmitted) =>
          executeDirectMinting(
            {
              proof,
              expectedPayment,
              executorPrivateKey: config.executorPrivateKey,
              coston2RpcUrl: config.coston2RpcUrl,
              onSubmitted,
            },
            createDirectMintingDependencies(
              config.executorPrivateKey,
              config.coston2RpcUrl,
            ),
          ),
        recoverMinting: (submission, proof) =>
          recoverSubmittedDirectMinting(
            submission,
            proof,
            config.executorPrivateKey,
            config.coston2RpcUrl,
            createDirectMintingDependencies(
              config.executorPrivateKey,
              config.coston2RpcUrl,
            ),
          ),
        now: () => Date.now(),
      },
      logger,
      {
        proofOwner: account.address,
        maxAttempts: config.maxJobAttempts,
        retryBaseDelayMs: config.jobRetryBaseDelayMs,
      },
    );

    const observed = await processor.observe({
      txHash: tx.hash,
      sourceXrplAddress: tx.Account,
      destinationXrplAddress: tx.Destination,
      amountDrops: BigInt(tx.Amount),
      memoHex: `0x${tx.Memos[0].Memo.MemoData}` as `0x${string}`,
      destinationTag:
        tx.DestinationTag === undefined ? null : BigInt(tx.DestinationTag),
    });
    console.log(
      JSON.stringify(
        {
          stage: "observed",
          created: observed.created,
          transactionId: observed.job.id,
          executor: account.address,
        },
        null,
        2,
      ),
    );
    await processor.process(observed.job.id);
    const finalJob = await store.get(observed.job.id);
    console.log(
      JSON.stringify(
        {
          stage: finalJob?.stage,
          settlement:
            finalJob?.settlement?.status === "executed"
              ? {
                  flareTransactionHash:
                    finalJob.settlement.flareTransactionHash,
                  mintedAmountUBA:
                    finalJob.settlement.mintedAmountUBA.toString(),
                }
              : finalJob?.settlement?.status === "instruction_executed"
                ? {
                    flareTransactionHash:
                      finalJob.settlement.flareTransactionHash,
                    instructionId:
                      finalJob.settlement.instructionId.toString(),
                  }
                : undefined,
          error: finalJob?.lastError,
        },
        null,
        2,
      ),
    );
  } finally {
    await xrpl.disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
