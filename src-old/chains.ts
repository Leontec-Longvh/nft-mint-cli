import {
  arbitrum,
  base,
  mainnet,
  optimism,
  polygon,
  zora,
  type Chain,
} from "viem/chains";

/*
 * Custom / example chains that aren't in viem/chains by default.
 * Keep these here so `--chain-id 4663` from the readme keeps working.
 */
const robinhood = {
  id: 4663,
  name: "Robin Hood Chain",
  nativeCurrency: { name: "Robin", symbol: "RBN", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc.mainnet.chain.robinhood.com"] },
  },
} as const satisfies Chain;

const ink = {
  id: 10001,
  name: "Ink Chain",
  nativeCurrency: { name: "Ink", symbol: "INK", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc-gel.inkonchain.com"] },
  },
} as const satisfies Chain;

interface ChainEntry {
  chain: Chain;
  /** Public RPC endpoints, raced in parallel at broadcast time. */
  rpcUrls: string[];
}

export const CHAINS: Record<string, ChainEntry> = {
  ethereum: { chain: mainnet, rpcUrls: ["https://ethereum-rpc.publicnode.com"] },
  base: { chain: base, rpcUrls: ["https://base-rpc.publicnode.com"] },
  polygon: { chain: polygon, rpcUrls: ["https://polygon-bor-rpc.publicnode.com"] },
  arbitrum: { chain: arbitrum, rpcUrls: ["https://arbitrum-one-rpc.publicnode.com"] },
  optimism: { chain: optimism, rpcUrls: ["https://optimism-rpc.publicnode.com"] },
  zora: { chain: zora, rpcUrls: ["https://zora-rpc.publicnode.com"] },
  robinhood: { chain: robinhood, rpcUrls: ["https://rpc.mainnet.chain.robinhood.com"] },
  ink: { chain: ink, rpcUrls: ["https://rpc-gel.inkonchain.com"] },
};

export function resolveChain(chainId: number): ChainEntry {
  const entry = Object.values(CHAINS).find((c) => c.chain.id === chainId);
  if (!entry) {
    throw new Error(`Unsupported chain ID: ${chainId}`);
  }
  return entry;
}
