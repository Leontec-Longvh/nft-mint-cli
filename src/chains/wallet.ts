import {
  createWalletClient,
  http,
  type Account,
  type Chain,
  type Transport,
  type WalletClient,
} from "viem";

export type MintWalletClient<
  TChain extends Chain = Chain,
> = WalletClient<
  Transport,
  TChain,
  Account
>;

export function createMintWalletClient<
  TChain extends Chain,
>(
  chain: TChain,
  account: Account,
  rpcUrl: string,
): MintWalletClient<TChain> {
  return createWalletClient({
    account,
    chain,
    transport: http(rpcUrl, {
      timeout: 5_000,
    }),
  });
}