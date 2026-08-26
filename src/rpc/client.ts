import {
  createPublicClient,
  http,
} from "viem";

import {
  CHAINS,
  type ChainName,
} from "../chains/definitions.js";

import {
  RpcManager,
} from "./manager.js";

export async function createChainClient(
  rpcManager: RpcManager,
  chainName: ChainName,
) {
  const best =
    await rpcManager.getBest(chainName);

  return createPublicClient({
    chain: CHAINS[chainName],
    transport: http(best.url, {
      timeout: 5_000,
    }),
  });
}