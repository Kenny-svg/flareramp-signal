import { isHex, size, type Hex } from "viem";

export const DEFAULT_COSTON2_RPC_URL =
  "https://coston2-api.flare.network/ext/C/rpc";
export const DEFAULT_XRPL_WSS_URL = "wss://testnet.xrpl-labs.com";

export interface ExecutorConfig {
  coston2RpcUrl: string;
  executorPrivateKey: Hex;
  healthPort: number;
  maxJobAttempts: number;
  jobRetryBaseDelayMs: number;
  transactionStorePath: string;
  watchedXrplAddress: string;
  xrplWssUrl: string;
}

export interface FdcEnvironmentConfig {
  verifierUrl: string;
  verifierApiKey: string;
  daLayerUrl: string;
  daLayerApiKey?: string;
  prepareTimeoutMs: number;
  finalizationTimeoutMs: number;
  proofTimeoutMs: number;
}

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

const XRPL_CLASSIC_ADDRESS_PATTERN = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;

function requireValue(
  env: NodeJS.ProcessEnv,
  name: string,
): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new ConfigurationError(`${name} is required`);
  }
  return value;
}

export function parseFdcConfig(
  env: NodeJS.ProcessEnv = process.env,
): FdcEnvironmentConfig {
  const verifierApiKey = requireValue(env, "VERIFIER_API_KEY_TESTNET");
  const daLayerApiKey =
    env.COSTON2_DA_LAYER_API_KEY?.trim() || verifierApiKey;
  return {
    verifierUrl: parseUrl(
      env.VERIFIER_URL_TESTNET?.trim() ||
        "https://fdc-verifiers-testnet.flare.network",
      "VERIFIER_URL_TESTNET",
      ["http:", "https:"],
    ),
    verifierApiKey,
    daLayerUrl: parseUrl(
      requireValue(env, "COSTON2_DA_LAYER_URL"),
      "COSTON2_DA_LAYER_URL",
      ["http:", "https:"],
    ),
    ...(daLayerApiKey ? { daLayerApiKey } : {}),
    prepareTimeoutMs: parsePositiveInteger(
      env.FDC_PREPARE_TIMEOUT_MS,
      "FDC_PREPARE_TIMEOUT_MS",
      60_000,
    ),
    finalizationTimeoutMs: parsePositiveInteger(
      env.FDC_FINALIZATION_TIMEOUT_MS,
      "FDC_FINALIZATION_TIMEOUT_MS",
      300_000,
    ),
    proofTimeoutMs: parsePositiveInteger(
      env.FDC_PROOF_TIMEOUT_MS,
      "FDC_PROOF_TIMEOUT_MS",
      120_000,
    ),
  };
}

function parseUrl(value: string, name: string, protocols: readonly string[]): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ConfigurationError(`${name} must be a valid URL`);
  }

  if (!protocols.includes(parsed.protocol)) {
    throw new ConfigurationError(
      `${name} must use ${protocols.map((protocol) => protocol.replace(":", "")).join(" or ")}`,
    );
  }
  return value;
}

function parsePrivateKey(value: string): Hex {
  if (!isHex(value) || size(value) !== 32) {
    throw new ConfigurationError(
      "EXECUTOR_PRIVATE_KEY must be a 32-byte 0x-prefixed hexadecimal value",
    );
  }
  if (/^0x0{64}$/i.test(value)) {
    throw new ConfigurationError("EXECUTOR_PRIVATE_KEY must not be the zero key");
  }
  return value;
}

function parsePositiveInteger(
  value: string | undefined,
  name: string,
  fallback: number,
): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new ConfigurationError(`${name} must be a positive integer`);
  }
  return parsed;
}

export function parseExecutorConfig(
  env: NodeJS.ProcessEnv = process.env,
): ExecutorConfig {
  const executorPrivateKey = parsePrivateKey(
    requireValue(env, "EXECUTOR_PRIVATE_KEY"),
  );
  const watchedXrplAddress = requireValue(env, "WATCHED_XRPL_ADDRESS");
  if (!XRPL_CLASSIC_ADDRESS_PATTERN.test(watchedXrplAddress)) {
    throw new ConfigurationError(
      "WATCHED_XRPL_ADDRESS must be a valid XRPL classic address",
    );
  }

  return {
    coston2RpcUrl: parseUrl(
      env.COSTON2_RPC_URL?.trim() || DEFAULT_COSTON2_RPC_URL,
      "COSTON2_RPC_URL",
      ["http:", "https:"],
    ),
    executorPrivateKey,
    healthPort: parsePositiveInteger(env.HEALTH_PORT, "HEALTH_PORT", 3001),
    maxJobAttempts: parsePositiveInteger(
      env.MAX_JOB_ATTEMPTS,
      "MAX_JOB_ATTEMPTS",
      5,
    ),
    jobRetryBaseDelayMs: parsePositiveInteger(
      env.JOB_RETRY_BASE_DELAY_MS,
      "JOB_RETRY_BASE_DELAY_MS",
      5_000,
    ),
    transactionStorePath:
      env.TRANSACTION_STORE_PATH?.trim() || "./data/executor-jobs.json",
    watchedXrplAddress,
    xrplWssUrl: parseUrl(
      env.XRPL_WSS_URL?.trim() || DEFAULT_XRPL_WSS_URL,
      "XRPL_WSS_URL",
      ["ws:", "wss:"],
    ),
  };
}
