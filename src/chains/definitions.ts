import {
  arbitrum,
  base,
  mainnet,
  optimism,
  polygon,
  zora,
} from "viem/chains";

export const robinhood = {
  id: 4663,
  name: 'Robin Hood Chain',
  network: 'robinhood',
  nativeCurrency: { name: 'Robin', symbol: 'RBN', decimals: 18 },
  rpcUrls: {
    public: { http: ['https://rpc.mainnet.chain.robinhood.com'] },
    default: { http: ['https://rpc.mainnet.chain.robinhood.com'] },
  },
  blockExplorers: {
    default: { name: 'Robin Explorer', url: 'https://explorer.robinhoodchain.example' },
  },
} as const;

export const ink = {
  id: 10001,
  name: 'Ink Chain',
  network: 'ink',
  nativeCurrency: { name: 'Ink', symbol: 'INK', decimals: 18 },
  rpcUrls: {
    public: { http: ['https://rpc-gel.inkonchain.com'] },
    default: { http: ['https://rpc-gel.inkonchain.com'] },
  },
  blockExplorers: {
    default: { name: 'Ink Explorer', url: 'https://explorer.inkchain.example' },
  },
} as const;

export const CHAINS = {
  ethereum: mainnet,
  base,
  polygon,
  arbitrum,
  optimism,
  zora,
  robinhood,
  ink,
} as const;

export type ChainName = keyof typeof CHAINS;