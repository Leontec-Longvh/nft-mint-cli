import type {
  Address,
  PublicClient,
} from "viem";

export interface GasEstimateInput {
  account: Address;
  to: Address;
  data: `0x${string}`;
  value: bigint;
}

export interface GasSnapshot {
  gas: bigint;

  maxFeePerGas: bigint;

  maxPriorityFeePerGas: bigint;

  fetchedAt: number;

  chainId: number;
}

export interface GasManagerOptions {
  /**
   * How long a gas snapshot is considered valid.
   *
   * Default: 15 seconds.
   */
  ttlMs?: number;

  /**
   * Optional safety multiplier for estimated gas.
   *
   * Example:
   *   1.10 = +10%
   *   1.20 = +20%
   *
   * Default: 1.10
   */
  gasMultiplier?: number;
}

export class GasManager {
  private snapshot:
    GasSnapshot | undefined;

  private readonly ttlMs: number;

  private readonly gasMultiplier: number;

  private preloadPromise:
    Promise<GasSnapshot> | undefined;

  constructor(
    private readonly publicClient: PublicClient,
    options: GasManagerOptions = {},
  ) {
    this.ttlMs =
      options.ttlMs ?? 15_000;

    this.gasMultiplier =
      options.gasMultiplier ?? 1.10;

    if (
      this.ttlMs <= 0
    ) {
      throw new Error(
        "GasManager ttlMs must be greater than 0",
      );
    }

    if (
      this.gasMultiplier < 1
    ) {
      throw new Error(
        "GasManager gasMultiplier must be >= 1",
      );
    }
  }

  /**
   * Preload gas + EIP-1559 fee data.
   *
   * This method performs RPC calls.
   *
   * Call it BEFORE the FCFS trigger.
   */
  async preload(
    transaction: GasEstimateInput,
  ): Promise<GasSnapshot> {
    /*
     * Prevent duplicate concurrent preload calls.
     *
     * If two parts of the application call preload()
     * at the same time, only one RPC operation is executed.
     */
    if (this.preloadPromise) {
      return this.preloadPromise;
    }

    this.preloadPromise =
      this.fetchGas(transaction);

    try {
      return await this.preloadPromise;
    } finally {
      this.preloadPromise =
        undefined;
    }
  }

  /**
   * Fetch fresh gas data from RPC.
   */
  private async fetchGas(
    transaction: GasEstimateInput,
  ): Promise<GasSnapshot> {
    const [
      gasEstimate,
      feeEstimate,
      chainId,
    ] = await Promise.all([
      this.publicClient.estimateGas({
        account:
          transaction.account,

        to:
          transaction.to,

        data:
          transaction.data,

        value:
          transaction.value,
      }),

      this.publicClient
        .estimateFeesPerGas(),

      this.publicClient
        .getChainId(),
    ]);

    const gas =
      this.applyGasMultiplier(
        gasEstimate,
      );

    const maxFeePerGas =
      feeEstimate.maxFeePerGas;

    const maxPriorityFeePerGas =
      feeEstimate.maxPriorityFeePerGas;

    const snapshot: GasSnapshot = {
      gas,

      maxFeePerGas,

      maxPriorityFeePerGas,

      fetchedAt:
        Date.now(),

      chainId,
    };

    this.snapshot =
      snapshot;

    return snapshot;
  }

  /**
   * Return the currently cached snapshot.
   *
   * This NEVER performs an RPC call.
   */
  getCached():
    GasSnapshot | undefined {
    return this.snapshot;
  }

  /**
   * Return cached gas only if it is still valid.
   *
   * This NEVER performs an RPC call.
   */
  getValid():
    GasSnapshot {
    if (!this.snapshot) {
      throw new Error(
        "GasManager has not been preloaded",
      );
    }

    if (
      this.isExpired()
    ) {
      throw new Error(
        `Gas snapshot expired (${this.ageMs()}ms old)`,
      );
    }

    return this.snapshot;
  }

  /**
   * Check whether a valid cached snapshot exists.
   */
  isReady(): boolean {
    if (!this.snapshot) {
      return false;
    }

    return !this.isExpired();
  }

  /**
   * Check whether cached gas has expired.
   */
  isExpired(): boolean {
    if (!this.snapshot) {
      return true;
    }

    return (
      Date.now() -
        this.snapshot.fetchedAt >=
      this.ttlMs
    );
  }

  /**
   * Age of current snapshot.
   */
  ageMs(): number {
    if (!this.snapshot) {
      return Infinity;
    }

    return (
      Date.now() -
      this.snapshot.fetchedAt
    );
  }

  /**
   * Remaining validity time.
   */
  remainingTtlMs(): number {
    if (!this.snapshot) {
      return 0;
    }

    return Math.max(
      0,
      this.ttlMs -
        this.ageMs(),
    );
  }

  /**
   * Force clear the cached snapshot.
   */
  reset(): void {
    this.snapshot =
      undefined;
  }

  /**
   * Get the configured TTL.
   */
  get ttl(): number {
    return this.ttlMs;
  }

  /**
   * Get gas multiplier.
   */
  get multiplier(): number {
    return this.gasMultiplier;
  }

  /**
   * Apply safety multiplier to gas estimate.
   *
   * Example:
   *
   * 100000 gas × 1.10
   * = 110000 gas
   */
  private applyGasMultiplier(
    gas: bigint,
  ): bigint {
    const multiplier =
      BigInt(
        Math.ceil(
          this.gasMultiplier *
            1_000_000,
        ),
      );

    return (
      gas *
      multiplier /
      1_000_000n
    );
  }
}