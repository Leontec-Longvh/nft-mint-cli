import type {
  Account,
  Address,
  Hex,
} from "viem";

import type {
  RpcManager,
} from "../rpc/manager.js";

import type {
  MintPlan,
} from "./mint-plan.js";

/*
 * ============================================================
 * TYPES
 * ============================================================
 */

export interface ExecutionContext1559 {
  nonce: number;

  gas: bigint;

  maxFeePerGas: bigint;

  maxPriorityFeePerGas: bigint;
}

export interface ExecutionContextLegacy {
  nonce: number;

  gas: bigint;

  gasPrice: bigint;
}

export type ExecutionContext =
  | ExecutionContext1559
  | ExecutionContextLegacy;

export interface MintExecutionResult {
  hash: Hex;

  latencyMs: number;

  rpcUrl: string;
}

/*
 * ============================================================
 * BROADCAST FUNCTION
 * ============================================================
 *
 * IMPORTANT:
 *
 * Viem's WalletClient generic type stays inside mint.ts.
 *
 * MintExecutor does NOT know anything about the concrete
 * WalletClient type.
 *
 * This completely avoids chain-specific Viem generic errors.
 */

export type BroadcastTransaction =
  (
    parameters: {
      to: Address;

      data: Hex;

      value: bigint;

      nonce: number;

      gas: bigint;

      maxFeePerGas?: bigint;

      maxPriorityFeePerGas?: bigint;

      gasPrice?: bigint;
    },
  ) => Promise<Hex>;

/*
 * ============================================================
 * EXECUTOR
 * ============================================================
 *
 * RESPONSIBILITY:
 *
 *   - validate prepared transaction
 *   - receive prepared gas
 *   - receive current nonce
 *   - receive current fee
 *   - broadcast
 *
 * NEVER:
 *
 *   - estimateGas()
 *   - call OpenSea
 *   - discover phase
 *   - wait for phase
 *   - rebuild calldata
 */

export class MintExecutor {
  constructor(
    private readonly broadcast:
      BroadcastTransaction,

    private readonly rpcManager:
      RpcManager,

    private readonly chainName:
      string,

    private readonly account:
      Account,
  ) {}

  /*
   * ==========================================================
   * EXECUTE
   * ==========================================================
   */

  async execute(
    plan:
      MintPlan,

    context:
      ExecutionContext,
  ): Promise<MintExecutionResult> {
    const startedAt =
      Date.now();

    /*
     * ----------------------------------------------------------
     * VALIDATION
     * ----------------------------------------------------------
     */

    if (
      !plan.to.startsWith(
        "0x",
      )
    ) {
      throw new Error(
        `Invalid transaction target: ${plan.to}`,
      );
    }

    if (
      !plan.data.startsWith(
        "0x",
      )
    ) {
      throw new Error(
        "Invalid transaction calldata.",
      );
    }

    if (
      plan.value < 0n
    ) {
      throw new Error(
        `Invalid transaction value: ${plan.value}`,
      );
    }

    if (
      context.gas <= 0n
    ) {
      throw new Error(
        `Invalid gas limit: ${context.gas}`,
      );
    }

    if (
      context.nonce < 0
    ) {
      throw new Error(
        `Invalid nonce: ${context.nonce}`,
      );
    }

    /*
     * ----------------------------------------------------------
     * ACCOUNT VALIDATION
     * ----------------------------------------------------------
     */

    if (
      plan.wallet.toLowerCase() !==
      this.account.address.toLowerCase()
    ) {
      throw new Error(
        [
          "Mint account mismatch.",
          `Plan wallet: ${plan.wallet}`,
          `Executor account: ${this.account.address}`,
        ].join("\n"),
      );
    }

    /*
     * ----------------------------------------------------------
     * LOG
     * ----------------------------------------------------------
     */

    console.log("");

    console.log(
      "[EXECUTOR] Broadcasting prepared transaction...",
    );

    console.log(
      `[EXECUTOR] Chain: ${this.chainName}`,
    );

    console.log(
      `[EXECUTOR] From: ${this.account.address}`,
    );

    console.log(
      `[EXECUTOR] To: ${plan.to}`,
    );

    console.log(
      `[EXECUTOR] Nonce: ${context.nonce}`,
    );

    console.log(
      `[EXECUTOR] Gas: ${context.gas}`,
    );

    console.log(
      `[EXECUTOR] Value: ${plan.value}`,
    );

    /*
     * ==========================================================
     * EIP-1559
     * ==========================================================
     */

    if (
      "maxFeePerGas" in
      context
    ) {
      if (
        context.maxFeePerGas <= 0n
      ) {
        throw new Error(
          `Invalid maxFeePerGas: ${context.maxFeePerGas}`,
        );
      }

      if (
        context.maxPriorityFeePerGas <= 0n
      ) {
        throw new Error(
          `Invalid maxPriorityFeePerGas: ${context.maxPriorityFeePerGas}`,
        );
      }

      if (
        context.maxFeePerGas <
        context.maxPriorityFeePerGas
      ) {
        throw new Error(
          [
            "Invalid EIP-1559 fee configuration.",
            `maxFeePerGas: ${context.maxFeePerGas}`,
            `maxPriorityFeePerGas: ${context.maxPriorityFeePerGas}`,
          ].join("\n"),
        );
      }

      console.log(
        `[EXECUTOR] Max fee: ${context.maxFeePerGas}`,
      );

      console.log(
        `[EXECUTOR] Priority fee: ${context.maxPriorityFeePerGas}`,
      );

      /*
       * No Viem WalletClient here.
       *
       * No chain generic.
       *
       * No blobs problem.
       */

      const hash =
        await this.broadcast({
          to:
            plan.to,

          data:
            plan.data,

          value:
            plan.value,

          nonce:
            context.nonce,

          gas:
            context.gas,

          maxFeePerGas:
            context.maxFeePerGas,

          maxPriorityFeePerGas:
            context.maxPriorityFeePerGas,
        });

      const latencyMs =
        Date.now() -
        startedAt;

      console.log("");

      console.log(
        "[EXECUTOR] Broadcast OK.",
      );

      console.log(
        `[EXECUTOR] TX: ${hash}`,
      );

      console.log(
        `[EXECUTOR] Latency: ${latencyMs} ms`,
      );

      return {
        hash,

        latencyMs,

        rpcUrl:
          this.resolveRpcUrl(),
      };
    }

    /*
     * ==========================================================
     * LEGACY
     * ==========================================================
     */

    if (
      context.gasPrice <= 0n
    ) {
      throw new Error(
        `Invalid gasPrice: ${context.gasPrice}`,
      );
    }

    console.log(
      `[EXECUTOR] Gas price: ${context.gasPrice}`,
    );

    const hash =
      await this.broadcast({
        to:
          plan.to,

        data:
          plan.data,

        value:
          plan.value,

        nonce:
          context.nonce,

        gas:
          context.gas,

        gasPrice:
          context.gasPrice,
      });

    const latencyMs =
      Date.now() -
      startedAt;

    console.log("");

    console.log(
      "[EXECUTOR] Broadcast OK.",
    );

    console.log(
      `[EXECUTOR] TX: ${hash}`,
    );

    console.log(
      `[EXECUTOR] Latency: ${latencyMs} ms`,
    );

    return {
      hash,

      latencyMs,

      rpcUrl:
        this.resolveRpcUrl(),
    };
  }

  /*
   * ==========================================================
   * RPC URL
   * ==========================================================
   */

  private resolveRpcUrl(): string {
    return this.chainName;
  }
}

