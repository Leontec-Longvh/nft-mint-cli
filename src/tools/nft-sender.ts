/**
 * src/tools/nft-sender.ts
 *
 * Sends NFTs (ERC-721 or ERC-1155) already owned by the sender wallet to
 * one or more recipients, driven by a JSON config file. Reuses this
 * project's real infra via send-shared.ts — same chains.ts/config.ts/
 * broadcast.ts as cli.ts / mint-engine.ts. Does not mint.
 *
 * Usage:
 *   npx tsx src/tools/nft-sender.ts --config nft-send.config.json
 *   npx tsx src/tools/nft-sender.ts --config nft-send.config.json --dry-run
 *   npx tsx src/tools/nft-sender.ts --config nft-send.config.json --chain-id 8453   (override)
 *
 * nft-send.config.json:
 * {
 *   "chainId": 4663,
 *   "nftAddress": "0x...",
 *   "tokenType": "ERC721",
 *   "transfers": [
 *     { "to": "0xabc...", "tokenId": "1" },
 *     { "to": "0xdef...", "tokenId": "2" }
 *     // ERC1155 also supports: { "to": "0x...", "tokenId": "5", "amount": "3" }
 *   ]
 * }
 *
 * Uses the same PRIVATE_KEY / EXTRA_RPC_URLS / GAS_BUFFER_PERCENT from
 * .env the mint tool already uses.
 */

import { readFileSync } from "fs";
import { encodeFunctionData, isAddress, type Hex, type Address } from "viem";

import { getSendContext, prepareNonceAndGasPrice, estimateGasWithFallback, signAndSend, parsePositiveInt } from "./send-shared.js";

const ERC721_ABI = [
  {
    type: "function",
    name: "safeTransferFrom",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "tokenId", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

const ERC1155_ABI = [
  {
    type: "function",
    name: "safeTransferFrom",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "id", type: "uint256" },
      { name: "amount", type: "uint256" },
      { name: "data", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

const NFT_GAS_FALLBACK = 150_000n;

type TokenType = "ERC721" | "ERC1155";

interface Transfer {
  to: string;
  tokenId: string;
  amount?: string;
}

interface NftConfig {
  chainId?: number;
  nftAddress: string;
  tokenType: TokenType;
  transfers: Transfer[];
}

function loadConfig(path: string): NftConfig {
  const cfg = JSON.parse(readFileSync(path, "utf-8")) as NftConfig;
  if (!cfg.nftAddress || !isAddress(cfg.nftAddress)) throw new Error(`Invalid or missing nftAddress in ${path}`);
  if (cfg.tokenType !== "ERC721" && cfg.tokenType !== "ERC1155") throw new Error(`tokenType must be "ERC721" or "ERC1155"`);
  if (!Array.isArray(cfg.transfers) || cfg.transfers.length === 0) throw new Error(`Config must include a non-empty "transfers" array`);
  for (const t of cfg.transfers) {
    if (!isAddress(t.to)) throw new Error(`Invalid recipient address: ${t.to}`);
    if (t.tokenId === undefined || t.tokenId === null) throw new Error(`Missing tokenId for transfer to ${t.to}`);
  }
  if (cfg.chainId !== undefined && (!Number.isInteger(cfg.chainId) || cfg.chainId <= 0)) {
    throw new Error(`"chainId" in ${path} must be a positive integer`);
  }
  return cfg;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const configPath = args[args.indexOf("--config") + 1] ?? "nft-send.config.json";
  const chainIdArgIndex = args.indexOf("--chain-id");
  const chainIdArg = chainIdArgIndex === -1 ? undefined : args[chainIdArgIndex + 1];
  const dryRun = args.includes("--dry-run");
  return { chainIdOverride: chainIdArg ? parsePositiveInt(chainIdArg, "chain-id") : undefined, configPath, dryRun };
}

async function main() {
  const { chainIdOverride, configPath, dryRun } = parseArgs();
  const cfg = loadConfig(configPath);
  const chainId = chainIdOverride ?? cfg.chainId;
  if (!chainId) {
    throw new Error(`Missing "chainId" in ${configPath} (or pass --chain-id to override).`);
  }
  const nftAddress = cfg.nftAddress as Address;

  const ctx = getSendContext(chainId);
  console.log(`Chain: ${ctx.chain.name} (${chainId})`);
  console.log(`Sender: ${ctx.account.address}`);
  console.log(`NFT contract: ${nftAddress} (${cfg.tokenType})`);
  console.log(`Transfers: ${cfg.transfers.length}`);

  const { nonce: startNonce, gasPrice } = await prepareNonceAndGasPrice(ctx.account.address, ctx.rpcUrls);
  console.log(`Nonce start: ${startNonce}  GasPrice: ${gasPrice}`);

  let nonce = startNonce;
  const results: { to: string; tokenId: string; hash?: string; error?: string }[] = [];

  for (const t of cfg.transfers) {
    const to = t.to as Address;

    const data: Hex =
      cfg.tokenType === "ERC721"
        ? encodeFunctionData({
            abi: ERC721_ABI,
            functionName: "safeTransferFrom",
            args: [ctx.account.address, to, BigInt(t.tokenId)],
          })
        : encodeFunctionData({
            abi: ERC1155_ABI,
            functionName: "safeTransferFrom",
            args: [ctx.account.address, to, BigInt(t.tokenId), BigInt(t.amount ?? "1"), "0x"],
          });

    if (dryRun) {
      console.log(`[dry-run] would send tokenId ${t.tokenId} -> ${to} (nonce=${nonce})`);
      results.push({ to, tokenId: t.tokenId });
      nonce++;
      continue;
    }

    try {
      const gas = await estimateGasWithFallback(
        ctx.rpcUrls,
        { from: ctx.account.address, to: nftAddress, data, value: 0n },
        NFT_GAS_FALLBACK
      );
      const sent = await signAndSend(ctx, { to: nftAddress, data, value: 0n, nonce, gas, gasPrice });
      console.log(`sent tokenId ${t.tokenId} -> ${to} | tx ${sent.hash} (via ${sent.rpcUrl})`);
      results.push({ to, tokenId: t.tokenId, hash: sent.hash });
      nonce++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`FAILED tokenId ${t.tokenId} -> ${to}: ${message}`);
      results.push({ to, tokenId: t.tokenId, error: message });
      // nonce not incremented — tx never broadcast
    }
  }

  console.log("\nSummary:");
  console.table(results);

  const failed = results.filter((r) => r.error).length;
  if (failed > 0) {
    console.error(`${failed}/${results.length} transfers failed. See log above.`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("[ERROR]", err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});