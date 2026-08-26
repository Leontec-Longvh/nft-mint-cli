import type {
  Address,
  PublicClient,
} from "viem";

export class NonceManager {
  private nextNonce: number | undefined;

  constructor(
    private readonly publicClient: PublicClient,
    private readonly account: Address,
  ) {}

  async preload(): Promise<number> {
    const nonce =
      await this.publicClient.getTransactionCount({
        address: this.account,
        blockTag: "pending",
      });

    this.nextNonce = nonce;

    return nonce;
  }

  consume(): number {
    if (this.nextNonce === undefined) {
      throw new Error(
        "NonceManager has not been preloaded",
      );
    }

    const nonce =
      this.nextNonce;

    this.nextNonce += 1;

    return nonce;
  }

  get cached(): number | undefined {
    return this.nextNonce;
  }

  reset(): void {
    this.nextNonce = undefined;
  }
}