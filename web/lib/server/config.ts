import "server-only";

export interface WebServerConfig {
  coston2RpcUrl: string;
  executorStatusUrl: string;
  verifierUrl: string;
  verifierApiKey: string;
  xamanApiKey: string;
  xamanApiSecret: string;
  xrplWssUrl: string;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required on the web server`);
  return value;
}

function url(name: string, fallback?: string): string {
  const value = process.env[name]?.trim() || fallback || required(name);
  const parsed = new URL(value);
  if (!["http:", "https:", "ws:", "wss:"].includes(parsed.protocol)) {
    throw new Error(`${name} has an unsupported protocol`);
  }
  return value;
}

let cached: WebServerConfig | undefined;

export function getWebServerConfig(): WebServerConfig {
  if (cached) return cached;
  cached = {
    coston2RpcUrl: url(
      "COSTON2_RPC_URL",
      "https://coston2-api.flare.network/ext/C/rpc",
    ),
    executorStatusUrl: url(
      "EXECUTOR_STATUS_URL",
      `http://127.0.0.1:${process.env.HEALTH_PORT ?? "3001"}`,
    ),
    verifierUrl: url(
      "VERIFIER_URL_TESTNET",
      "https://fdc-verifiers-testnet.flare.network",
    ),
    verifierApiKey: required("VERIFIER_API_KEY_TESTNET"),
    xamanApiKey: required("XAMAN_API_KEY"),
    xamanApiSecret: required("XAMAN_API_SECRET"),
    xrplWssUrl: url(
      "XRPL_WSS_URL",
      "wss://testnet.xrpl-labs.com",
    ),
  };
  return cached;
}
