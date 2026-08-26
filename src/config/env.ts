import "dotenv/config";

function requiredEnv(
  name: string,
): string {
  const value =
    process.env[name];

  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}`,
    );
  }

  return value;
}

export const config = {
  openSeaApiKey:
    requiredEnv(
      "OPENSEA_API_KEY",
    ),
  privateKey:
    requiredEnv(
      "PRIVATE_KEY",
    ),
} as const;