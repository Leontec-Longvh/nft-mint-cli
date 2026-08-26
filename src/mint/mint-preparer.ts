import type {
  Address,
  Hex,
  PublicClient,
} from "viem";

import type {
  OpenSeaClient,
} from "../opensea/client.js";

/*
 * ============================================================
 * TYPES
 * ============================================================
 */

export interface PreparedMintPlan {
  version: 1;

  slug: string;

  chainId: number;

  wallet: Address;

  quantity: number;

  to: Address;

  data: Hex;

  value: bigint;

  gasLimit: bigint;

  gasEstimate: bigint;

  gasMultiplierBps: bigint;

  stageName?: string;

  stageStartTime?: number;

  stageEndTime?: number;

  preparedAt: number;

  calldataExpiresAt?: number;
}

/*
 * ============================================================
 * STAGE TYPES
 * ============================================================
 *
 * Keep this structural.
 *
 * OpenSea response shape may differ between drops/chains.
 */

interface MintStage {
  label?: string;

  startTime?: number;

  endTime?: number;

  eligible?: boolean;

  isEligible?: boolean;

  walletEligible?: boolean;

  [key: string]: unknown;
}

interface ResolvedStage {
  stage: MintStage;

  active: boolean;

  eligible: boolean;

  waitRequired: boolean;
}

/*
 * ============================================================
 * CONSTANTS
 * ============================================================
 */

const GAS_MULTIPLIER_BPS =
  120n;

const LONG_WAIT_BUFFER_MS =
  10_000;

const NEAR_STAGE_POLL_MS =
  1_000;

const FINAL_STAGE_WINDOW_MS =
  5_000;

const FINAL_STAGE_POLL_MS =
  250;

/*
 * Discovery retry.
 *
 * 409 / 422 can happen exactly around the phase boundary.
 *
 * We do NOT immediately fail.
 */

const DISCOVERY_RETRY_MS =
  250;

const MAX_DISCOVERY_RETRIES =
  20;

/*
 * ============================================================
 * SLEEP
 * ============================================================
 */

function sleep(
  milliseconds: number,
): Promise<void> {
  return new Promise(
    (resolve) => {
      setTimeout(
        resolve,
        milliseconds,
      );
    },
  );
}

/*
 * ============================================================
 * ERROR HELPERS
 * ============================================================
 */

function getErrorMessage(
  error: unknown,
): string {
  if (
    error instanceof Error
  ) {
    return error.message;
  }

  return String(error);
}

function getOpenSeaStatus(
  error: unknown,
): number | undefined {
  /*
   * OpenSeaClient may expose statusCode,
   * response.status, status, etc.
   *
   * Keep this defensive.
   */

  if (
    error === null ||
    typeof error !== "object"
  ) {
    return undefined;
  }

  const value =
    error as Record<
      string,
      unknown
    >;

  if (
    typeof value.statusCode ===
    "number"
  ) {
    return value.statusCode;
  }

  if (
    typeof value.status ===
    "number"
  ) {
    return value.status;
  }

  const response =
    value.response;

  if (
    response !== null &&
    typeof response === "object"
  ) {
    const responseObject =
      response as Record<
        string,
        unknown
      >;

    if (
      typeof responseObject.status ===
      "number"
    ) {
      return responseObject.status;
    }
  }

  const message =
    getErrorMessage(
      error,
    );

  const match =
    message.match(
      /OpenSea API\s+(\d{3})/i,
    );

  if (
    match
  ) {
    return Number(
      match[1],
    );
  }

  return undefined;
}

function isPhaseNotReadyError(
  error: unknown,
): boolean {
  const status =
    getOpenSeaStatus(
      error,
    );

  if (
    status === 409 ||
    status === 422
  ) {
    return true;
  }

  const message =
    getErrorMessage(
      error,
    ).toLowerCase();

  return (
    message.includes(
      "not currently active",
    ) ||
    message.includes(
      "not active for minting",
    ) ||
    message.includes(
      "mint is not active",
    ) ||
    message.includes(
      "phase is not active",
    ) ||
    message.includes(
      "stage is not active",
    ) ||
    message.includes(
      "not eligible",
    )
  );
}

/*
 * ============================================================
 * STAGE HELPERS
 * ============================================================
 */

function isStageActive(
  stage: MintStage,
): boolean {
  const now =
    Math.floor(
      Date.now() / 1000,
    );

  if (
    typeof stage.startTime !==
    "number"
  ) {
    return false;
  }

  if (
    stage.startTime >
    now
  ) {
    return false;
  }

  if (
    typeof stage.endTime ===
      "number" &&
    stage.endTime <= now
  ) {
    return false;
  }

  return true;
}

/*
 * ============================================================
 * ELIGIBILITY
 * ============================================================
 *
 * IMPORTANT:
 *
 * Never do:
 *
 *   something.toLowerCase()
 *
 * unless we have verified that something is a string.
 */

function isStageEligible(
  stage: MintStage,
): boolean {
  if (
    typeof stage.walletEligible ===
    "boolean"
  ) {
    return stage.walletEligible;
  }

  if (
    typeof stage.isEligible ===
    "boolean"
  ) {
    return stage.isEligible;
  }

  if (
    typeof stage.eligible ===
    "boolean"
  ) {
    return stage.eligible;
  }

  /*
   * OpenSea does not always expose wallet eligibility
   * directly in the stage object.
   *
   * In that case we assume the phase may be usable.
   *
   * buildMintTransaction() is the final authority.
   */

  return true;
}

/*
 * ============================================================
 * RESOLVE BEST STAGE
 * ============================================================
 *
 * RULE:
 *
 * 1. Active + eligible
 *       -> USE NOW
 *
 * 2. Active but explicitly not eligible
 *       -> next eligible future stage
 *
 * 3. No active eligible phase
 *       -> wait for next eligible phase
 */

function resolveBestStage(
  stages:
    | MintStage[]
    | undefined,
): ResolvedStage {
  if (
    !Array.isArray(stages) ||
    stages.length === 0
  ) {
    throw new Error(
      "OpenSea drop has no mint phases.",
    );
  }

  /*
   * ----------------------------------------------------------
   * ACTIVE + ELIGIBLE
   * ----------------------------------------------------------
   */

  const activeEligible =
    stages.find(
      (
        stage,
      ) =>
        isStageActive(stage) &&
        isStageEligible(stage),
    );

  if (
    activeEligible
  ) {
    console.log("");

    console.log(
      "[PREPARER] Active eligible phase resolved.",
    );

    printStage(
      "[PREPARER]",
      activeEligible,
    );

    console.log(
      "[PREPARER] Wallet may mint during this phase.",
    );

    console.log(
      "[PREPARER] No phase wait required.",
    );

    return {
      stage:
        activeEligible,

      active:
        true,

      eligible:
        true,

      waitRequired:
        false,
    };
  }

  /*
   * ----------------------------------------------------------
   * FUTURE + ELIGIBLE
   * ----------------------------------------------------------
   */

  const now =
    Math.floor(
      Date.now() / 1000,
    );

  const futureEligible =
    stages
      .filter(
        (
          stage,
        ) =>
          typeof stage.startTime ===
            "number" &&
          stage.startTime > now &&
          isStageEligible(stage),
      )
      .sort(
        (
          a,
          b,
        ) =>
          (
            a.startTime ??
            0
          ) -
          (
            b.startTime ??
            0
          ),
      )[0];

  if (
    futureEligible
  ) {
    console.log("");

    console.log(
      "[PREPARER] No active eligible phase.",
    );

    console.log(
      "[PREPARER] Next eligible phase resolved.",
    );

    printStage(
      "[PREPARER]",
      futureEligible,
    );

    return {
      stage:
        futureEligible,

      active:
        false,

      eligible:
        true,

      waitRequired:
        true,
    };
  }

  throw new Error(
    "No active or future eligible mint phase found.",
  );
}

/*
 * ============================================================
 * PRINT STAGE
 * ============================================================
 */

function printStage(
  prefix: string,
  stage: MintStage,
): void {
  console.log(
    `${prefix} Phase: ${
      typeof stage.label ===
      "string"
        ? stage.label
        : "unknown"
    }`,
  );

  if (
    typeof stage.startTime ===
    "number"
  ) {
    console.log(
      `${prefix} Start: ${new Date(
        stage.startTime * 1000,
      ).toLocaleString()}`,
    );
  }

  if (
    typeof stage.endTime ===
    "number"
  ) {
    console.log(
      `${prefix} End: ${new Date(
        stage.endTime * 1000,
      ).toLocaleString()}`,
    );
  }
}

/*
 * ============================================================
 * FORMAT DURATION
 * ============================================================
 */

function formatDuration(
  milliseconds: number,
): string {
  const totalSeconds =
    Math.max(
      0,
      Math.floor(
        milliseconds / 1000,
      ),
    );

  const hours =
    Math.floor(
      totalSeconds / 3600,
    );

  const minutes =
    Math.floor(
      (
        totalSeconds % 3600
      ) / 60,
    );

  const seconds =
    totalSeconds % 60;

  if (
    hours > 0
  ) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }

  if (
    minutes > 0
  ) {
    return `${minutes}m ${seconds}s`;
  }

  return `${seconds}s`;
}

/*
 * ============================================================
 * WAIT UNTIL STAGE
 * ============================================================
 *
 * EXACT FLOW:
 *
 *   Future stage
 *
 *       ↓
 *
 *   Sleep until T-10s
 *
 *       ↓
 *
 *   1 second polling
 *
 *       ↓
 *
 *   T-5s
 *
 *       ↓
 *
 *   250ms polling
 *
 *       ↓
 *
 *   Discovery
 */

async function waitUntilStage(
  stage: MintStage,
): Promise<void> {
  const startTime =
    stage.startTime;

  if (
    typeof startTime !==
    "number" ||
    !Number.isFinite(startTime) ||
    startTime <= 0
  ) {
    throw new Error(
      `Invalid phase startTime: ${String(
        startTime,
      )}`,
    );
  }

  const targetMs =
    startTime * 1000;

  console.log("");

  console.log(
    "========================================",
  );

  console.log(
    "[WAIT] NEXT PHASE",
  );

  console.log(
    `[WAIT] Phase: ${
      typeof stage.label ===
      "string"
        ? stage.label
        : "unknown"
    }`,
  );

  console.log(
    `[WAIT] Start: ${new Date(
      targetMs,
    ).toLocaleString()}`,
  );

  if (
    typeof stage.endTime ===
    "number"
  ) {
    console.log(
      `[WAIT] End: ${new Date(
        stage.endTime * 1000,
      ).toLocaleString()}`,
    );
  }

  console.log(
    "========================================",
  );

  console.log("");

  console.log(
    `Next stage: ${new Date(
      targetMs,
    ).toLocaleString()}`,
  );

  while (true) {
    const remaining =
      targetMs -
      Date.now();

    /*
     * ========================================================
     * STAGE REACHED
     * ========================================================
     */

    if (
      remaining <= 0
    ) {
      console.log("");

      console.log(
        "[WAIT] Stage time reached.",
      );

      console.log(
        "[DISCOVERY] Starting immediately.",
      );

      return;
    }

    /*
     * ========================================================
     * MORE THAN T-10s
     * ========================================================
     */

    if (
      remaining >
      LONG_WAIT_BUFFER_MS
    ) {
      console.log(
        `${formatDuration(
          remaining,
        )} until stage`,
      );

      console.log(
        "Sleeping until T-10s...",
      );

      await sleep(
        remaining -
          LONG_WAIT_BUFFER_MS,
      );

      continue;
    }

    /*
     * ========================================================
     * T-10s → T-5s
     * ========================================================
     */

    if (
      remaining >
      FINAL_STAGE_WINDOW_MS
    ) {
      console.log("");

      console.log(
        `[WAIT] T-${Math.ceil(
          remaining / 1000,
        )}s`,
      );

      console.log(
        "[WAIT] 1s polling...",
      );

      await sleep(
        Math.min(
          NEAR_STAGE_POLL_MS,
          remaining,
        ),
      );

      continue;
    }

    /*
     * ========================================================
     * T-5s → T
     * ========================================================
     */

    console.log("");

    console.log(
      `[WAIT] T-${remaining}ms`,
    );

    console.log(
      "[WAIT] 250ms polling...",
    );

    while (true) {
      const finalRemaining =
        targetMs -
        Date.now();

      if (
        finalRemaining <= 0
      ) {
        console.log("");

        console.log(
          "[WAIT] Stage reached.",
        );

        console.log(
          "[DISCOVERY] OK",
        );

        return;
      }

      await sleep(
        Math.min(
          FINAL_STAGE_POLL_MS,
          finalRemaining,
        ),
      );
    }
  }
}

/*
 * ============================================================
 * CALldata EXPIRY
 * ============================================================
 */

function getCalldataExpiry(
  stage: MintStage,
): number {
  if (
    typeof stage.endTime ===
    "number" &&
    Number.isFinite(
      stage.endTime,
    )
  ) {
    return stage.endTime;
  }

  /*
   * No stage end supplied.
   *
   * Give calldata a short lifetime.
   */

  return (
    Math.floor(
      Date.now() / 1000,
    ) + 300
  );
}

/*
 * ============================================================
 * MINT PREPARER
 * ============================================================
 */

export class MintPreparer {
  constructor(
    private readonly openSea:
      OpenSeaClient,

    private readonly publicClient:
      PublicClient,
  ) {}

  /*
   * ==========================================================
   * PREPARE
   * ==========================================================
   *
   * NO FILE.
   *
   * Everything remains in memory.
   */

  async prepare(
    options: {
      slug: string;

      wallet: Address;

      chainId: number;

      quantity: number;
    },
  ): Promise<PreparedMintPlan> {
    const {
      slug,
      wallet,
      chainId,
      quantity,
    } = options;

    /*
     * ========================================================
     * VALIDATION
     * ========================================================
     */

    if (
      typeof slug !==
        "string" ||
      slug.trim().length ===
        0
    ) {
      throw new Error(
        "MintPreparer: invalid slug.",
      );
    }

    if (
      typeof wallet !==
        "string" ||
      !wallet.startsWith("0x")
    ) {
      throw new Error(
        `MintPreparer: invalid wallet: ${String(
          wallet,
        )}`,
      );
    }

    if (
      !Number.isInteger(
        chainId,
      ) ||
      chainId <= 0
    ) {
      throw new Error(
        `MintPreparer: invalid chainId: ${chainId}`,
      );
    }

    if (
      !Number.isInteger(
        quantity,
      ) ||
      quantity <= 0
    ) {
      throw new Error(
        `MintPreparer: invalid quantity: ${quantity}`,
      );
    }

    /*
     * ========================================================
     * LOAD DROP
     * ========================================================
     */

    console.log("");

    console.log(
      "[FLOW] Starting MintPreparer...",
    );

    console.log("");

    console.log(
      "[PREPARER] Loading OpenSea drop...",
    );

    const drop =
      await this.openSea.getDrop(
        slug,
      );

    /*
     * ========================================================
     * PHASE RESOLUTION
     * ========================================================
     */

    const stages =
      Array.isArray(
        drop.stages,
      )
        ? (
            drop.stages as unknown[]
          ).filter(
            (
              value,
            ): value is MintStage =>
              value !== null &&
              typeof value ===
                "object",
          )
        : [];

    const resolved =
      resolveBestStage(
        stages,
      );

    let stage =
      resolved.stage;

    /*
     * ========================================================
     * WAIT
     * ========================================================
     *
     * IMPORTANT:
     *
     * If active + eligible:
     *
     *     DO NOT WAIT.
     *
     * If future:
     *
     *     T-10s
     *     ↓
     *     1s
     *     ↓
     *     T-5s
     *     ↓
     *     250ms
     *     ↓
     *     Discovery
     */

    if (
      resolved.waitRequired
    ) {
      await waitUntilStage(
        stage,
      );
    } else {
      console.log("");

      console.log(
        "[WAIT] Current phase is active.",
      );

      console.log(
        "[WAIT] Wallet eligible.",
      );

      console.log(
        "[WAIT] No waiting required.",
      );
    }

    /*
     * ========================================================
     * DISCOVERY
     * ========================================================
     *
     * This is where OpenSea becomes the final authority.
     *
     * 409 / 422 can happen at the exact boundary.
     *
     * Retry briefly instead of crashing immediately.
     */

    console.log("");

    console.log(
      "[PREPARER] Building mint transaction...",
    );

    let mint:
      Awaited<
        ReturnType<
          OpenSeaClient[
            "buildMintTransaction"
          >
        >
      >;

    let lastError:
      unknown;

    for (
      let attempt = 1;
      attempt <=
        MAX_DISCOVERY_RETRIES;
      attempt++
    ) {
      try {
        mint =
          await this.openSea.buildMintTransaction(
            slug,
            {
              minter:
                wallet,

              quantity,
            },
          );

        /*
         * Discovery succeeded.
         */

        console.log("");

        console.log(
          "[DISCOVERY] OK",
        );

        break;
      } catch (
        error
      ) {
        lastError =
          error;

        const retryable =
          isPhaseNotReadyError(
            error,
          );

        if (
          !retryable
        ) {
          throw error;
        }

        console.log("");

        console.log(
          `[DISCOVERY] Phase not ready yet (${attempt}/${MAX_DISCOVERY_RETRIES}).`,
        );

        console.log(
          "[DISCOVERY] OpenSea returned 409/422 or phase-not-ready.",
        );

        /*
         * Refresh the drop/phase information.
         *
         * This is important because a future phase can have
         * become active while we were waiting.
         */

        if (
          attempt <
          MAX_DISCOVERY_RETRIES
        ) {
          await sleep(
            DISCOVERY_RETRY_MS,
          );

          try {
            const refreshedDrop =
              await this.openSea.getDrop(
                slug,
              );

            const refreshedStages =
              Array.isArray(
                refreshedDrop.stages,
              )
                ? (
                    refreshedDrop.stages as unknown[]
                  ).filter(
                    (
                      value,
                    ): value is MintStage =>
                      value !== null &&
                      typeof value ===
                        "object",
                  )
                : [];

            /*
             * If another active eligible phase is now
             * available, use it.
             */

            const refreshed =
              resolveBestStage(
                refreshedStages,
              );

            stage =
              refreshed.stage;

            if (
              refreshed.active &&
              refreshed.eligible
            ) {
              console.log(
                "[DISCOVERY] Active phase confirmed.",
              );
            }
          } catch {
            /*
             * Ignore refresh errors.
             *
             * Continue retrying the actual discovery.
             */
          }
        }
      }
    }

    /*
     * TypeScript narrowing:
     *
     * If all discovery attempts failed, throw the last
     * meaningful error.
     */

    if (
      mint ===
      undefined
    ) {
      throw (
        lastError ??
        new Error(
          "Unable to build mint transaction.",
        )
      );
    }

    /*
     * ========================================================
     * TRANSACTION VALIDATION
     * ========================================================
     */

    if (
      !mint.to ||
      typeof mint.to !==
        "string" ||
      !mint.to.startsWith(
        "0x",
      )
    ) {
      throw new Error(
        `OpenSea returned invalid mint target: ${String(
          mint.to,
        )}`,
      );
    }

    if (
      !mint.data ||
      typeof mint.data !==
        "string" ||
      !mint.data.startsWith(
        "0x",
      )
    ) {
      throw new Error(
        "OpenSea returned invalid mint calldata.",
      );
    }

    if (
      typeof mint.value !==
      "bigint"
    ) {
      throw new Error(
        `OpenSea returned invalid transaction value: ${String(
          mint.value,
        )}`,
      );
    }

    /*
     * ========================================================
     * ESTIMATE GAS — ONCE
     * ========================================================
     */

    console.log("");

    console.log(
      "[PREPARER] Estimating gas...",
    );

    const gasEstimate =
      await this.publicClient.estimateGas({
        account:
          wallet,

        to:
          mint.to,

        data:
          mint.data,

        value:
          mint.value,
      });

    if (
      gasEstimate <=
      0n
    ) {
      throw new Error(
        `Invalid gas estimate: ${gasEstimate}`,
      );
    }

    /*
     * +20%
     *
     * 120 / 100
     */

    const gasLimit =
      (
        gasEstimate *
        GAS_MULTIPLIER_BPS
      ) /
      100n;

    console.log(
      `[PREPARER] Gas estimate: ${gasEstimate}`,
    );

    console.log(
      `[PREPARER] Gas limit (+20%): ${gasLimit}`,
    );

    /*
     * ========================================================
     * CALLDATA EXPIRY
     * ========================================================
     */

    const calldataExpiresAt =
      getCalldataExpiry(
        stage,
      );

    /*
     * ========================================================
     * PREPARED PLAN
     * ========================================================
     *
     * IMPORTANT:
     *
     * NO writeFile().
     * NO mkdir().
     * NO JSON file.
     *
     * Returned directly to mint.ts.
     */

    const prepared:
      PreparedMintPlan = {
      version:
        1,

      slug,

      chainId,

      wallet,

      quantity,

      to:
        mint.to,

      data:
        mint.data,

      value:
        mint.value,

      gasLimit,

      gasEstimate,

      gasMultiplierBps:
        GAS_MULTIPLIER_BPS,

      stageName:
        typeof stage.label ===
        "string"
          ? stage.label
          : undefined,

      stageStartTime:
        typeof stage.startTime ===
        "number"
          ? stage.startTime
          : undefined,

      stageEndTime:
        typeof stage.endTime ===
        "number"
          ? stage.endTime
          : undefined,

      preparedAt:
        Date.now(),

      calldataExpiresAt,
    };

    /*
     * ========================================================
     * READY
     * ========================================================
     */

    console.log("");

    console.log(
      "========================================",
    );

    console.log(
      "[PREPARER] READY",
    );

    console.log(
      `[PREPARER] Phase: ${
        typeof stage.label ===
        "string"
          ? stage.label
          : "unknown"
      }`,
    );

    console.log(
      `[PREPARER] Target: ${prepared.to}`,
    );

    console.log(
      `[PREPARER] Value: ${prepared.value}`,
    );

    console.log(
      `[PREPARER] Gas estimate: ${prepared.gasEstimate}`,
    );

    console.log(
      `[PREPARER] Gas limit: ${prepared.gasLimit}`,
    );

    console.log(
      "[PREPARER] Plan: IN MEMORY",
    );

    console.log(
      "========================================",
    );

    return prepared;
  }
}
