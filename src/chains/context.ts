import type {
  Chain,
  PublicClient,
  WalletClient,
} from "viem";

import type {
  ChainName,
} from "./definitions.js";

export interface ChainContext {
  name: ChainName;

  chain: Chain;

  chainId: number;

  rpcUrl: string;

  latency: number;
}

export interface ChainRuntimeContext
  extends ChainContext {
  publicClient: PublicClient;

  walletClient: WalletClient;
}