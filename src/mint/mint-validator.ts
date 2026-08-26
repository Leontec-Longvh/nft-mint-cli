import type {
  PublicClient,
} from "viem";

import type {
  MintPlan,
} from "./mint-plan.js";

export interface MintValidationResult {
  valid: boolean;
  reason?: string;
}

export class MintValidator {
  constructor(
    private readonly publicClient: PublicClient,
  ) {}

  async validate(
    plan: MintPlan,
  ): Promise<MintValidationResult> {
    try {
      const chainId =
        await this.publicClient.getChainId();

      if (
        chainId !== plan.chainId
      ) {
        return {
          valid: false,
          reason:
            `Chain mismatch: RPC=${chainId}, plan=${plan.chainId}`,
        };
      }

      await this.publicClient.call({
        account: plan.wallet,
        to: plan.to,
        data: plan.data,
        value: plan.value,
      });

      return {
        valid: true,
      };
    } catch (error) {
      return {
        valid: false,
        reason:
          error instanceof Error
            ? error.message
            : String(error),
      };
    }
  }
}