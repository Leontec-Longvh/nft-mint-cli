import type {
  Address,
  Hex,
} from "viem";

import type {
  BuildMintRequest,
} from "../opensea/types.js";

import {
  OpenSeaClient,
} from "../opensea/client.js";

import type {
  MintPlan,
} from "./mint-plan.js";

/*
 * ------------------------------------------------------------
 * Types
 * ------------------------------------------------------------
 */

export type MintDiscoveryWaitReason =
  | "NOT_ACTIVE"
  | "NOT_ELIGIBLE"
  | "UNKNOWN";

export interface MintDiscoveryWait {
  status: "WAIT";

  reason:
    MintDiscoveryWaitReason;

  message: string;

  /*
   * Unix timestamp in seconds.
   *
   * This MUST come from the drop stage metadata.
   */

  nextStageTime?:
    number;
}

export interface MintDiscoveryReady {
  status: "READY";

  plan:
    MintPlan;
}

export type MintDiscoveryResult =
  | MintDiscoveryReady
  | MintDiscoveryWait;

/*
 * ------------------------------------------------------------
 * Internal stage type
 * ------------------------------------------------------------
 */

interface DiscoveryStage {
  label?:
    string;

  startTime?:
    number;

  endTime?:
    number;

  maxPerWallet?:
    number;

  maxSupply?:
    number;
}

/*
 * ------------------------------------------------------------
 * Error parsing
 * ------------------------------------------------------------
 */

function extractOpenSeaError(
  error: unknown,
): {
  status?: number;

  message: string;
} {
  if (
    !(error instanceof Error)
  ) {
    return {
      message:
        String(error),
    };
  }

  const message =
    error.message;

  const match =
    message.match(
      /OpenSea API\s+(\d+):\s*([\s\S]*)/i,
    );

  if (!match) {
    return {
      message,
    };
  }

  const status =
    Number(
      match[1],
    );

  let body =
    match[2] ??
    "";

  /*
   * OpenSea normally returns:
   *
   * {
   *   "errors": [
   *     "Wallet is not eligible..."
   *   ]
   * }
   */

  try {
    const parsed =
      JSON.parse(
        body,
      ) as {
        errors?: unknown;
      };

    if (
      Array.isArray(
        parsed.errors,
      )
    ) {
      body =
        parsed.errors
          .map(
            String,
          )
          .join(
            "; ",
          );
    }
  } catch {
    /*
     * Keep original response body.
     */
  }

  return {
    status,

    message:
      body,
  };
}

/*
 * ------------------------------------------------------------
 * Stage helpers
 * ------------------------------------------------------------
 */

/**
 * Return the first stage that starts in the future.
 *
 * The stages returned by OpenSea are not assumed to be
 * sorted.
 */
function findNextStageTime(
  stages:
    | DiscoveryStage[]
    | undefined,
): number | undefined {
  if (
    !stages ||
    stages.length === 0
  ) {
    return undefined;
  }

  const now =
    Math.floor(
      Date.now() / 1000,
    );

  const futureStages =
    stages
      .filter(
        (
          stage,
        ) =>
          typeof stage.startTime ===
            "number" &&
          Number.isFinite(
            stage.startTime,
          ) &&
          stage.startTime >
            now,
      )
      .sort(
        (
          a,
          b,
        ) =>
          (a.startTime ?? 0) -
          (b.startTime ?? 0),
      );

  return (
    futureStages[0]
      ?.startTime
  );
}

/**
 * Find the current stage.
 *
 * Useful for diagnostics and for cases where a stage is
 * currently active but the wallet is not eligible.
 */
function findCurrentStage(
  stages:
    | DiscoveryStage[]
    | undefined,
): DiscoveryStage | undefined {
  if (
    !stages ||
    stages.length === 0
  ) {
    return undefined;
  }

  const now =
    Math.floor(
      Date.now() / 1000,
    );

  return stages.find(
    (
      stage,
    ) => {
      const start =
        stage.startTime;

      const end =
        stage.endTime;

      if (
        typeof start !==
          "number"
      ) {
        return false;
      }

      if (
        typeof end ===
          "number"
      ) {
        return (
          now >= start &&
          now < end
        );
      }

      return (
        now >= start
      );
    },
  );
}

/**
 * Diagnostic only.
 *
 * This intentionally does not run on every poll because
 * mint.ts may call discover() every 250ms during the final
 * FCFS window.
 */
function logStageDiagnostics(
  stages:
    | DiscoveryStage[]
    | undefined,
): void {
  if (
    !stages ||
    stages.length === 0
  ) {
    console.log(
      "[STAGE] OpenSea returned no stage metadata.",
    );

    return;
  }

  const hasTimestamp =
    stages.some(
      (
        stage,
      ) =>
        typeof stage.startTime ===
          "number" ||
        typeof stage.endTime ===
          "number",
    );

  if (!hasTimestamp) {
    console.log(
      "[STAGE] OpenSea returned stages, but no usable timestamps were found.",
    );

    return;
  }

  /*
   * Only print compact information.
   */

  for (
    let index = 0;
    index < stages.length;
    index++
  ) {
    const stage =
      stages[index];

    const label =
      stage.label ??
      `Stage ${index + 1}`;

    const start =
      stage.startTime !==
      undefined
        ? new Date(
            stage.startTime *
              1000,
          ).toISOString()
        : "unknown";

    const end =
      stage.endTime !==
      undefined
        ? new Date(
            stage.endTime *
              1000,
          ).toISOString()
        : "unknown";

    console.log(
      `[STAGE] #${index + 1} ${label} start=${start} end=${end}`,
    );
  }
}

/*
 * ------------------------------------------------------------
 * MintDiscovery
 * ------------------------------------------------------------
 */

export class MintDiscovery {
  constructor(
    private readonly openSea:
      OpenSeaClient,
  ) {}

  /*
   * ----------------------------------------------------------
   * Discover
   * ----------------------------------------------------------
   */

  async discover(
    options: {
      slug: string;

      wallet: Address;

      chainId: number;

      quantity: number;
    },
  ): Promise<MintDiscoveryResult> {
    const {
      slug,
      wallet,
      chainId,
      quantity,
    } =
      options;

    /*
     * --------------------------------------------------------
     * DROP METADATA
     * --------------------------------------------------------
     *
     * Always load drop metadata FIRST.
     *
     * This is critical because the /mint endpoint may return
     * 409/422 without a stage timestamp.
     *
     * /drops/{slug} is therefore our source of truth for
     * stage timing.
     */

    const drop =
      await this.openSea.getDrop(
        slug,
      );

    /*
     * --------------------------------------------------------
     * SUPPLY
     * --------------------------------------------------------
     */

    console.log(
      `Collection: ${slug}`,
    );

    if (
      drop.maxSupply !==
      undefined
    ) {
      console.log(
        `Supply max: ${drop.maxSupply}`,
      );
    }

    if (
      drop.totalSupply !==
        undefined &&
      drop.maxSupply !==
        undefined
    ) {
      const remaining =
        Math.max(
          0,
          drop.maxSupply -
            drop.totalSupply,
        );

      console.log(
        `Supply remaining: ${remaining}`,
      );
    }

    /*
     * --------------------------------------------------------
     * STAGES
     * --------------------------------------------------------
     *
     * At this point timestamps have already been normalized
     * by OpenSeaClient.
     */

    const stages =
      (drop.stages ??
        []) as DiscoveryStage[];

    const nextStageTime =
      findNextStageTime(
        stages,
      );

    /*
     * --------------------------------------------------------
     * Mint request
     * --------------------------------------------------------
     */

    const request:
      BuildMintRequest = {
      minter:
        wallet,

      quantity,
    };

    /*
     * --------------------------------------------------------
     * BUILD MINT TRANSACTION
     * --------------------------------------------------------
     */

    try {
      const result =
        await this.openSea.buildMintTransaction(
          slug,
          request,
        );

      /*
       * ------------------------------------------------------
       * READY
       * ------------------------------------------------------
       */

      const plan:
        MintPlan = {
        chainId,

        wallet,

        quantity,

        to:
          result.to as Address,

        data:
          result.data as Hex,

        value:
          result.value,

        createdAt:
          Date.now(),
      };

      return {
        status:
          "READY",

        plan,
      };
    } catch (
      error
    ) {
      const parsed =
        extractOpenSeaError(
          error,
        );

      const message =
        parsed.message
          .toLowerCase();

      /*
       * ------------------------------------------------------
       * 409 — NOT ACTIVE
       * ------------------------------------------------------
       */

      if (
        parsed.status ===
        409
      ) {
        const isNotActive =
          message.includes(
            "not currently active",
          ) ||
          message.includes(
            "not active",
          );

        if (
          isNotActive
        ) {
          /*
           * Only print stage diagnostics when this is useful.
           *
           * mint.ts controls the polling frequency.
           */

          if (
            nextStageTime ===
            undefined
          ) {
            logStageDiagnostics(
              stages,
            );
          }

          return {
            status:
              "WAIT",

            reason:
              "NOT_ACTIVE",

            message:
              "Drop is not currently active for minting.",

            nextStageTime,
          };
        }
      }

      /*
       * ------------------------------------------------------
       * 422 — NOT ELIGIBLE
       * ------------------------------------------------------
       *
       * This does NOT mean the whole mint is impossible.
       *
       * Example:
       *
       *   Stage 1: Allowlist
       *   Stage 2: Public
       *
       * Wallet is not eligible for Stage 1.
       * We wait for Stage 2.
       */

      if (
        parsed.status ===
        422
      ) {
        const isNotEligible =
          message.includes(
            "not eligible",
          ) ||
          message.includes(
            "wallet is not eligible",
          ) ||
          message.includes(
            "not eligible for the active drop stage",
          );

        if (
          isNotEligible
        ) {
          /*
           * If timestamp is available, mint.ts will sleep
           * until that timestamp instead of polling every
           * 10 seconds.
           */

          if (
            nextStageTime ===
            undefined
          ) {
            logStageDiagnostics(
              stages,
            );
          }

          const currentStage =
            findCurrentStage(
              stages,
            );

          const currentStageName =
            currentStage
              ?.label;

          const waitMessage =
            currentStageName
              ? `Wallet is not eligible for the active "${currentStageName}" stage.`
              : "Wallet is not eligible for the active drop stage.";

          return {
            status:
              "WAIT",

            reason:
              "NOT_ELIGIBLE",

            message:
              waitMessage,

            nextStageTime,
          };
        }
      }

      /*
       * ------------------------------------------------------
       * UNKNOWN
       * ------------------------------------------------------
       *
       * Do not silently convert unrelated API failures into
       * WAIT. Authentication errors, rate limits, malformed
       * responses, etc. should still be visible.
       */

      throw error;
    }
  }
}