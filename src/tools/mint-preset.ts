/*
 * ============================================================
 * MINT PRESET — collection discovery + prepared launch
 * ============================================================
 *
 * PROBLEM
 * -------
 * Ahead of a drop you usually only have two things: the OpenSea
 * collection SLUG, and the WALLET you'll mint from. You do not
 * have the contract address, the phase schedule, or any signed
 * calldata — OpenSea is the only source for those, and for
 * `mintSigned`-style drops OpenSea will not hand out valid
 * calldata for a phase until that phase is actually active
 * (a too-early /mint call returns 409, not calldata).
 *
 * So there is no way to fully pre-sign a mint offline. What CAN
 * be done ahead of time is everything that doesn't require the
 * phase to be live yet:
 *
 *   1. Resolve slug -> real contract address + full phase list.
 *   2. Write that into a packed JSON config at the project root,
 *      so it can be reviewed/edited before the drop.
 *   3. Run one safe eligibility check against OpenSea to report
 *      which phase (if any) the wallet can mint RIGHT NOW.
 *
 * The actual T-5s -> T0 wait, aggressive probing, signing and
 * broadcasting is already implemented — and already optimized —
 * in cli.ts / mint-engine.ts. This tool does not duplicate that.
 * It prepares the inputs, then spawns cli.ts as a child process
 * to do the real-time work, unmodified.
 *
 * IMPORTANT
 * ---------
 * - Does NOT import mint-engine.ts.
 * - Does NOT sign or broadcast anything itself.
 * - Does NOT modify cli.ts, mint-engine.ts, broadcast.ts, opensea.ts.
 * - Private key NEVER gets written to the JSON file — it stays in
 *   the PRIVATE_KEY env var, read by config.ts exactly as before.
 * ============================================================
 */

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Address } from "viem";

import { config } from "../config.js";
import { OpenSeaClient, type DropInfo } from "../opensea.js";
import { resolveChain } from "../chains.js";

/*
 * ============================================================
 * CLI TYPES
 * ============================================================
 */

interface CliOptions {
  slug?: string;
  wallet?: string;
  chainId?: string;
  quantity?: string;
  gasLimit?: string;
  configPath?: string;
  confirm?: boolean;
  checkOnly?: boolean;
}

const DEFAULT_QUANTITY = 1;

/*
 * ============================================================
 * HELPERS (kept local — this tool stays standalone)
 * ============================================================
 */

function parsePositiveInt(value: string, name: string): number {
  const n = Number(value);

  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return n;
}

function normalizeAddress(value: string, name: string): Address {
  if (!/^0x[a-fA-F0-9]{40}$/.test(value)) {
    throw new Error(`${name} is not a valid EVM address: ${value}`);
  }

  return value as Address;
}

function printHelp(): void {
  console.log(`
mint-preset — resolve a collection slug into a ready-to-launch config

Usage:
  tsx src/tools/mint-preset.ts --slug <slug> --wallet <address> --chain-id <id> [options]

Required:
  --slug <slug>          OpenSea collection/drop slug
  --wallet <address>     Minting wallet address (public address only)
  --chain-id <id>        EVM chain ID

Optional:
  --quantity <n>         Mint quantity (default: 1)
  --gas-limit <n>        Fixed gas limit, forwarded to cli.ts
  --config <path>        Where to write/read the packed JSON (default: <slug>.config.json)
  --confirm              Forwarded to cli.ts — actually broadcast
  --check-only           Only fetch + write the config and report eligibility, do not mint
  --help                 Show this help
`);
}

/*
 * ============================================================
 * ARG PARSING
 * ============================================================
 */

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    switch (arg) {
      case "--slug":
        options.slug = argv[++i];
        break;

      case "--wallet":
        options.wallet = argv[++i];
        break;

      case "--chain-id":
        options.chainId = argv[++i];
        break;

      case "--quantity":
        options.quantity = argv[++i];
        break;

      case "--gas-limit":
        options.gasLimit = argv[++i];
        break;

      case "--config":
        options.configPath = argv[++i];
        break;

      case "--confirm":
        options.confirm = true;
        break;

      case "--check-only":
        options.checkOnly = true;
        break;

      case "--help":
      case "-h":
        printHelp();
        process.exit(0);

      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

/*
 * ============================================================
 * PACKED JSON SHAPE
 * ============================================================
 *
 * Deliberately excludes anything wallet-secret. Private key stays
 * in PRIVATE_KEY env var only, exactly like the existing convention.
 * ============================================================
 */

interface PreparedMintConfig {
  slug: string;
  name?: string;
  chainId: number;
  contractAddress?: Address;
  wallet: Address;
  quantity: number;
  stages: DropInfo["stages"];
  preparedAt: string;
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function describeStage(stage: DropInfo["stages"][number], current: number): string {
  const active =
    typeof stage.startTime === "number" &&
    stage.startTime <= current &&
    (stage.endTime === undefined || stage.endTime > current);

  const future = typeof stage.startTime === "number" && stage.startTime > current;

  const status = active ? "ACTIVE" : future ? "FUTURE" : "ENDED/UNKNOWN";

  const start = stage.startTime
    ? new Date(stage.startTime * 1000).toISOString()
    : "unknown";

  const end = stage.endTime ? new Date(stage.endTime * 1000).toISOString() : "unknown";

  return `  [${status}] ${stage.label} | start=${start} end=${end} | eligible=${
    stage.eligible === undefined ? "unknown" : stage.eligible
  }`;
}

/*
 * ============================================================
 * MAIN
 * ============================================================
 */

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (!options.slug) throw new Error("Missing required option: --slug");
  if (!options.wallet) throw new Error("Missing required option: --wallet");
  if (!options.chainId) throw new Error("Missing required option: --chain-id");

  const slug = options.slug;
  const chainId = parsePositiveInt(options.chainId, "chain-id");
  const wallet = normalizeAddress(options.wallet, "wallet");
  const quantity = options.quantity
    ? parsePositiveInt(options.quantity, "quantity")
    : DEFAULT_QUANTITY;

  // Fail fast on an unsupported chain before calling anything.
  resolveChain(chainId);

  const configPath = resolve(options.configPath ?? `${slug}.config.json`);

  console.log("========================================");
  console.log("           MINT PRESET — PREPARE");
  console.log("========================================");
  console.log(`Slug       : ${slug}`);
  console.log(`Wallet     : ${wallet}`);
  console.log(`Chain ID   : ${chainId}`);
  console.log(`Config out : ${configPath}`);
  console.log("========================================");

  const openSea = new OpenSeaClient(config.openSeaApiKey);

  /*
   * ----------------------------------------------------------
   * 1. Resolve slug -> real contract address + phase schedule.
   * ----------------------------------------------------------
   */
  console.log("\n[1/3] Fetching collection from OpenSea...");
  const drop = await openSea.getDrop(slug);

  if (!drop.contractAddress) {
    console.warn(
      "  WARNING: OpenSea did not return a contract address for this slug.",
    );
  }

  console.log(`  Collection : ${drop.name ?? "(unnamed)"}`);
  console.log(`  Contract   : ${drop.contractAddress ?? "(unknown)"}`);
  console.log(`  Phases     : ${drop.stages.length}`);

  const current = nowSec();
  for (const stage of drop.stages) {
    console.log(describeStage(stage, current));
  }

  /*
   * ----------------------------------------------------------
   * 2. Write packed JSON config (no secrets).
   * ----------------------------------------------------------
   */
  console.log("\n[2/3] Writing packed config...");

  const prepared: PreparedMintConfig = {
    slug,
    name: drop.name,
    chainId,
    contractAddress: drop.contractAddress,
    wallet,
    quantity,
    stages: drop.stages,
    preparedAt: new Date().toISOString(),
  };

  writeFileSync(configPath, JSON.stringify(prepared, null, 2) + "\n", "utf-8");
  console.log(`  Written -> ${configPath}`);

  /*
   * ----------------------------------------------------------
   * 3. Single, safe eligibility check.
   *
   * This calls the SAME POST /mint endpoint the live engine uses,
   * but only once, here, for reporting. It does not sign or send
   * anything on-chain — it only asks OpenSea to build calldata.
   * A 409 means no phase is active yet; a 422 means the wallet is
   * not eligible for whatever phase is active right now.
   * ----------------------------------------------------------
   */
  console.log("\n[3/3] Checking current eligibility...");

  try {
    await openSea.buildMintTransaction(slug, wallet, quantity);
    console.log("  RESULT: A phase is ACTIVE right now and this wallet IS eligible.");
    console.log("  -> cli.ts will mint immediately instead of waiting.");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (/OpenSea API\s+409/i.test(message)) {
      console.log("  RESULT: No phase is active yet (409). This is expected pre-drop.");
    } else if (/OpenSea API\s+422/i.test(message)) {
      console.log(
        "  RESULT: A phase is active, but this wallet is NOT eligible for it (422).",
      );
    } else {
      console.log(`  RESULT: Could not determine eligibility — ${message}`);
    }
  }

  if (options.checkOnly) {
    console.log("\n--check-only set — stopping here. Config file is ready for review.");
    return;
  }

  /*
   * ----------------------------------------------------------
   * 4. Hand off to the existing, unmodified cli.ts.
   *
   * Same T-5s -> T0 wait, same aggressive probe, same
   * sign/broadcast. This tool does not re-implement any of it.
   * ----------------------------------------------------------
   */
  console.log("\n========================================");
  console.log("     HANDING OFF TO cli.ts FOR LAUNCH");
  console.log("========================================\n");

  const cliArgs = [
    "src/cli.ts",
    "--slug",
    slug,
    "--chain-id",
    String(chainId),
    "--wallet",
    wallet,
    "--quantity",
    String(quantity),
  ];

  if (options.gasLimit) {
    cliArgs.push("--gas-limit", options.gasLimit);
  }

  if (options.confirm) {
    cliArgs.push("--confirm");
  }

  const npxCommand = process.platform === "win32" ? "npx.cmd" : "npx";

  const child = spawn(npxCommand, ["tsx", ...cliArgs], {
    stdio: "inherit",
    env: process.env,
    shell: process.platform === "win32",
  });

  const exitCode: number = await new Promise((resolveExit, rejectExit) => {
    child.on("error", rejectExit);
    child.on("exit", (code) => resolveExit(code ?? 1));
  });

  process.exitCode = exitCode;
}

main().catch((error: unknown) => {
  console.error("");
  console.error("[ERROR]", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});


// npx tsx src/tools/mint-preset.ts --slug goose-origami --wallet 0x71016560b59d3982E665458DB55484b285af2bB8 --chain-id 4663 --confirm