import type { ChainName } from "./definitions.js";

export const RPCS: Record<ChainName, string[]> = {
  ethereum: [
    "https://ethereum-rpc.publicnode.com",
  ],

  base: [
    "https://base-rpc.publicnode.com",
  ],

  polygon: [
    "https://polygon-bor-rpc.publicnode.com",
  ],

  arbitrum: [
    "https://arbitrum-one-rpc.publicnode.com",
  ],

  optimism: [
    "https://optimism-rpc.publicnode.com",
  ],

  zora: [
    "https://zora-rpc.publicnode.com",
  ],

  robinhood: [
    "https://rpc.mainnet.chain.robinhood.com",
  ],

  ink: [
    "https://rpc-gel.inkonchain.com",
  ],
};