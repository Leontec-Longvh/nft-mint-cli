import {
  type Account,
  type Address,
  type Chain,
  type PublicClient,
  createPublicClient,
  createWalletClient,
  http,
} from "viem";

import { OpenSeaClient, type MintStage } from "./opensea.js";
import { broadcastRace, warmUp } from "./broadcast.js";
import { config } from "./config.js";

/*
 * ============================================================
 * V7-A3 SPEED / BEAST MODE
 * ============================================================
 *
 * OBJECTIVE:
 *   Maximum FCFS speed with minimum unnecessary RPC/API calls.
 *
 * CORE RULES:
 *
 * 1. /drops/{slug}
 *      -> fetch ONCE at startup
 *
 * 2. PREP
 *      -> nonce + fee ONCE
 *      -> NEVER re-PREP after phase changes / 409 / 422
 *
 * 3. gas
 *      -> fixed --gas-limit recommended
 *      -> no estimateGas when fixed gas is supplied
 *
 * 4. FUTURE PHASE
 *      -> sleep silently until T-5s
 *
 * 5. T-5s HOT WINDOW
 *      -> aggressive /mint probing
 *
 * 6. 409
 *      -> drop/phase not active yet
 *      -> retry /mint
 *      -> DO NOT refresh /drops
 *      -> DO NOT re-PREP
 *
 * 7. 422
 *      -> ONLY skip the phase if that phase is already ACTIVE
 *
 *      -> if target phase is still FUTURE:
 *           DO NOT blacklist it
 *           because /mint is probing the currently active phase
 *
 * 8. 200
 *      -> calldata obtained
 *      -> sign immediately
 *      -> broadcast to all RPCs
 *
 * 9. No polling logs.
 *      -> one WAIT log
 *      -> one HOT log
 *      -> only meaningful probe events
 *
 * 10. Single-flight probing.
 *      -> never create overlapping /mint requests
 *
 * ============================================================
 */

/*
 * ============================================================
 * TIMING
 * ============================================================
 */

const HOT_WINDOW_MS = 5_000;

// Before T-2s: enough to detect transition without hammering OpenSea.
const PROBE_INTERVAL_NORMAL_MS = 500;

// T-2s -> T-500ms.
const PROBE_INTERVAL_FAST_MS = 250;

// Final 500ms.
const PROBE_INTERVAL_FINAL_MS = 100;

// Small safety delay after a 409.
const RETRY_409_MIN_MS = 80;

/*
 * ============================================================
 * RPC
 * ============================================================
 */

const RPC_TIMEOUT_MS = 5_000;
const RPC_RETRY_COUNT = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function elapsed(startedAt: number): string {
  return `${Math.round(performance.now() - startedAt)}ms`;
}

function log(message: string): void {
  console.log(message);
}

/*
 * ============================================================
 * RPC CLIENTS
 * ============================================================
 */

function createClients(
  chain: Chain,
  rpcUrls: string[],
): PublicClient[] {
  return rpcUrls.map((url) =>
    createPublicClient({
      chain,
      transport: http(url, {
        timeout: RPC_TIMEOUT_MS,
        retryCount: RPC_RETRY_COUNT,
      }),
    }),
  );
}

async function raceAny<T>(
  clients: PublicClient[],
  fn: (client: PublicClient) => Promise<T>,
): Promise<T> {
  if (clients.length === 0) {
    throw new Error("No RPC clients configured.");
  }

  try {
    return await Promise.any(
      clients.map((client) => fn(client)),
    );
  } catch (error) {
    const messages =
      error instanceof AggregateError
        ? error.errors.map((e) =>
            e instanceof Error ? e.message : String(e),
          )
        : [String(error)];

    throw new Error(
      ["All RPCs failed.", ...messages].join("\n"),
    );
  }
}

/*
 * ============================================================
 * PHASE IDENTITY
 * ============================================================
 */

function phaseKey(stage: MintStage): string {
  return [
    stage.label,
    stage.startTime ?? 0,
    stage.endTime ?? 0,
  ].join("|");
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function isActive(
  stage: MintStage,
  currentSec: number,
): boolean {
  if (
    typeof stage.startTime !== "number" ||
    stage.startTime <= 0
  ) {
    return false;
  }

  if (stage.startTime > currentSec) {
    return false;
  }

  if (
    typeof stage.endTime === "number" &&
    stage.endTime <= currentSec
  ) {
    return false;
  }

  return true;
}

function isFuture(
  stage: MintStage,
  currentSec: number,
): boolean {
  return (
    typeof stage.startTime === "number" &&
    stage.startTime > currentSec
  );
}

function isExpired(
  stage: MintStage,
  currentSec: number,
): boolean {
  return (
    typeof stage.endTime === "number" &&
    stage.endTime <= currentSec
  );
}

function sortStages(stages: MintStage[]): MintStage[] {
  return [...stages].sort((a, b) => {
    const aStart = a.startTime ?? Number.MAX_SAFE_INTEGER;
    const bStart = b.startTime ?? Number.MAX_SAFE_INTEGER;

    return aStart - bStart;
  });
}

/*
 * ============================================================
 * PHASE SELECTION
 * ============================================================
 *
 * IMPORTANT:
 *
 * We deliberately DO NOT trust `eligible` here.
 *
 * OpenSea /mint is the actual authority.
 *
 * `eligible === false` from /drops is not enough to discard
 * a future phase because the API may expose stage-level data
 * differently from the mint endpoint.
 *
 * ============================================================
 */

function findNextPhase(
  stages: MintStage[],
  skipped: Set<string>,
): MintStage | undefined {
  const current = nowSec();

  const usable = sortStages(stages).filter((stage) => {
    const key = phaseKey(stage);

    if (skipped.has(key)) {
      return false;
    }

    if (isExpired(stage, current)) {
      return false;
    }

    return true;
  });

  /*
   * If one or more phases are currently active, choose the
   * earliest active one.
   */
  const active = usable.find((stage) =>
    isActive(stage, current),
  );

  if (active) {
    return active;
  }

  /*
   * Otherwise choose the earliest future phase.
   */
  return usable.find((stage) =>
    isFuture(stage, current),
  );
}

/*
 * ============================================================
 * ERROR CLASSIFICATION
 * ============================================================
 *
 * OpenSeaClient currently throws:
 *
 *   OpenSea API 422: {...}
 *   OpenSea API 409: {...}
 *
 * We classify without changing opensea.ts.
 * ============================================================
 */

function errorText(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function getHttpStatus(error: unknown): number | undefined {
  const text = errorText(error);

  const match = text.match(
    /OpenSea API\s+(\d{3})/i,
  );

  if (!match) {
    return undefined;
  }

  return Number(match[1]);
}

function is422(error: unknown): boolean {
  return getHttpStatus(error) === 422;
}

function is409(error: unknown): boolean {
  return getHttpStatus(error) === 409;
}

/*
 * ============================================================
 * FEE PREPARATION
 * ============================================================
 */

type FeeFields =
  | {
      maxFeePerGas: bigint;
      maxPriorityFeePerGas: bigint;
    }
  | {
      gasPrice: bigint;
    };

function applyBuffer(value: bigint): bigint {
  return (
    (value * (100n + BigInt(config.gasBufferPercent))) /
    100n
  );
}

/*
 * PREP IS DONE ONCE.
 *
 * We intentionally do not call this again after 409 / 422.
 */
async function prepareFees(
  clients: PublicClient[],
): Promise<FeeFields> {
  /*
   * Get block + priority + gas price in parallel.
   *
   * If EIP-1559 is supported, use baseFee + priority.
   * Otherwise fall back to legacy gasPrice.
   */
  const [block, priority, gasPrice] = await Promise.all([
    raceAny(clients, (client) =>
      client.getBlock(),
    ),

    raceAny(clients, (client) =>
      client
        .estimateMaxPriorityFeePerGas()
        .catch(() => 1n),
    ).catch(() => 1n),

    raceAny(clients, (client) =>
      client
        .getGasPrice()
        .catch(() => 0n),
    ).catch(() => 0n),
  ]);

  if (block.baseFeePerGas != null) {
    const bufferedBaseFee =
      applyBuffer(block.baseFeePerGas);

    const safePriority =
      priority > 0n ? priority : 1n;

    const bufferedPriority =
      applyBuffer(safePriority);

    return {
      maxFeePerGas:
        bufferedBaseFee + bufferedPriority,
      maxPriorityFeePerGas:
        bufferedPriority,
    };
  }

  if (gasPrice <= 0n) {
    throw new Error(
      "Unable to determine gas price.",
    );
  }

  return {
    gasPrice: applyBuffer(gasPrice),
  };
}

/*
 * ============================================================
 * MINT OPTIONS
 * ============================================================
 */

export interface MintOptions {
  slug: string;
  chainId: number;
  wallet: Address;
  quantity: number;
  confirm: boolean;
  gasLimit?: bigint;
}

export interface MintDependencies {
  openSea: OpenSeaClient;
  account: Account;
  chain: Chain;
  rpcUrls: string[];
}

/*
 * ============================================================
 * MINT PROBE RESULT
 * ============================================================
 */

type ProbeResult =
  | {
      type: "success";
      tx: Awaited<
        ReturnType<OpenSeaClient["buildMintTransaction"]>
      >;
    }
  | {
      type: "not-active";
    }
  | {
      type: "not-eligible";
    };

/*
 * ============================================================
 * SINGLE-FLIGHT PROBE
 * ============================================================
 *
 * We never allow overlapping POST /mint requests.
 *
 * This prevents:
 *
 *   request A
 *   request B
 *   request C
 *   request D
 *
 * all racing each other and potentially creating unnecessary
 * API pressure.
 * ============================================================
 */

let probeInFlight = false;

async function probeMint(
  openSea: OpenSeaClient,
  slug: string,
  wallet: Address,
  quantity: number,
): Promise<ProbeResult> {
  /*
   * This should never normally happen because the caller
   * serializes probes.
   */
  if (probeInFlight) {
    await sleep(10);
  }

  probeInFlight = true;

  try {
    const tx =
      await openSea.buildMintTransaction(
        slug,
        wallet,
        quantity,
      );

    return {
      type: "success",
      tx,
    };
  } catch (error) {
    if (is409(error)) {
      return {
        type: "not-active",
      };
    }

    if (is422(error)) {
      return {
        type: "not-eligible",
      };
    }

    throw error;
  } finally {
    probeInFlight = false;
  }
}

/*
 * ============================================================
 * WAIT UNTIL HOT WINDOW
 * ============================================================
 *
 * NO polling.
 *
 * One log only.
 *
 * We sleep directly until T-5s.
 * ============================================================
 */

async function waitUntilHot(
  stage: MintStage,
): Promise<void> {
  if (
    typeof stage.startTime !== "number" ||
    stage.startTime <= 0
  ) {
    throw new Error(
      `Invalid phase startTime: ${String(stage.startTime)}`,
    );
  }

  const targetMs =
    stage.startTime * 1000;

  while (true) {
    const remaining =
      targetMs - Date.now();

    if (remaining <= HOT_WINDOW_MS) {
      return;
    }

    await sleep(
      remaining - HOT_WINDOW_MS,
    );
  }
}

/*
 * ============================================================
 * AGGRESSIVE HOT PROBE
 * ============================================================
 *
 * We start at T-5s.
 *
 * IMPORTANT:
 *
 * Before the target phase actually starts:
 *
 *   409 -> retry
 *
 *   422 -> DO NOT blacklist the target phase.
 *
 * Because /mint has no phase argument. At T-5 the endpoint
 * may still be evaluating the currently active stage.
 *
 * Once target phase is ACTIVE:
 *
 *   422 -> blacklist ONLY this phase
 *
 *   409 -> retry
 *
 *   200 -> mint
 * ============================================================
 */

async function probeUntilPhaseDecision(
  stage: MintStage,
  openSea: OpenSeaClient,
  slug: string,
  wallet: Address,
  quantity: number,
): Promise<ProbeResult> {
  const targetMs =
    (stage.startTime ?? 0) * 1000;

  let hotLogged = false;

  while (true) {
    const remaining =
      targetMs - Date.now();

    if (!hotLogged) {
      log(
        `[HOT] T-5s — probing "${stage.label}"`,
      );

      hotLogged = true;
    }

    const probeStartedAt =
      performance.now();

    const result =
      await probeMint(
        openSea,
        slug,
        wallet,
        quantity,
      );

    if (result.type === "success") {
      log(
        `[PROBE] OK — mint calldata ready (${elapsed(probeStartedAt)})`,
      );

      return result;
    }

    const now = Date.now();
    const activeNow =
      now >= targetMs;

    /*
     * --------------------------------------------------------
     * 422
     * --------------------------------------------------------
     *
     * FUTURE:
     *   Do NOT skip.
     *
     * ACTIVE:
     *   Skip ONLY this phase.
     * --------------------------------------------------------
     */
    if (result.type === "not-eligible") {
      if (!activeNow) {
        /*
         * The target phase is not active yet.
         *
         * This 422 belongs to the currently active drop state,
         * not necessarily to our target phase.
         */
        await sleep(
          Math.min(
            PROBE_INTERVAL_NORMAL_MS,
            Math.max(20, targetMs - Date.now()),
          ),
        );

        continue;
      }

      log(
        `[PHASE] 422 — wallet NOT eligible for ACTIVE phase "${stage.label}".`,
      );

      return result;
    }

    /*
     * --------------------------------------------------------
     * 409
     * --------------------------------------------------------
     *
     * Never blacklist.
     *
     * Just retry.
     * --------------------------------------------------------
     */

    if (result.type === "not-active") {
      const remainingNow =
        targetMs - Date.now();

      /*
       * If still >2s from target:
       *   500ms interval.
       */
      if (remainingNow > 2_000) {
        await sleep(
          PROBE_INTERVAL_NORMAL_MS,
        );
        continue;
      }

      /*
       * T-2s -> T-500ms:
       *   250ms.
       */
      if (remainingNow > 500) {
        await sleep(
          PROBE_INTERVAL_FAST_MS,
        );
        continue;
      }

      /*
       * Final 500ms:
       *   100ms.
       *
       * If already past target, still retry immediately-ish.
       */
      await sleep(
        RETRY_409_MIN_MS,
      );

      continue;
    }
  }
}

/*
 * ============================================================
 * SIGN + BROADCAST
 * ============================================================
 */

async function signAndBroadcast(
  walletClient: ReturnType<typeof createWalletClient>,
  account: Account,
  chain: Chain,
  mintTx: Awaited<
    ReturnType<OpenSeaClient["buildMintTransaction"]>
  >,
  nonce: number,
  gasLimit: bigint,
  feeData: FeeFields,
  rpcUrls: string[],
): Promise<{
  hash: `0x${string}`;
  rpcUrl: string;
  signMs: number;
  broadcastMs: number;
}> {
  const startedAt =
    performance.now();

  const signedTx =
    await walletClient.signTransaction({
      account,
      chain,
      to: mintTx.to,
      data: mintTx.data,
      value: mintTx.value,
      nonce,
      gas: gasLimit,
      ...feeData,
    });

  const signMs =
    Math.round(
      performance.now() - startedAt,
    );

  const broadcastStartedAt =
    performance.now();

  const result =
    await broadcastRace(
      rpcUrls,
      signedTx,
    );

  const broadcastMs =
    Math.round(
      performance.now() -
        broadcastStartedAt,
    );

  return {
    hash: result.hash,
    rpcUrl: result.rpcUrl,
    signMs,
    broadcastMs,
  };
}

/*
 * ============================================================
 * MAIN
 * ============================================================
 */

export async function runMint(
  options: MintOptions,
  deps: MintDependencies,
): Promise<void> {
  const {
    slug,
    wallet,
    quantity,
    confirm,
    gasLimit: gasLimitOverride,
  } = options;

  const {
    openSea,
    account,
    chain,
    rpcUrls,
  } = deps;

  const runStartedAt =
    performance.now();

  /*
   * ----------------------------------------------------------
   * WALLET CHECK
   * ----------------------------------------------------------
   */

  if (
    account.address.toLowerCase() !==
    wallet.toLowerCase()
  ) {
    throw new Error(
      `Wallet mismatch. --wallet ${wallet} does not match PRIVATE_KEY account ${account.address}`,
    );
  }

  if (rpcUrls.length === 0) {
    throw new Error(
      "No RPC endpoints configured.",
    );
  }

  /*
   * ----------------------------------------------------------
   * CLIENTS
   * ----------------------------------------------------------
   */

  const clients =
    createClients(
      chain,
      rpcUrls,
    );

  const primaryRpc =
    rpcUrls[0];

  const walletClient =
    createWalletClient({
      account,
      chain,
      transport: http(
        primaryRpc,
        {
          timeout:
            RPC_TIMEOUT_MS,
          retryCount: 0,
        },
      ),
    });

  /*
   * Warm connections immediately.
   *
   * This is best-effort and does not block.
   */
  warmUp(rpcUrls);

  /*
   * ----------------------------------------------------------
   * 1. FETCH DROP ONCE
   * ----------------------------------------------------------
   */

  log(
    "[COLLECTION] Fetching drop info + phases...",
  );

  const collectionStartedAt =
    performance.now();

  const drop =
    await openSea.getDrop(
      slug,
    );

  log(
    `[COLLECTION] ${drop.name ?? slug} — ${drop.stages.length} phase(s) (${elapsed(collectionStartedAt)})`,
  );

  if (
    drop.stages.length === 0
  ) {
    throw new Error(
      "Collection has no mint phases.",
    );
  }

  /*
   * ----------------------------------------------------------
   * 2. PREP ONCE
   * ----------------------------------------------------------
   *
   * Nonce + fee are prepared once, in parallel.
   *
   * They are NOT repeated after phase changes.
   * ----------------------------------------------------------
   */

  const prepStartedAt =
    performance.now();

  const [
    nonce,
    feeData,
  ] = await Promise.all([
    raceAny(
      clients,
      (client) =>
        client.getTransactionCount({
          address: wallet,
          blockTag: "pending",
        }),
    ),

    prepareFees(
      clients,
    ),
  ]);

  const feeLog =
    "maxFeePerGas" in feeData
      ? `maxFee=${feeData.maxFeePerGas}`
      : `gasPrice=${feeData.gasPrice}`;

  log(
    `[PREP] Nonce=${nonce} ${feeLog} (${elapsed(prepStartedAt)})`,
  );

  /*
   * ----------------------------------------------------------
   * 3. GAS
   * ----------------------------------------------------------
   *
   * Speed mode strongly prefers a fixed gas limit.
   *
   * If no fixed gas was provided, estimate once.
   *
   * This is BEFORE FCFS hot window, never during T0.
   * ----------------------------------------------------------
   */

  let gasLimit: bigint;

  if (
    gasLimitOverride !== undefined
  ) {
    gasLimit =
      gasLimitOverride;

    log(
      `[GAS] Fixed: ${gasLimit} (estimateGas skipped)`,
    );
  } else {
    /*
     * We need calldata for estimateGas.
     *
     * This is the slow fallback path.
     *
     * For maximum FCFS speed, always use:
     *
     *   --gas-limit <value>
     */
    log(
      "[GAS] No fixed gas-limit supplied — preparing one estimate before FCFS.",
    );

    /*
     * We cannot safely estimate without mint calldata.
     *
     * Probe once now.
     */
    const estimateStartedAt =
      performance.now();

    const estimateTx =
      await openSea.buildMintTransaction(
        slug,
        wallet,
        quantity,
      );

    const estimate =
      await raceAny(
        clients,
        (client) =>
          client.estimateGas({
            account: wallet,
            to: estimateTx.to,
            data: estimateTx.data,
            value: estimateTx.value,
          }),
      );

    gasLimit =
      applyBuffer(estimate);

    log(
      `[GAS] Estimate=${estimate} Limit=${gasLimit} (+${config.gasBufferPercent}%) (${elapsed(estimateStartedAt)})`,
    );
  }

  /*
   * ----------------------------------------------------------
   * DRY RUN
   * ----------------------------------------------------------
   */

  if (!confirm) {
    log("");
    log(
      "DRY RUN — transaction NOT broadcast.",
    );

    log(
      `Tip: use --gas-limit ${gasLimit} --confirm for maximum FCFS speed.`,
    );

    return;
  }

  /*
   * ----------------------------------------------------------
   * 4. PHASE STATE MACHINE
   * ----------------------------------------------------------
   */

  const skipped =
    new Set<string>();

  while (true) {
    const stage =
      findNextPhase(
        drop.stages,
        skipped,
      );

    if (!stage) {
      throw new Error(
        "No remaining mint phase is available.",
      );
    }

    const key =
      phaseKey(stage);

    const current =
      nowSec();

    /*
     * --------------------------------------------------------
     * ACTIVE
     * --------------------------------------------------------
     */

    if (
      isActive(
        stage,
        current,
      )
    ) {
      log(
        `[PHASE] "${stage.label}" is ACTIVE.`,
      );

      /*
       * We are already active.
       *
       * Probe immediately.
       */
      const result =
        await probeMint(
          openSea,
          slug,
          wallet,
          quantity,
        );

      if (
        result.type ===
        "success"
      ) {
        log(
          `[PROBE] ACTIVE phase accepted mint calldata.`,
        );

        /*
         * T0 starts here.
         */
        const t0StartedAt =
          performance.now();

        log(
          "[FCFS] Active mint confirmed — signing and broadcasting immediately.",
        );

        const broadcast =
          await signAndBroadcast(
            walletClient,
            account,
            chain,
            result.tx,
            nonce,
            gasLimit,
            feeData,
            rpcUrls,
          );

        log("");
        log(
          "[SUCCESS] Mint transaction broadcast.",
        );
        log(
          `TX          : ${broadcast.hash}`,
        );
        log(
          `RPC won     : ${broadcast.rpcUrl}`,
        );
        log(
          `Sign        : ${broadcast.signMs}ms`,
        );
        log(
          `Broadcast   : ${broadcast.broadcastMs}ms`,
        );
        log(
          `T0 total    : ${Math.round(
            performance.now() -
              t0StartedAt,
          )}ms`,
        );

        return;
      }

      /*
       * ACTIVE + 422
       *
       * Skip ONLY this active phase.
       */
      if (
        result.type ===
        "not-eligible"
      ) {
        skipped.add(key);

        log(
          `[PHASE] Skipping ACTIVE phase only: ${key}`,
        );

        continue;
      }

      /*
       * ACTIVE + 409
       *
       * It can happen during a transition.
       *
       * Do NOT skip.
       *
       * Enter aggressive probe loop using the same stage.
       */
      if (
        result.type ===
        "not-active"
      ) {
        const hotResult =
          await probeUntilPhaseDecision(
            stage,
            openSea,
            slug,
            wallet,
            quantity,
          );

        if (
          hotResult.type ===
          "success"
        ) {
          const t0StartedAt =
            performance.now();

          log(
            "[FCFS] Mint calldata accepted — signing and broadcasting immediately.",
          );

          const broadcast =
            await signAndBroadcast(
              walletClient,
              account,
              chain,
              hotResult.tx,
              nonce,
              gasLimit,
              feeData,
              rpcUrls,
            );

          log("");
          log(
            "[SUCCESS] Mint transaction broadcast.",
          );
          log(
            `TX          : ${broadcast.hash}`,
          );
          log(
            `RPC won     : ${broadcast.rpcUrl}`,
          );
          log(
            `Sign        : ${broadcast.signMs}ms`,
          );
          log(
            `Broadcast   : ${broadcast.broadcastMs}ms`,
          );
          log(
            `T0 total    : ${Math.round(
              performance.now() -
                t0StartedAt,
            )}ms`,
          );

          return;
        }

        /*
         * If it became active and returned 422,
         * skip ONLY this phase.
         */
        skipped.add(key);

        log(
          `[PHASE] Skipping ACTIVE phase only: ${key}`,
        );

        continue;
      }
    }

    /*
     * --------------------------------------------------------
     * FUTURE
     * --------------------------------------------------------
     */

    if (
      isFuture(
        stage,
        current,
      )
    ) {
      const startMs =
        (stage.startTime ?? 0) *
        1000;

      const remainingSec =
        Math.max(
          0,
          Math.ceil(
            (startMs -
              Date.now()) /
              1000,
          ),
        );

      log(
        `[PHASE] "${stage.label}" is FUTURE — waiting.`,
      );

      log(
        `[WAIT] ${stage.label} starts in ${remainingSec}s`,
      );

      /*
       * ------------------------------------------------------
       * Sleep directly until T-5s.
       * ------------------------------------------------------
       */

      await waitUntilHot(
        stage,
      );

      /*
       * Warm all RPC connections during hot window.
       */
      warmUp(rpcUrls);

      /*
       * ------------------------------------------------------
       * Aggressive probe.
       * ------------------------------------------------------
       */

      const result =
        await probeUntilPhaseDecision(
          stage,
          openSea,
          slug,
          wallet,
          quantity,
        );

      /*
       * ------------------------------------------------------
       * SUCCESS
       * ------------------------------------------------------
       */

      if (
        result.type ===
        "success"
      ) {
        const t0StartedAt =
          performance.now();

        log(
          "[FCFS] Mint calldata accepted — signing and broadcasting immediately.",
        );

        const broadcast =
          await signAndBroadcast(
            walletClient,
            account,
            chain,
            result.tx,
            nonce,
            gasLimit,
            feeData,
            rpcUrls,
          );

        log("");
        log(
          "[SUCCESS] Mint transaction broadcast.",
        );
        log(
          `TX          : ${broadcast.hash}`,
        );
        log(
          `RPC won     : ${broadcast.rpcUrl}`,
        );
        log(
          `Sign        : ${broadcast.signMs}ms`,
        );
        log(
          `Broadcast   : ${broadcast.broadcastMs}ms`,
        );
        log(
          `T0 total    : ${Math.round(
            performance.now() -
              t0StartedAt,
          )}ms`,
        );

        return;
      }

      /*
       * ------------------------------------------------------
       * 422 AFTER TARGET PHASE IS ACTIVE
       *
       * This is now a legitimate eligibility failure for
       * this phase.
       * ------------------------------------------------------
       */

      if (
        result.type ===
        "not-eligible"
      ) {
        skipped.add(key);

        log(
          `[PHASE] Skipping ACTIVE phase only: ${key}`,
        );

        continue;
      }

      /*
       * A 409 loop normally doesn't return.
       *
       * If it somehow does, simply retry same phase.
       */
      continue;
    }

    /*
     * --------------------------------------------------------
     * EXPIRED / UNKNOWN
     * --------------------------------------------------------
     */

    skipped.add(key);
  }
}

/*
 * ============================================================
 * END
 * ============================================================
 */