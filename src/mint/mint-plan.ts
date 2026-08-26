import type {
  Address,
  Hex,
} from "viem";

export interface MintPlan {
  chainId: number;

  wallet: Address;

  to: Address;

  data: Hex;

  value: bigint;

  quantity: number;

  createdAt: number;
}