import {
  createPublicClient,
  createWalletClient,
  http,
  type Account,
  type WalletClient,
} from "viem";

import {
  CHAINS,
  type ChainName,
} from "./definitions.js";

import {
  RpcManager,
} from "../rpc/manager.js";

import type {
  ChainContext,
  ChainRuntimeContext,
} from "./context.js";

export class ChainContextManager {
  constructor(
    private readonly rpcManager:
      RpcManager,
  ) {}

  async get(
    name: ChainName,
  ): Promise<ChainContext> {
    const chain =
      CHAINS[name];

    if (!chain) {
      throw new Error(
        `Unsupported chain: ${name}`,
      );
    }

    const best =
      await this.rpcManager.getBest(
        name,
      );

    return {
      name,

      chain,

      chainId:
        chain.id,

      rpcUrl:
        best.url,

      latency:
        best.latency,
    };
  }

  async getRuntime(
    name: ChainName,
    account: Account,
  ): Promise<ChainRuntimeContext> {
    const context =
      await this.get(name);

    const transport =
      http(context.rpcUrl);

    const publicClient =
      createPublicClient({
        chain: context.chain,
        transport,
      });

    const walletClient =
      createWalletClient({
        account,
        chain: context.chain,
        transport,
      });

    return {
      ...context,

      publicClient,

      walletClient,
    };
  }

  getNameByChainId(
    chainId: number,
  ): ChainName {
    const entry =
      Object.entries(
        CHAINS,
      ).find(
        ([, chain]) =>
          chain.id === chainId,
      );

    if (!entry) {
      throw new Error(
        `Unsupported chain ID: ${chainId}`,
      );
    }

    return entry[0] as ChainName;
  }

  getRpcManager(): RpcManager {
    return this.rpcManager;
  }
}