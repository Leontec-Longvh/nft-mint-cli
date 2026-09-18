/**
 * src/tools/send-tokens.ts
 *
 * Sends native ETH (or the chain's native currency) or any ERC-20 to one or
 * more wallets, driven by a JSON config file. Reuses this project's real
 * infra — resolveChain() from chains.ts, config from config.ts, and the
 * warmed RPC pool + local signing from broadcast.ts — the SAME plumbing
 * cli.ts / mint-engine.ts already use. See send-shared.ts.
 *
 * The operator only ever edits send.config.json with a token SYMBOL
 * ("ETH", "USDT", ...) and plain amounts — no contract address, no
 * decimals. Decimals are read live from the token contract, symbols are
 * resolved via tokens.config.json (set up once by a dev).
 *
 * Usage:
 *   npx tsx src/tools/send-tokens.ts --config send.config.json
 *   npx tsx src/tools/send-tokens.ts --config send.config.json --dry-run
 *   npx tsx src/tools/send-tokens.ts --config send.config.json --chain-id 8453   (override)
 *
 * send.config.json (the only file an operator edits):
 * {
 *   "chainId": 4663,
 *   "token": "USDT",
 *   "recipients": [
 *     { "address": "0xabc...", "amount": "100" },
 *     { "address": "0xdef...", "amount": "42.5" }
 *   ]
 * }
 *
 * tokens.config.json (project root, set up once by a dev):
 * { "USDT": "0x...", "USDC": "0x..." }
 *
 * Uses the same PRIVATE_KEY / EXTRA_RPC_URLS / GAS_BUFFER_PERCENT from
 * .env that the mint tool already uses — nothing new to configure.
 */

import { readFileSync, existsSync } from "fs";
import { encodeFunctionData, decodeFunctionResult, parseUnits, parseEther, isAddress, type Hex, type Address } from "viem";

import {
  getSendContext,
  prepareNonceAndGasPrice,
  estimateGasWithFallback,
  ethCall,
  signAndSend,
  parsePositiveInt,
} from "./send-shared.js";

const ERC20_ABI = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    type: "function",
    name: "symbol",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
] as const;

const NATIVE_ALIASES = new Set(["ETH", "NATIVE"]);
const NATIVE_GAS_FALLBACK = 21_000n;
const ERC20_GAS_FALLBACK = 65_000n;

interface Recipient {
  address: string;
  amount: string;
}

interface SendConfig {
  chainId?: number;
  token: string;
  recipients: Recipient[];
}

type TokenRegistry = Record<string, string>;

function loadJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

function loadRegistry(path = "tokens.config.json"): TokenRegistry {
  if (!existsSync(path)) return {};
  const raw = loadJson<Record<string, string>>(path);
  const normalized: TokenRegistry = {};
  for (const [symbol, address] of Object.entries(raw)) normalized[symbol.toUpperCase()] = address;
  return normalized;
}

function loadConfig(path: string): SendConfig {
  const cfg = loadJson<SendConfig>(path);
  if (!cfg.token || typeof cfg.token !== "string") {
    throw new Error(`Config must include "token", e.g. "ETH" or "USDT" or a 0x address`);
  }
  if (!Array.isArray(cfg.recipients) || cfg.recipients.length === 0) {
    throw new Error(`Config must include a non-empty "recipients" array`);
  }
  for (const r of cfg.recipients) {
    if (!isAddress(r.address)) throw new Error(`Invalid recipient address: ${r.address}`);
    if (!r.amount || isNaN(Number(r.amount))) throw new Error(`Invalid amount for ${r.address}: ${r.amount}`);
  }
  if (cfg.chainId !== undefined && (!Number.isInteger(cfg.chainId) || cfg.chainId <= 0)) {
    throw new Error(`"chainId" in ${path} must be a positive integer`);
  }
  return cfg;
}

function resolveToken(tokenInput: string, registry: TokenRegistry): { isNative: true } | { isNative: false; address: Address } {
  const upper = tokenInput.toUpperCase();
  if (NATIVE_ALIASES.has(upper)) return { isNative: true };
  if (isAddress(tokenInput)) return { isNative: false, address: tokenInput as Address };

  const fromRegistry = registry[upper];
  if (fromRegistry) {
    if (!isAddress(fromRegistry)) {
      throw new Error(`tokens.config.json has an invalid address for "${upper}": ${fromRegistry}`);
    }
    return { isNative: false, address: fromRegistry as Address };
  }

  const known = Object.keys(registry).join(", ") || "(none configured)";
  throw new Error(
    `Unknown token "${tokenInput}". Use "ETH", one of the configured symbols (${known}), or a full contract address (0x...). Add new symbols to tokens.config.json.`
  );
}

function parseArgs() {
  const args = process.argv.slice(2);
  const configPath = args[args.indexOf("--config") + 1] ?? "send.config.json";
  const chainIdArgIndex = args.indexOf("--chain-id");
  const chainIdArg = chainIdArgIndex === -1 ? undefined : args[chainIdArgIndex + 1];
  const dryRun = args.includes("--dry-run");
  return { chainIdOverride: chainIdArg ? parsePositiveInt(chainIdArg, "chain-id") : undefined, configPath, dryRun };
}

async function main() {
  const { chainIdOverride, configPath, dryRun } = parseArgs();
  const sendConfig = loadConfig(configPath);
  const chainId = chainIdOverride ?? sendConfig.chainId;
  if (!chainId) {
    throw new Error(`Missing "chainId" in ${configPath} (or pass --chain-id to override).`);
  }
  const registry = loadRegistry();
  const resolved = resolveToken(sendConfig.token, registry);

  const ctx = getSendContext(chainId);
  console.log(`Chain: ${ctx.chain.name} (${chainId})`);
  console.log(`Sender: ${ctx.account.address}`);

  let decimals = 18;
  let displaySymbol = sendConfig.token.toUpperCase();

  if (!resolved.isNative) {
    try {
      const data = await ethCall(ctx.rpcUrls, resolved.address, encodeFunctionData({ abi: ERC20_ABI, functionName: "decimals" }));
      decimals = decodeFunctionResult({ abi: ERC20_ABI, functionName: "decimals", data });
    } catch {
      console.warn(`WARNING: could not read decimals() from ${resolved.address}. Falling back to 18 — verify this is really an ERC-20 contract.`);
    }
    try {
      const data = await ethCall(ctx.rpcUrls, resolved.address, encodeFunctionData({ abi: ERC20_ABI, functionName: "symbol" }));
      displaySymbol = decodeFunctionResult({ abi: ERC20_ABI, functionName: "symbol", data });
    } catch {
      /* symbol() optional */
    }
    console.log(`Token: ${displaySymbol} @ ${resolved.address} (decimals=${decimals})`);
  } else {
    console.log(`Token: native ${ctx.chain.nativeCurrency.symbol}`);
  }
  console.log(`Recipients: ${sendConfig.recipients.length}`);

  const { nonce: startNonce, gasPrice } = await prepareNonceAndGasPrice(ctx.account.address, ctx.rpcUrls);
  console.log(`Nonce start: ${startNonce}  GasPrice: ${gasPrice}`);

  let nonce = startNonce;
  const results: { address: string; amount: string; hash?: string; error?: string }[] = [];

  for (const recipient of sendConfig.recipients) {
    const to = recipient.address as Address;
    const value = resolved.isNative ? parseEther(recipient.amount) : 0n;
    const data: Hex = resolved.isNative
      ? "0x"
      : encodeFunctionData({
          abi: ERC20_ABI,
          functionName: "transfer",
          args: [to, parseUnits(recipient.amount, decimals)],
        });
    const callTo = resolved.isNative ? to : resolved.address;

    if (dryRun) {
      console.log(`[dry-run] would send ${recipient.amount} ${displaySymbol} -> ${to} (nonce=${nonce})`);
      results.push({ address: to, amount: recipient.amount });
      nonce++;
      continue;
    }

    try {
      const gas = await estimateGasWithFallback(
        ctx.rpcUrls,
        { from: ctx.account.address, to: callTo, data, value },
        resolved.isNative ? NATIVE_GAS_FALLBACK : ERC20_GAS_FALLBACK
      );
      const sent = await signAndSend(ctx, { to: callTo, data, value, nonce, gas, gasPrice });
      console.log(`sent ${recipient.amount} ${displaySymbol} -> ${to} | tx ${sent.hash} (via ${sent.rpcUrl})`);
      results.push({ address: to, amount: recipient.amount, hash: sent.hash });
      nonce++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`FAILED ${to}: ${message}`);
      results.push({ address: to, amount: recipient.amount, error: message });
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