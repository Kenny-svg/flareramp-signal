import { Client } from "xrpl";

export interface IncomingInstruction {
  txHash: string;
  sourceXrplAddress: string;
  destinationXrplAddress: string;
  amountDrops: bigint;
  memoHex: `0x${string}`;
  destinationTag: bigint | null;
}

/**
 * Watches an XRPL address for incoming Payment transactions carrying a
 * Smart Accounts instruction (or a Core Vault direct-minting payment) in the
 * memo field, and hands each one to `onInstruction`.
 *
 * Decoding of the memo itself is intentionally NOT duplicated here — see
 * web/lib/smartAccountInstructions.ts (`decodeInstructionHeader`) for the
 * single source of truth on the 32-byte instruction format. If this package
 * grows, pull that file into a shared workspace package instead of copying
 * the decode logic between web/ and executor/.
 */
export async function watchXrplAddress(
  wssUrl: string,
  address: string,
  onInstruction: (instruction: IncomingInstruction) => void | Promise<void>,
  onHandlerError: (error: unknown) => void = () => {},
): Promise<Client> {
  const client = new Client(wssUrl, { connectionTimeout: 20_000 });
  await client.connect();
  await client.request({ command: "subscribe", accounts: [address] });

  client.on("transaction", async (event) => {
    const tx = event.transaction;
    if (tx?.TransactionType !== "Payment") return;
    if (tx.Destination !== address) return;
    if (typeof tx.Amount !== "string" || !/^[0-9]+$/.test(tx.Amount)) return;

    const memo = tx.Memos?.[0]?.Memo?.MemoData;
    if (!memo) return;

    try {
      await onInstruction({
        txHash: tx.hash ?? "",
        sourceXrplAddress: tx.Account,
        destinationXrplAddress: tx.Destination,
        amountDrops: BigInt(tx.Amount),
        memoHex: `0x${memo}`,
        destinationTag:
          tx.DestinationTag === undefined ? null : BigInt(tx.DestinationTag),
      });
    } catch (error) {
      onHandlerError(error);
    }
  });

  return client;
}

export interface ReconnectingWatcherOptions {
  signal?: AbortSignal;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  onConnectionChange?: (connected: boolean) => void;
  onError?: (error: unknown) => void;
  sleep?: (milliseconds: number) => Promise<void>;
  connect?: typeof watchXrplAddress;
}

export async function runReconnectingXrplWatcher(
  wssUrl: string,
  address: string,
  onInstruction: (instruction: IncomingInstruction) => void | Promise<void>,
  options: ReconnectingWatcherOptions = {},
): Promise<void> {
  const signal = options.signal;
  const initialBackoffMs = options.initialBackoffMs ?? 1_000;
  const maxBackoffMs = options.maxBackoffMs ?? 30_000;
  const sleep =
    options.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const connect = options.connect ?? watchXrplAddress;
  let backoffMs = initialBackoffMs;

  while (!signal?.aborted) {
    let client: Client | undefined;
    let connectedAt: number | undefined;
    try {
      client = await connect(
        wssUrl,
        address,
        onInstruction,
        options.onError,
      );
      options.onConnectionChange?.(true);
      connectedAt = Date.now();
      await new Promise<void>((resolve) => {
        const disconnected = () => resolve();
        client?.once("disconnected", disconnected);
        signal?.addEventListener("abort", () => resolve(), { once: true });
      });
    } catch (error) {
      options.onError?.(error);
    } finally {
      options.onConnectionChange?.(false);
      if (client?.isConnected()) {
        try {
          await client.disconnect();
        } catch (error) {
          options.onError?.(error);
        }
      }
    }

    if (signal?.aborted) break;
    if (connectedAt !== undefined && Date.now() - connectedAt >= 60_000) {
      backoffMs = initialBackoffMs;
    }
    await sleep(backoffMs);
    backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
  }
}
