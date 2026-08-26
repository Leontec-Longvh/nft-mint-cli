import type { Hex } from "viem";

export interface BroadcastResult {
  hash: Hex;
  rpcUrl: string;
  latencyMs: number;
}

/**
 * Sends a signed raw transaction to every configured RPC endpoint at once
 * and returns as soon as the first one accepts it. This is the main speed
 * lever for FCFS competition: whichever RPC's mempool/sequencer is fastest
 * to respond wins, instead of being at the mercy of a single endpoint.
 */
export async function broadcastRace(
  rpcUrls: string[],
  rawTx: Hex,
): Promise<BroadcastResult> {
  if (rpcUrls.length === 0) {
    throw new Error("No RPC endpoints configured for broadcast.");
  }

  const startedAt = performance.now();

  const attempts = rpcUrls.map(async (url): Promise<BroadcastResult> => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_sendRawTransaction",
        params: [rawTx],
      }),
    });

    const payload = (await response.json()) as {
      result?: string;
      error?: { message?: string; code?: number };
    };

    if (payload.error) {
      throw new Error(`[${url}] ${payload.error.message ?? "RPC error"}`);
    }
    if (!payload.result?.startsWith("0x")) {
      throw new Error(`[${url}] RPC returned no transaction hash`);
    }

    return {
      hash: payload.result as Hex,
      rpcUrl: url,
      latencyMs: Math.round(performance.now() - startedAt),
    };
  });

  try {
    return await Promise.any(attempts);
  } catch (error) {
    const messages =
      error instanceof AggregateError
        ? error.errors.map((e) => (e instanceof Error ? e.message : String(e)))
        : [String(error)];
    throw new Error(["All RPC broadcasts failed.", ...messages].join("\n"));
  }
}
