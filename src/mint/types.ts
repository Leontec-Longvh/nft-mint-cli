import type {
  Hex,
} from "viem";

export interface MintExecutionResult {
  hash: Hex;

  nonce: number;

  startedAt: number;

  signedAt: number;

  broadcastAt: number;

  totalMs: number;

  signingMs: number;

  broadcastMs: number;
}