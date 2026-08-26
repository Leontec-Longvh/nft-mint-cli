import type {
  Account,
  Address,
  PublicClient,
} from "viem";

import type {
  MintPlan,
} from "./mint-plan.js";

/*
 * ------------------------------------------------------------
 * Runtime context
 * ------------------------------------------------------------
 */

export interface MintRuntimeContext {
  nonce: number;

  gas: bigint;

  maxFeePerGas?: bigint;

  maxPriorityFeePerGas?: bigint;

  gasPrice?: bigint;
}

/*
 * ------------------------------------------------------------
 * Constants
 * ------------------------------------------------------------
 *
 * EIP-1559 base fee can increase by up to 12.5% per block.
 *
 * We therefore give maxFeePerGas one-block headroom:
 *
 *   baseFee * 112.5% + priorityFee
 *
 * Integer bigint arithmetic:
 *
 *   baseFee * 9 / 8
 *
 * This is considerably tighter than using 2x base fee,
 * while still protecting against the common:
 *
 *   maxFeePerGas < next block baseFee
 *
 * rejection.
 */

const BASE_FEE_NUMERATOR =
  9n;

const BASE_FEE_DENOMINATOR =
  8n;

/*
 * Gas safety buffer.
 *
 * Actual mint calldata is estimated first, then a 15% buffer
 * is added before signing.
 */

const GAS_BUFFER_NUMERATOR =
  115n;

const GAS_BUFFER_DENOMINATOR =
  100n;

/*
 * ------------------------------------------------------------
 * MintRuntime
 * ------------------------------------------------------------
 */

export class MintRuntime {
  constructor(
    private readonly publicClient: PublicClient,
  ) {}

  /**
   * Prepare everything required immediately before signing.
   *
   * FCFS optimization:
   *
   *   nonce ─────────────┐
   *   gas estimate ──────┤
   *   block + fee ───────┼──> Promise.all()
   *                      │
   *                      ↓
   *                  runtime context
   *
   * No eth_call simulation is performed here.
   *
   * The actual transaction calldata from MintPlan is used
   * for gas estimation.
   */
  async prepare(
    plan: MintPlan,
    account: Account | Address,
  ): Promise<MintRuntimeContext> {
    /*
     * ---------------------------------------------------------
     * 1. Basic plan validation
     * ---------------------------------------------------------
     */

    this.assertPlan(
      plan,
    );

    /*
     * ---------------------------------------------------------
     * 2. Resolve account address
     * ---------------------------------------------------------
     *
     * Account can be either:
     *
     *   - viem Account object
     *   - Address
     *
     * Keeping the address once avoids repeatedly resolving it.
     */

    const accountAddress =
      typeof account === "string"
        ? account
        : account.address;

    /*
     * ---------------------------------------------------------
     * 3. PARALLEL PREWARM
     * ---------------------------------------------------------
     *
     * These RPC operations are independent.
     *
     * DO NOT run them sequentially:
     *
     *   nonce -> gas -> fee
     *
     * That would add the latency of every RPC call together.
     *
     * Instead:
     *
     *   nonce ────────┐
     *   estimateGas ──┤
     *   block ────────┤
     *   priority ─────┘
     *
     * all run concurrently.
     */

    const [
      nonce,
      estimatedGas,
      feeData,
    ] = await Promise.all([
      /*
       * Pending nonce is important for FCFS.
       *
       * If the wallet already has a pending transaction,
       * "pending" gives us the next usable nonce.
       */
      this.publicClient.getTransactionCount({
        address:
          accountAddress,

        blockTag:
          "pending",
      }),

      /*
       * Estimate gas against the REAL mint calldata.
       */
      this.publicClient.estimateGas({
        account:
          account,

        to:
          plan.to,

        data:
          plan.data,

        value:
          plan.value,
      }),

      /*
       * Get current EIP-1559 information.
       *
       * getBlock() gives us the actual current base fee.
       *
       * getMaxPriorityFeePerGas() gives us the priority fee
       * suggested by the RPC.
       *
       * They are fetched concurrently.
       */
      this.getFeeData(),
    ]);

    /*
     * ---------------------------------------------------------
     * 4. GAS BUFFER
     * ---------------------------------------------------------
     *
     * Add 15% to the actual estimate.
     *
     * Example:
     *
     *   estimate = 100,000
     *   gas      = 115,000
     */

    const gas =
      (
        estimatedGas *
        GAS_BUFFER_NUMERATOR
      ) /
      GAS_BUFFER_DENOMINATOR;

    /*
     * ---------------------------------------------------------
     * 5. BUILD FEE CONTEXT
     * ---------------------------------------------------------
     */

    if (
      feeData.type ===
      "eip1559"
    ) {
      const {
        baseFeePerGas,
        maxPriorityFeePerGas,
      } =
        feeData;

      /*
       * EIP-1559 max fee:
       *
       *   maxFee =
       *     baseFee * 9/8
       *     + priorityFee
       *
       * 9/8 = 112.5%.
       *
       * This accounts for the maximum normal one-block
       * base-fee increase while avoiding unnecessary 2x
       * over-allocation.
       */

      const nextBlockBaseFee =
        (
          baseFeePerGas *
          BASE_FEE_NUMERATOR
        ) /
        BASE_FEE_DENOMINATOR;

      let maxFeePerGas =
        nextBlockBaseFee +
        maxPriorityFeePerGas;

      /*
       * Defensive guarantee:
       *
       * maxFeePerGas must never be below priority fee.
       *
       * This is mostly defensive because nextBlockBaseFee
       * should already be positive on this chain.
       */
      if (
        maxFeePerGas <
        maxPriorityFeePerGas
      ) {
        maxFeePerGas =
          maxPriorityFeePerGas;
      }

      /*
       * Defensive guarantee:
       *
       * Fee fields must be positive.
       */
      if (
        maxFeePerGas <= 0n ||
        maxPriorityFeePerGas <= 0n
      ) {
        throw new Error(
          [
            "Invalid EIP-1559 fee data.",
            `baseFeePerGas=${baseFeePerGas}`,
            `maxFeePerGas=${maxFeePerGas}`,
            `maxPriorityFeePerGas=${maxPriorityFeePerGas}`,
          ].join("\n"),
        );
      }

      return {
        nonce,

        gas,

        maxFeePerGas,

        maxPriorityFeePerGas,
      };
    }

    /*
     * ---------------------------------------------------------
     * 6. LEGACY GAS PRICE
     * ---------------------------------------------------------
     */

    if (
      feeData.type ===
      "legacy"
    ) {
      if (
        feeData.gasPrice <=
        0n
      ) {
        throw new Error(
          `Invalid gasPrice: ${feeData.gasPrice}`,
        );
      }

      return {
        nonce,

        gas,

        gasPrice:
          feeData.gasPrice,
      };
    }

    /*
     * Should never happen because getFeeData()
     * normalizes the result.
     */

    throw new Error(
      "Unable to determine transaction fee configuration",
    );
  }

  /*
   * ----------------------------------------------------------
   * Fee data
   * ----------------------------------------------------------
   *
   * Keep all fee-related RPC calls in one place.
   *
   * The primary path is:
   *
   *   getBlock()
   *   +
   *   getMaxPriorityFeePerGas()
   *
   * If the chain does not expose EIP-1559 base fee,
   * fall back to gasPrice.
   */


private async getFeeData():
  Promise<
    | {
        type: "eip1559";
        baseFeePerGas: bigint;
        maxPriorityFeePerGas: bigint;
      }
    | {
        type: "legacy";
        gasPrice: bigint;
      }
  > {
  try {
    /*
     * Fetch block + priority fee concurrently.
     *
     * viem:
     *   block.baseFeePerGas === bigint | null
     */
    const [
      block,
      priorityFee,
    ] = await Promise.all([
      this.publicClient.getBlock(),

      this.publicClient
        .estimateMaxPriorityFeePerGas(),
    ]);

    const baseFeePerGas =
      block.baseFeePerGas;

    /*
     * No base fee means the chain/RPC is exposing
     * legacy gas pricing.
     *
     * `== null` intentionally matches BOTH:
     *
     *   null
     *   undefined
     */
    if (
      baseFeePerGas == null
    ) {
      const gasPrice =
        await this.publicClient
          .getGasPrice();

      if (
        gasPrice <= 0n
      ) {
        throw new Error(
          `Invalid gasPrice: ${gasPrice}`,
        );
      }

      return {
        type: "legacy",

        gasPrice,
      };
    }

    /*
     * Some RPCs can theoretically return zero.
     * Never use zero priority fee for FCFS.
     */
    const maxPriorityFeePerGas =
      priorityFee > 0n
        ? priorityFee
        : 1n;

    return {
      type: "eip1559",

      baseFeePerGas,

      maxPriorityFeePerGas,
    };
  } catch {
    /*
     * Final fallback.
     *
     * If getBlock() or estimateMaxPriorityFeePerGas()
     * fails, use legacy gasPrice.
     */
    const gasPrice =
      await this.publicClient
        .getGasPrice();

    if (
      gasPrice <= 0n
    ) {
      throw new Error(
        `Invalid gasPrice: ${gasPrice}`,
      );
    }

    return {
      type: "legacy",

      gasPrice,
    };
  }
}


  /*
   * ----------------------------------------------------------
   * Plan validation
   * ----------------------------------------------------------
   */

  private assertPlan(
    plan: MintPlan,
  ): void {
    if (!plan) {
      throw new Error(
        "Mint plan is missing",
      );
    }

    if (
      !plan.to ||
      !plan.to.startsWith(
        "0x",
      )
    ) {
      throw new Error(
        "Mint plan target address is invalid",
      );
    }

    if (
      !plan.data ||
      !plan.data.startsWith(
        "0x",
      )
    ) {
      throw new Error(
        "Mint plan calldata is invalid",
      );
    }

    if (
      typeof plan.value !==
      "bigint"
    ) {
      throw new Error(
        "Mint plan value must be bigint",
      );
    }

    if (
      plan.value < 0n
    ) {
      throw new Error(
        "Mint plan value cannot be negative",
      );
    }
  }
}
