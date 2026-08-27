import type { Hex } from "viem";
import * as http from "node:http";
import * as https from "node:https";
import { URL } from "node:url";

const REQUEST_TIMEOUT_MS = 2_500;

interface JsonRpcResponse<T = unknown> {
  jsonrpc?: string;
  id?: number;
  result?: T;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
}

interface RpcConnection {
  url: string;
  protocol: "http:" | "https:";
  hostname: string;
  port: number;
  path: string;
  agent: http.Agent | https.Agent;
}

/*
 * ============================================================
 * PERSISTENT RPC CONNECTIONS
 * ============================================================
 *
 * V6:
 *
 * fetch()
 *   -> new request
 *   -> connection management
 *   -> RPC
 *
 * V7:
 *
 * keep-alive Agent
 *   -> persistent TCP/TLS connection
 *   -> JSON-RPC request
 *
 * This removes connection setup from the FCFS broadcast path.
 * ============================================================
 */

const connections = new Map<string, RpcConnection>();

function getConnection(urlString: string): RpcConnection {
  const cached = connections.get(urlString);

  if (cached) {
    return cached;
  }

  const parsed = new URL(urlString);

  const isHttps = parsed.protocol === "https:";

  const agent = isHttps
    ? new https.Agent({
        keepAlive: true,
        maxSockets: 4,
        maxFreeSockets: 4,
        scheduling: "lifo",
      })
    : new http.Agent({
        keepAlive: true,
        maxSockets: 4,
        maxFreeSockets: 4,
        scheduling: "lifo",
      });

  const connection: RpcConnection = {
    url: urlString,
    protocol: isHttps ? "https:" : "http:",
    hostname: parsed.hostname,
    port:
      Number(parsed.port) ||
      (isHttps ? 443 : 80),
    path:
      parsed.pathname +
      parsed.search,
    agent,
  };

  connections.set(
    urlString,
    connection,
  );

  return connection;
}

/*
 * ============================================================
 * RAW JSON-RPC
 * ============================================================
 */

function rpcRequest<T>(
  connection: RpcConnection,
  method: string,
  params: unknown[],
): Promise<T> {
  return new Promise(
    (resolve, reject) => {
      const payload = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params,
      });

      const transport =
        connection.protocol ===
        "https:"
          ? https
          : http;

      const request =
        transport.request({
          protocol:
            connection.protocol,
          hostname:
            connection.hostname,
          port:
            connection.port,
          path:
            connection.path,
          method: "POST",
          agent:
            connection.agent,
          headers: {
            "content-type":
              "application/json",
            accept:
              "application/json",
            "content-length":
              Buffer.byteLength(
                payload,
              ),
            connection:
              "keep-alive",
          },
        });

      let body = "";

      request.setTimeout(
        REQUEST_TIMEOUT_MS,
        () => {
          request.destroy(
            new Error(
              `RPC timeout after ${REQUEST_TIMEOUT_MS}ms`,
            ),
          );
        },
      );

      request.on(
        "error",
        (error) => {
          reject(error);
        },
      );

      request.on(
        "response",
        (response) => {
          response.setEncoding(
            "utf8",
          );

          response.on(
            "data",
            (chunk) => {
              body += chunk;
            },
          );

          response.on(
            "end",
            () => {
              try {
                const json =
                  JSON.parse(
                    body,
                  ) as JsonRpcResponse<T>;

                if (
                  json.error
                ) {
                  throw new Error(
                    json.error
                      .message ??
                      `RPC error ${json.error.code ?? ""}`,
                  );
                }

                if (
                  json.result ===
                  undefined
                ) {
                  throw new Error(
                    "RPC response missing result.",
                  );
                }

                resolve(
                  json.result,
                );
              } catch (error) {
                reject(error);
              }
            },
          );
        },
      );

      request.write(
        payload,
      );

      request.end();
    },
  );
}

/*
 * ============================================================
 * CONNECTION WARMUP
 * ============================================================
 */

export function warmUp(
  rpcUrls: string[],
): void {
  for (const url of rpcUrls) {
    const connection =
      getConnection(url);

    /*
     * eth_chainId establishes:
     *
     * TCP
     * TLS
     * HTTP keep-alive
     *
     * before T0.
     */
    void rpcRequest(
      connection,
      "eth_chainId",
      [],
    ).catch(() => {});
  }
}

/*
 * ============================================================
 * PREPARED RPC HELPERS
 * ============================================================
 */

/*
 * ============================================================
 * GENERIC RACED JSON-RPC CALL
 * ============================================================
 *
 * Every RPC read in the mint flow (nonce, fee data, gas
 * estimate) should go through THIS SAME persistent, warmed
 * connection pool — not viem's separate fetch-based client,
 * which pays a fresh TCP/TLS handshake every time because it's
 * a completely different connection pool that warmUp() never
 * touches.
 * ============================================================
 */
export async function rpcCallRace<T>(
  rpcUrls: string[],
  method: string,
  params: unknown[],
): Promise<T> {
  if (rpcUrls.length === 0) {
    throw new Error("No RPC endpoints configured.");
  }

  const attempts = rpcUrls.map((url) => rpcRequest<T>(getConnection(url), method, params));

  try {
    return await Promise.any(attempts);
  } catch (error) {
    const messages =
      error instanceof AggregateError
        ? error.errors.map((e) => (e instanceof Error ? e.message : String(e)))
        : [error instanceof Error ? error.message : String(error)];
    throw new Error([`All RPCs failed for ${method}.`, ...messages].join("\n"));
  }
}

export async function rpcGetTransactionCount(
  rpcUrls: string[],
  address: string,
): Promise<number> {
  const attempts =
    rpcUrls.map(
      async (url) => {
        const connection =
          getConnection(
            url,
          );

        const result =
          await rpcRequest<string>(
            connection,
            "eth_getTransactionCount",
            [
              address,
              "pending",
            ],
          );

        return Number(
          BigInt(result),
        );
      },
    );

  return Promise.any(
    attempts,
  );
}

export async function rpcGetGasPrice(
  rpcUrls: string[],
): Promise<bigint> {
  const attempts =
    rpcUrls.map(
      async (url) => {
        const connection =
          getConnection(
            url,
          );

        const result =
          await rpcRequest<string>(
            connection,
            "eth_gasPrice",
            [],
          );

        return BigInt(
          result,
        );
      },
    );

  return Promise.any(
    attempts,
  );
}

/*
 * ============================================================
 * BROADCAST
 * ============================================================
 */

export interface BroadcastResult {
  hash: Hex;
  rpcUrl: string;
  latencyMs: number;
}

export async function broadcastRace(
  rpcUrls: string[],
  rawTx: Hex,
): Promise<BroadcastResult> {
  if (
    rpcUrls.length === 0
  ) {
    throw new Error(
      "No RPC endpoints configured.",
    );
  }

  const startedAt =
    performance.now();

  const attempts =
    rpcUrls.map(
      async (
        url,
      ): Promise<BroadcastResult> => {
        const connection =
          getConnection(url);

        const hash =
          await rpcRequest<string>(
            connection,
            "eth_sendRawTransaction",
            [rawTx],
          );

        if (
          !hash.startsWith(
            "0x",
          )
        ) {
          throw new Error(
            `[${url}] Invalid transaction hash.`,
          );
        }

        return {
          hash:
            hash as Hex,
          rpcUrl:
            url,
          latencyMs:
            Math.round(
              performance.now() -
                startedAt,
            ),
        };
      },
    );

  try {
    return await Promise.any(
      attempts,
    );
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