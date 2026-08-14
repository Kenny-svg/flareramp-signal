import { getAddress, type Address, type Hex } from "viem";
import type { Payment, TxResponse } from "xrpl";
import { Xumm } from "xumm";

const DIRECT_MINTING_PREFIX = "4642505266410018";
const DIRECT_MINTING_EX_PREFIX = "4642505266410021";
const ZERO_PADDING = "00000000";

export type XamanSigningStage =
  | "awaiting"
  | "submitting"
  | "signed"
  | "rejected"
  | "cancelled"
  | "expired"
  | "malformed";

export interface DirectMintPaymentTemplate {
  sourceAddress: string;
  coreVaultAddress: string;
  amountDrops: string;
  recipient: Address;
  executorAddress?: Address;
  memoData: Hex;
}

/** XRPL Payment to the Smart Accounts operator with a 32-byte CRT instruction memo. */
export interface InstructionPaymentTemplate {
  sourceAddress: string;
  destinationAddress: string;
  amountDrops: string;
  memoData: Hex;
  forbidDestinationTag?: boolean;
  customInstruction?: string;
}

export type XamanPaymentTemplate =
  | DirectMintPaymentTemplate
  | InstructionPaymentTemplate;

function isInstructionTemplate(
  template: XamanPaymentTemplate,
): template is InstructionPaymentTemplate {
  return "destinationAddress" in template;
}

function destinationOf(template: XamanPaymentTemplate): string {
  return isInstructionTemplate(template)
    ? template.destinationAddress
    : template.coreVaultAddress;
}

export interface XamanSigningRequest {
  payloadId: string;
  deepLink: string;
  qrCode: string;
  expiresAt?: string;
}

export interface XamanSigningStatus {
  stage: XamanSigningStage;
  payloadId: string;
  transactionId?: string;
  signer?: string;
  message: string;
}

interface PayloadResponse {
  meta: {
    exists: boolean;
    resolved: boolean;
    signed: boolean;
    cancelled: boolean;
    expired: boolean;
  };
  payload: {
    request_json: Record<string, unknown>;
    expires_at?: string;
  };
  response: {
    txid: string | null;
    account: string | null;
  };
}

interface XamanPayloadGateway {
  create(input: Record<string, unknown>): Promise<{
    uuid: string;
    next: { always: string };
    refs: { qr_png: string };
  } | null>;
  get(payloadId: string): Promise<PayloadResponse | null>;
  cancel(payloadId: string): Promise<{
    result: { cancelled: boolean; reason: string };
  } | null>;
}

export interface XamanDirectMintDependencies {
  payload: XamanPayloadGateway;
  validateSubmittedPayment(
    transactionId: string,
    expected: XamanPaymentTemplate,
  ): Promise<"validated" | "pending">;
}

export interface XamanDirectMintConfig {
  apiKey: string;
  apiSecret: string;
  xrplWssUrl?: string;
}

export function buildDirectMintingMemo(
  recipient: Address,
  executorAddress?: Address,
): Hex {
  const recipientBody = getAddress(recipient).slice(2).toLowerCase();
  if (executorAddress) {
    return `0x${DIRECT_MINTING_EX_PREFIX}${recipientBody}${getAddress(
      executorAddress,
    )
      .slice(2)
      .toLowerCase()}` as Hex;
  }
  return `0x${DIRECT_MINTING_PREFIX}${ZERO_PADDING}${recipientBody}` as Hex;
}

function paymentTemplateFromPayload(
  payload: PayloadResponse,
): XamanPaymentTemplate | null {
  const transaction = payload.payload.request_json;
  const memos = transaction.Memos;
  const firstMemo =
    Array.isArray(memos) &&
    memos[0] &&
    typeof memos[0] === "object" &&
    "Memo" in memos[0] &&
    memos[0].Memo &&
    typeof memos[0].Memo === "object"
      ? memos[0].Memo
      : null;
  const memoData =
    firstMemo &&
    "MemoData" in firstMemo &&
    typeof firstMemo.MemoData === "string"
      ? firstMemo.MemoData
      : null;
  if (
    transaction.TransactionType !== "Payment" ||
    typeof transaction.Account !== "string" ||
    typeof transaction.Destination !== "string" ||
    typeof transaction.Amount !== "string" ||
    !memoData ||
    !/^[0-9A-Fa-f]+$/.test(memoData)
  ) {
    return null;
  }
  const memo = `0x${memoData}` as Hex;
  const body = memo.slice(2).toLowerCase();
  try {
    if (
      body.length === 64 &&
      body.startsWith(DIRECT_MINTING_PREFIX) &&
      body.slice(16, 24) === ZERO_PADDING
    ) {
      return {
        sourceAddress: transaction.Account,
        coreVaultAddress: transaction.Destination,
        amountDrops: transaction.Amount,
        recipient: getAddress(`0x${body.slice(24)}`),
        memoData: memo,
      };
    }
    if (body.length === 96 && body.startsWith(DIRECT_MINTING_EX_PREFIX)) {
      return {
        sourceAddress: transaction.Account,
        coreVaultAddress: transaction.Destination,
        amountDrops: transaction.Amount,
        recipient: getAddress(`0x${body.slice(16, 56)}`),
        executorAddress: getAddress(`0x${body.slice(56)}`),
        memoData: memo,
      };
    }
    if (body.length === 84 && body.startsWith("fe")) {
      return {
        sourceAddress: transaction.Account,
        coreVaultAddress: transaction.Destination,
        amountDrops: transaction.Amount,
        // Smart Account mint routes by XRPL source; recipient is resolved off-memo.
        recipient: getAddress("0x0000000000000000000000000000000000000000"),
        memoData: memo,
      };
    }
    // 32-byte CRT / proof-based Smart Account instruction memo.
    if (body.length === 64) {
      return {
        sourceAddress: transaction.Account,
        destinationAddress: transaction.Destination,
        amountDrops: transaction.Amount,
        memoData: memo,
        forbidDestinationTag: true,
      };
    }
  } catch {
    return null;
  }
  return null;
}

export function verifySubmittedPayment(
  response: TxResponse<Payment>,
  expected: XamanPaymentTemplate,
): void {
  const transaction = response.result;
  const memo = transaction.Memos?.[0]?.Memo?.MemoData;
  const result =
    typeof transaction.meta === "object" && transaction.meta !== null
      ? transaction.meta.TransactionResult
      : undefined;
  if (!transaction.validated || result !== "tesSUCCESS") {
    // Caller should treat not-yet-validated txs as pending; definitive
    // ledger failures (tec*/tef*) surface once validated !== tesSUCCESS.
    if (!transaction.validated || result === undefined) {
      throw new PaymentValidationPendingError();
    }
    throw new Error(
      `XRPL payment failed on ledger (${result ?? "unknown result"})`,
    );
  }
  const expectedDestination = destinationOf(expected);
  if (
    transaction.TransactionType !== "Payment" ||
    transaction.Account !== expected.sourceAddress ||
    transaction.Destination !== expectedDestination ||
    transaction.Amount !== expected.amountDrops ||
    `0x${memo ?? ""}`.toLowerCase() !== expected.memoData.toLowerCase()
  ) {
    throw new Error("Signed XRPL payment differs from the approved template");
  }
  if (
    isInstructionTemplate(expected) &&
    expected.forbidDestinationTag !== false &&
    transaction.DestinationTag !== undefined
  ) {
    throw new Error(
      "Smart Account instruction payments must not include a destination tag",
    );
  }
}

export class PaymentValidationPendingError extends Error {
  constructor() {
    super("Signed payment is waiting for XRPL validation");
    this.name = "PaymentValidationPendingError";
  }
}

export function createXamanDirectMintService(
  dependencies: XamanDirectMintDependencies,
) {
  return {
    async create(
      template: XamanPaymentTemplate,
    ): Promise<XamanSigningRequest> {
      const instructionText = isInstructionTemplate(template)
        ? template.customInstruction ??
          `Smart Account instruction. Confirm ${template.amountDrops} drops to the operator and the 32-byte memo before signing.`
        : `Mint FXRP to ${template.recipient}. Confirm ${template.amountDrops} drops and the verified Core Vault before signing.`;
      const created = await dependencies.payload.create({
        txjson: {
          TransactionType: "Payment",
          Account: template.sourceAddress,
          Destination: destinationOf(template),
          Amount: template.amountDrops,
          Memos: [
            {
              Memo: {
                MemoData: template.memoData.slice(2).toUpperCase(),
              },
            },
          ],
          LastLedgerSequence: 120,
        },
        options: {
          submit: true,
          expire: 10,
          force_network: "TESTNET",
        },
        custom_meta: {
          identifier: `flareramp-${Date.now()}`,
          instruction: instructionText,
        },
      });
      if (!created) {
        throw new Error("Xaman could not create the signing request");
      }
      return {
        payloadId: created.uuid,
        deepLink: created.next.always,
        qrCode: created.refs.qr_png,
      };
    },

    async status(payloadId: string): Promise<XamanSigningStatus> {
      const payload = await dependencies.payload.get(payloadId);
      if (!payload?.meta.exists) {
        return {
          stage: "malformed",
          payloadId,
          message: "Xaman returned an unknown or malformed payload",
        };
      }
      if (payload.meta.cancelled) {
        return {
          stage: "cancelled",
          payloadId,
          message: "Signing request was cancelled",
        };
      }
      if (payload.meta.expired) {
        return {
          stage: "expired",
          payloadId,
          message: "Signing request expired",
        };
      }
      if (!payload.meta.resolved) {
        return {
          stage: "awaiting",
          payloadId,
          message: "Waiting for approval in Xaman",
        };
      }
      if (!payload.meta.signed) {
        return {
          stage: "rejected",
          payloadId,
          message: "Signing request was rejected",
        };
      }

      const template = paymentTemplateFromPayload(payload);
      const transactionId = payload.response.txid;
      const signer = payload.response.account;
      if (!template || !transactionId || !signer) {
        return {
          stage: "malformed",
          payloadId,
          message: "Signed Xaman response is missing required payment fields",
        };
      }
      if (signer !== template.sourceAddress) {
        return {
          stage: "malformed",
          payloadId,
          transactionId,
          signer,
          message: "Payment was signed by a different XRPL account",
        };
      }
      try {
        const validation = await dependencies.validateSubmittedPayment(
          transactionId,
          template,
        );
        if (validation === "pending") {
          return {
            stage: "submitting",
            payloadId,
            transactionId,
            signer,
            message: "Signed payment is waiting for XRPL validation",
          };
        }
      } catch (error) {
        if (error instanceof PaymentValidationPendingError) {
          return {
            stage: "submitting",
            payloadId,
            transactionId,
            signer,
            message: error.message,
          };
        }
        return {
          stage: "malformed",
          payloadId,
          transactionId,
          signer,
          message:
            error instanceof Error
              ? error.message
              : "Submitted payment failed validation",
        };
      }
      return {
        stage: "signed",
        payloadId,
        transactionId,
        signer,
        message: "Payment signed and validated on XRPL",
      };
    },

    async cancel(payloadId: string): Promise<XamanSigningStatus> {
      const result = await dependencies.payload.cancel(payloadId);
      if (!result?.result.cancelled) {
        return this.status(payloadId);
      }
      return {
        stage: "cancelled",
        payloadId,
        message: "Signing request was cancelled",
      };
    },
  };
}

export function createXamanDirectMintDependencies(
  config: XamanDirectMintConfig,
): XamanDirectMintDependencies {
  const xaman = new Xumm(config.apiKey, config.apiSecret);
  if (!xaman.payload) {
    throw new Error("Xaman payload API is unavailable");
  }
  return {
    payload: xaman.payload as unknown as XamanPayloadGateway,
    async validateSubmittedPayment(transactionId, expected) {
      const { Client } = await import("xrpl");
      const client = new Client(
        config.xrplWssUrl ??
          "wss://testnet.xrpl-labs.com",
        { connectionTimeout: 20_000 },
      );
      await client.connect();
      try {
        let response: TxResponse<Payment>;
        try {
          response = await client.request({
            command: "tx",
            transaction: transactionId,
          });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          if (
            message.includes("txnNotFound") ||
            message.includes("Transaction not found")
          ) {
            return "pending";
          }
          throw error;
        }
        verifySubmittedPayment(response, expected);
        return "validated";
      } catch (error) {
        if (error instanceof PaymentValidationPendingError) {
          return "pending";
        }
        throw error;
      } finally {
        await client.disconnect();
      }
    },
  };
}
