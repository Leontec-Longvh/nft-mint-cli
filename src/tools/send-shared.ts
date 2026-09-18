/**
 * src/tools/send-shared.ts
 *
 * Shared plumbing for send-tokens.ts and nft-sender.ts. Deliberately reuses
 * the SAME building blocks as cli.ts / mint-engine.ts instead of creating a
 * parallel client setup:
 *
 *   - config.ts      -> dotenv-loaded PRIVATE_KEY / EXTRA_RPC_URLS / gas buffer
 *   - chains.ts       -> resolveChain(chainId) for {chain, rpcUrls}
 *   - broadcast.ts    -> warmed keep-alive RPC pool (rpcCallRace, broadcastRace)
 *
 * Signing uses account.signTransaction() directly (local, zero RPC) — same
 * reasoning as mint-engine.ts's signAndBroadcast: viem's walletClient makes
 * a hidden eth_chainId call on every signature.
 *
 * This file does not touch cli.ts / mint-engine.ts / broadcast.ts / opensea.ts.
 */

import { privateKeyToAccount } from "viem/accounts";
import type { Account, Address, Chain, Hex } from "viem";

import { config } from "../config.js";
import { resolveChain } from "../chains.js";
import { rpcCallRace, broadcastRace, warmUp } from "../broadcast.js";

export interface SendContext {
  account: Account;
  chain: Chain;
  rpcUrls: string[];
}

/** Same --chain-id resolution as cli.ts: chains.ts + EXTRA_RPC_URLS from .env. */
export function getSendContext(chainId: number): SendContext {
  const { chain, rpcUrls } = resolveChain(chainId);
  const extraRpcUrls = config.extraRpcUrls.filter((u) => !rpcUrls.includes(u));
  const allRpcUrls = [...rpcUrls, ...extraRpcUrls];

  if (allRpcUrls.length === 0) {
    throw new Error(`No RPC URLs configured for chain ${chainId}.`);
  }

  const account = privateKeyToAccount(config.privateKey);
  warmUp(allRpcUrls);

  return { account, chain, rpcUrls: allRpcUrls };
}

function toHexQuantity(value: bigint): Hex {
  return `0x${value.toString(16)}`;
}

function fromHexQuantity(hex: string): bigint {
  return BigInt(hex);
}

/** Starting nonce (call once, then increment locally per sent tx) + a buffered legacy gas price. */
export async function prepareNonceAndGasPrice(
  address: Address,
  rpcUrls: string[]
): Promise<{ nonce: number; gasPrice: bigint }> {
  const [nonceHex, gasPriceHex] = await Promise.all([
    rpcCallRace<string>(rpcUrls, "eth_getTransactionCount", [address, "pending"]),
    rpcCallRace<string>(rpcUrls, "eth_gasPrice", []),
  ]);

  const rawGasPrice = fromHexQuantity(gasPriceHex);
  const gasPrice = (rawGasPrice * (100n + BigInt(config.gasBufferPercent))) / 100n;

  return { nonce: Number(fromHexQuantity(nonceHex)), gasPrice };
}

/** Per-call gas estimate with the project's configured safety buffer, and a fallback if estimateGas reverts/fails. */
export async function estimateGasWithFallback(
  rpcUrls: string[],
  call: { from: Address; to: Address; data: Hex; value: bigint },
  fallback: bigint
): Promise<bigint> {
  try {
    const estimate = await rpcCallRace<string>(rpcUrls, "eth_estimateGas", [
      {
        from: call.from,
        to: call.to,
        data: call.data,
        value: toHexQuantity(call.value),
      },
      "latest",
    ]).then(fromHexQuantity);

    return (estimate * (100n + BigInt(config.gasBufferPercent))) / 100n;
  } catch (err) {
    console.warn(
      `WARNING: eth_estimateGas failed for ${call.to} (${
        err instanceof Error ? err.message : String(err)
      }). Using fallback gas limit ${fallback}.`
    );
    return fallback;
  }
}

/** eth_call helper for read-only calls like ERC-20 decimals()/symbol(). */
export async function ethCall(rpcUrls: string[], to: Address, data: Hex): Promise<Hex> {
  return rpcCallRace<Hex>(rpcUrls, "eth_call", [{ to, data }, "latest"]);
}

export interface SignedSendResult {
  hash: Hex;
  rpcUrl: string;
}

/** Signs locally (account.signTransaction — no walletClient) and broadcasts via the warmed RPC pool. */
export async function signAndSend(
  ctx: SendContext,
  tx: { to: Hex; data: Hex; value: bigint; nonce: number; gas: bigint; gasPrice: bigint }
): Promise<SignedSendResult> {
  if (!ctx.account.signTransaction) {
    throw new Error("Account has no local signTransaction — expected a privateKeyToAccount() local account.");
  }

  const signedTx = await ctx.account.signTransaction({
    to: tx.to,
    data: tx.data,
    value: tx.value,
    nonce: tx.nonce,
    gas: tx.gas,
    gasPrice: tx.gasPrice,
    chainId: ctx.chain.id,
  });

  const result = await broadcastRace(ctx.rpcUrls, signedTx);
  return { hash: result.hash, rpcUrl: result.rpcUrl };
}

export function parsePositiveInt(value: string, name: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return n;
}
