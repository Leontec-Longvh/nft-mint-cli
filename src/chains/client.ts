import {
  createPublicClient,
  http,
} from "viem";

import type {
  ChainContext,
} from "./context.js";

export function createContextClient(
  context: ChainContext,
) {
  return createPublicClient({
    chain: context.chain,
    transport: http(
      context.rpcUrl,
      {
        timeout: 5_000,
      },
    ),
  });
}