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

function elapsed(startedAt: number): string {
  return `${Math.round(performance.now() - startedAt)}ms`;
}

/*
 * ============================================================
 * RPC RESILIENCE
 * ============================================================
 *
 * A single flaky/slow RPC must never hard-fail the whole run.
 * Every read call (nonce, fee data, gas estimate) is raced across
 * ALL configured RPCs — same idea already used for broadcasting.
 * Whichever RPC answers first wins; the others are ignored.
 */
const RPC_TIMEOUT_MS = 8_000;
const RPC_RETRY_COUNT = 2;
const RPC_RETRY_DELAY_MS = 200;

function createClients(chain: Chain, rpcUrls: string[]): PublicClient[] {
  return rpcUrls.map((url) =>
    createPublicClient({
      chain,
      transport: http(url, {
        timeout: RPC_TIMEOUT_MS,
        retryCount: RPC_RETRY_COUNT,
        retryDelay: RPC_RETRY_DELAY_MS,
      }),
    }),
  );
}

async function raceAny<T>(clients: PublicClient[], fn: (client: PublicClient) => Promise<T>): Promise<T> {
  try {
    return await Promise.any(clients.map((client) => fn(client)));
  } catch (error) {
    const messages =
      error instanceof AggregateError
        ? error.errors.map((e) => (e instanceof Error ? e.message : String(e)))
        : [String(error)];
    throw new Error(["All RPCs failed for this call.", ...messages].join("\n"));
  }
}

/*
 * ============================================================
 * TIMING CONSTANTS — exact schedule requested:
 *
 *   FUTURE PHASE
 *     -> sleep in bulk until T-5s
 *     -> poll every 1s until T-1s
 *     -> poll every 250ms until T-0
 *     -> single Discovery call
 * ============================================================
 */
const POLL_1S_WINDOW_MS = 5_000; // switch to 1s polling at T-5s
const POLL_250MS_WINDOW_MS = 1_000; // switch to 250ms polling at T-1s
const POLL_1S_INTERVAL_MS = 1_000;
const POLL_250MS_INTERVAL_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(message: string): void {
  console.log(message);
}

/*
 * ============================================================
 * PHASE RESOLUTION
 * ============================================================
 */

function isActive(stage: MintStage, nowSec: number): boolean {
  if (typeof stage.startTime !== "number" || stage.startTime > nowSec) return false;
  if (typeof stage.endTime === "number" && stage.endTime <= nowSec) return false;
  return true;
}

function isEligible(stage: MintStage): boolean {
  // Unknown eligibility is treated as "may be usable"; buildMintTransaction
  // is the final authority and will reject the wallet if it truly can't mint.
  return stage.eligible ?? true;
}

export interface ResolvedPhase {
  stage: MintStage;
  readyNow: boolean;
}

/**
 * ACTIVE + ELIGIBLE -> mint immediately.
 * Otherwise -> earliest eligible future phase (wallet will wait for it).
 */
export function resolvePhase(stages: MintStage[]): ResolvedPhase {
  if (stages.length === 0) {
    throw new Error("Collection has no mint phases.");
  }

  const nowSec = Math.floor(Date.now() / 1000);

  const activeEligible = stages.find((s) => isActive(s, nowSec) && isEligible(s));
  if (activeEligible) {
    return { stage: activeEligible, readyNow: true };
  }

  const futureEligible = stages
    .filter((s) => typeof s.startTime === "number" && s.startTime > nowSec && isEligible(s))
    .sort((a, b) => (a.startTime ?? 0) - (b.startTime ?? 0))[0];

  if (futureEligible) {
    return { stage: futureEligible, readyNow: false };
  }

  throw new Error(
    "Wallet is not eligible for the active phase and no eligible future phase was found.",
  );
}

/*
 * ============================================================
 * WAIT / POLL SCHEDULE
 * ============================================================
 */

export async function waitForPhaseStart(stage: MintStage, rpcUrls: string[]): Promise<void> {
  const startTime = stage.startTime;
  if (typeof startTime !== "number" || startTime <= 0) {
    throw new Error(`Invalid phase startTime: ${String(startTime)}`);
  }

  const targetMs = startTime * 1000;

  log("");
  log(`[WAIT] Next phase "${stage.label}" starts at ${new Date(targetMs).toLocaleString()}`);

  // Phase 1: bulk sleep until T-5s
  while (true) {
    const remaining = targetMs - Date.now();
    if (remaining <= POLL_1S_WINDOW_MS) break;
    log(`[WAIT] Sleeping until T-5s (${Math.ceil((remaining - POLL_1S_WINDOW_MS) / 1000)}s)...`);
    await sleep(remaining - POLL_1S_WINDOW_MS);
  }

  // Entering the final window: warm up RPC connections now so the TCP/TLS
  // handshake is already done by the time we broadcast at T-0.
  warmUp(rpcUrls);

  // Phase 2: poll every 1s until T-1s
  while (true) {
    const remaining = targetMs - Date.now();
    if (remaining <= POLL_250MS_WINDOW_MS) break;
    log(`[WAIT] T-${Math.ceil(remaining / 1000)}s — polling every 1s`);
    await sleep(Math.min(POLL_1S_INTERVAL_MS, remaining - POLL_250MS_WINDOW_MS));
  }

  // Phase 3: poll every 250ms until phase start
  while (true) {
    const remaining = targetMs - Date.now();
    if (remaining <= 0) break;
    log(`[WAIT] T-${remaining}ms — polling every 250ms`);
    await sleep(Math.min(POLL_250MS_INTERVAL_MS, remaining));
  }

  log("[WAIT] Phase reached. Running discovery...");
}

/*
 * ============================================================
 * MINT FLOW
 * ============================================================
 */

export interface MintOptions {
  slug: string;
  chainId: number;
  wallet: Address;
  quantity: number;
  confirm: boolean;
  /** Skip estimateGas() and use this value directly (biggest latency win). */
  gasLimit?: bigint;
}

export interface MintDependencies {
  openSea: OpenSeaClient;
  account: Account;
  chain: Chain;
  rpcUrls: string[];
}

export async function runMint(options: MintOptions, deps: MintDependencies): Promise<void> {
  const { slug, wallet, quantity, confirm, gasLimit: gasLimitOverride } = options;
  const { openSea, account, chain, rpcUrls } = deps;
  const runStartedAt = performance.now();

  if (account.address.toLowerCase() !== wallet.toLowerCase()) {
    throw new Error(
      `Wallet mismatch. --wallet ${wallet} does not match PRIVATE_KEY account ${account.address}`,
    );
  }

  const primaryRpc = rpcUrls[0];
  const clients = createClients(chain, rpcUrls);
  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(primaryRpc, { timeout: RPC_TIMEOUT_MS, retryCount: RPC_RETRY_COUNT }),
  });

  // Pre-open TCP/TLS connections to every RPC right away, in parallel with
  // the OpenSea call below. Costs nothing and removes handshake latency
  // from the critical path further down.
  warmUp(rpcUrls);

  /*
   * ----------------------------------------------------------
   * 1. Fetch collection info + phases
   * ----------------------------------------------------------
   */
  log("[COLLECTION] Fetching drop info + phases...");
  const drop = await openSea.getDrop(slug);
  log(`[COLLECTION] ${drop.name ?? slug} — ${drop.stages.length} phase(s) (${elapsed(runStartedAt)})`);

  const resolved = resolvePhase(drop.stages);

  if (resolved.readyNow) {
    log(`[PHASE] "${resolved.stage.label}" is ACTIVE and wallet is ELIGIBLE — minting now.`);
  } else {
    await waitForPhaseStart(resolved.stage, rpcUrls);
  }

  /*
   * ----------------------------------------------------------
   * 2. Discovery (once) + nonce/fee prep IN PARALLEL
   *    (nonce/fee don't depend on the mint calldata, so we
   *    fetch them at the same time instead of after)
   * ----------------------------------------------------------
   */
  const criticalPathStartedAt = performance.now();

  const [mintTx, nonce, feeData] = await Promise.all([
    openSea.buildMintTransaction(slug, wallet, quantity),
    raceAny(clients, (c) => c.getTransactionCount({ address: wallet, blockTag: "pending" })),
    prepareFees(clients),
  ]);
  log(`[DISCOVERY] OK — mint calldata built. (${elapsed(criticalPathStartedAt)})`);

  /*
   * ----------------------------------------------------------
   * 3. Gas limit: use override if provided (skips a network
   *    round-trip), otherwise estimate once.
   * ----------------------------------------------------------
   */
  let gasLimit: bigint;
  if (gasLimitOverride !== undefined) {
    gasLimit = gasLimitOverride;
    log(`[GAS] Using fixed gas limit (no estimateGas round-trip): ${gasLimit}`);
  } else {
    const gasEstimateStartedAt = performance.now();
    const gasEstimate = await raceAny(clients, (c) =>
      c.estimateGas({ account: wallet, to: mintTx.to, data: mintTx.data, value: mintTx.value }),
    );
    gasLimit = applyBuffer(gasEstimate);
    log(
      `[GAS] Estimate: ${gasEstimate} | Limit (+${config.gasBufferPercent}%): ${gasLimit} ` +
        `(${elapsed(gasEstimateStartedAt)} — pass --gas-limit next time to skip this call)`,
    );
  }

  log(`[TX] Nonce: ${nonce}`);

  if (!confirm) {
    log("");
    log("DRY RUN — transaction NOT broadcast. Use --confirm to broadcast.");
    log(`Tip: re-run with --gas-limit ${gasLimit} to skip the estimateGas round-trip next time.`);
    return;
  }

  /*
   * ----------------------------------------------------------
   * 4. Sign locally, then race-broadcast to all RPCs
   * ----------------------------------------------------------
   */
  const broadcastStartedAt = performance.now();

  const signedTx = await walletClient.signTransaction({
    account,
    chain,
    to: mintTx.to,
    data: mintTx.data,
    value: mintTx.value,
    nonce,
    gas: gasLimit,
    ...feeData,
  });
  const signedAt = performance.now();

  const result = await broadcastRace(rpcUrls, signedTx);

  log("");
  log("[SUCCESS] Mint transaction broadcast.");
  log(`TX          : ${result.hash}`);
  log(`RPC won     : ${result.rpcUrl}`);
  log(`Sign time   : ${Math.round(signedAt - broadcastStartedAt)}ms`);
  log(`Broadcast   : ${Math.round(performance.now() - signedAt)}ms`);
  log(`Critical path total (discovery -> broadcast): ${elapsed(criticalPathStartedAt)}`);
}

/*
 * ============================================================
 * FEE PREP
 * ============================================================
 */

type FeeFields =
  | { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }
  | { gasPrice: bigint };

function applyBuffer(value: bigint): bigint {
  return (value * (100n + config.gasBufferPercent)) / 100n;
}

async function prepareFees(clients: PublicClient[]): Promise<FeeFields> {
  // All three are independent RPC calls — fire them together, each raced
  // across every configured RPC, then pick whichever fee model applies.
  const [block, priority, gasPrice] = await Promise.all([
    raceAny(clients, (c) => c.getBlock()),
    raceAny(clients, (c) => c.estimateMaxPriorityFeePerGas()).catch(() => 1n),
    raceAny(clients, (c) => c.getGasPrice()).catch(() => 0n),
  ]);

  if (block.baseFeePerGas != null) {
    const bufferedBaseFee = applyBuffer(block.baseFeePerGas);
    const bufferedPriority = applyBuffer(priority > 0n ? priority : 1n);
    return {
      maxFeePerGas: bufferedBaseFee + bufferedPriority,
      maxPriorityFeePerGas: bufferedPriority,
    };
  }

  return { gasPrice: applyBuffer(gasPrice) };
}