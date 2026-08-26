import "dotenv/config";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const config = {
  openSeaApiKey: requiredEnv("OPENSEA_API_KEY"),
  privateKey: requiredEnv("PRIVATE_KEY") as `0x${string}`,

  /** Extra RPC endpoints raced alongside the chain's default RPC. */
  extraRpcUrls: (process.env.EXTRA_RPC_URLS ?? "")
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean),

  /** Percentage buffer applied to gas limit + fees (e.g. 20 => +20%). */
  gasBufferPercent: BigInt(process.env.GAS_BUFFER_PERCENT ?? "20"),

  /**
   * Fixed gas limit to use instead of calling estimateGas() right before
   * broadcast. Skipping that RPC round-trip is one of the biggest single
   * latency wins for a competitive FCFS mint. Set once by dry-running
   * with --confirm off and reading the printed gas estimate.
   */
  gasLimitOverride: process.env.GAS_LIMIT_OVERRIDE
    ? BigInt(process.env.GAS_LIMIT_OVERRIDE)
    : undefined,
} as const;
