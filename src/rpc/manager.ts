import {
  type Hex,
} from "viem";

import {
  type ChainName,
} from "../chains/definitions.js";

import {
  RPCS,
} from "../chains/rpc.js";

export interface BroadcastResult {
  hash: Hex;
  rpc: string;
  latencyMs: number;
}

export class RpcManager {
  getBroadcastUrls(
    chainName: ChainName,
  ): string[] {
    const urls =
      RPCS[chainName];

    if (
      !urls ||
      urls.length === 0
    ) {
      throw new Error(
        `No RPC configured for ${chainName}`,
      );
    }

    return urls;
  }

  async sendRawTransactionParallel(
    chainName: ChainName,
    raw: Hex,
  ): Promise<BroadcastResult> {
    const urls =
      this.getBroadcastUrls(
        chainName,
      );

    const started =
      performance.now();

    const controllers =
      urls.map(
        () =>
          new AbortController(),
      );

    const requests =
      urls.map(
        (url, index) =>
          this.broadcast(
            url,
            raw,
            controllers[index],
          ).then(
            (hash) => ({
              hash,
              rpc: url,
              latencyMs:
                Math.round(
                  performance.now() -
                    started,
                ),
            }),
          ),
      );

    try {
      const result =
        await Promise.any(
          requests,
        );

      for (
        const controller
          of controllers
      ) {
        controller.abort();
      }

      return result;
    } catch (error) {
      const messages =
        error instanceof AggregateError
          ? error.errors.map(
              (item) =>
                item instanceof Error
                  ? item.message
                  : String(item),
            )
          : [
              error instanceof Error
                ? error.message
                : String(error),
            ];

      throw new Error(
        [
          "All RPC broadcasts failed.",
          ...messages,
        ].join("\n"),
      );
    }
  }

  private async broadcast(
    url: string,
    raw: Hex,
    controller: AbortController,
  ): Promise<Hex> {
    const response =
      await fetch(
        url,
        {
          method: "POST",

          headers: {
            "content-type":
              "application/json",
          },

          body:
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method:
                "eth_sendRawTransaction",
              params: [raw],
            }),

          signal:
            controller.signal,
        },
      );

    const text =
      await response.text();

    if (!response.ok) {
      throw new Error(
        `[${url}] HTTP ${response.status}: ${text}`,
      );
    }

    let payload: {
      result?: string;
      error?: {
        code?: number;
        message?: string;
        data?: unknown;
      };
    };

    try {
      payload =
        JSON.parse(text) as typeof payload;
    } catch {
      throw new Error(
        `[${url}] Invalid JSON response`,
      );
    }

    if (payload.error) {
      throw new Error(
        [
          `[${url}]`,
          payload.error.message ??
            "RPC error",
          payload.error.code !==
            undefined
            ? `code=${payload.error.code}`
            : "",
        ]
          .filter(Boolean)
          .join(" "),
      );
    }

    if (
      typeof payload.result !==
        "string" ||
      !payload.result.startsWith(
        "0x",
      )
    ) {
      throw new Error(
        `[${url}] RPC returned no transaction hash`,
      );
    }

    return payload.result as Hex;
  }
}