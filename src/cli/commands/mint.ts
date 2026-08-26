import {
  Command,
} from "commander";

import {
  type Account,
  type Address,
  type Hex,
  createPublicClient,
  createWalletClient,
  http,
} from "viem";

import {
  MintPreparer,
  type PreparedMintPlan,
} from "../../mint/mint-preparer.js";

import {
  MintExecutor,
} from "../../mint/mint-executor.js";

import {
  ChainContextManager,
} from "../../chains/context-manager.js";

import {
  RpcManager,
} from "../../rpc/manager.js";

import {
  CHAINS,
} from "../../chains/definitions.js";

import {
  RPCS,
} from "../../chains/rpc.js";

import {
  OpenSeaClient,
} from "../../opensea/client.js";

import type {
  MintPlan,
} from "../../mint/mint-plan.js";

/*
 * ============================================================
 * TYPES
 * ============================================================
 */

export interface MintCommandDependencies {
  rpcManager:
    RpcManager;

  openSea:
    OpenSeaClient;

  account:
    Account;
}

interface MintOptions {
  slug:
    string;

  chainId:
    string;

  wallet:
    string;

  quantity:
    string;

  confirm?:
    boolean;
}

/*
 * ============================================================
 * EXECUTION CONTEXT
 * ============================================================
 */

export interface ExecutionContext1559 {
  nonce:
    number;

  gas:
    bigint;

  maxFeePerGas:
    bigint;

  maxPriorityFeePerGas:
    bigint;
}

export interface ExecutionContextLegacy {
  nonce:
    number;

  gas:
    bigint;

  gasPrice:
    bigint;
}

export type ExecutionContext =
  | ExecutionContext1559
  | ExecutionContextLegacy;

/*
 * ============================================================
 * HELPERS
 * ============================================================
 */

function parsePositiveInteger(
  value: string,
  name: string,
): number {
  const parsed =
    Number(value);

  if (
    !Number.isInteger(
      parsed,
    ) ||
    parsed <= 0
  ) {
    throw new Error(
      `${name} must be a positive integer`,
    );
  }

  return parsed;
}

function parseChainId(
  value: string,
): number {
  const chainId =
    Number(value);

  if (
    !Number.isInteger(
      chainId,
    ) ||
    chainId <= 0
  ) {
    throw new Error(
      `Invalid chain ID: ${value}`,
    );
  }

  return chainId;
}

/*
 * ============================================================
 * FEE
 * ============================================================
 *
 * +20% at broadcast.
 *
 * Gas LIMIT is NOT changed here.
 */
const FEE_MULTIPLIER_PERCENT =
  120n;

function applyFeeMultiplier(
  value:
    bigint,
): bigint {
  return (
    value *
    FEE_MULTIPLIER_PERCENT
  ) / 100n;
}

/*
 * ============================================================
 * FEE PUBLIC CLIENT
 * ============================================================
 *
 * Structural interface prevents viem chain generic
 * incompatibilities.
 */
interface FeePublicClient {
  getTransactionCount(
    parameters: {
      address:
        Address;

      blockTag:
        "pending";
    },
  ): Promise<number>;

  getBlock(): Promise<{
    baseFeePerGas:
      bigint | null;
  }>;

  estimateMaxPriorityFeePerGas():
    Promise<bigint>;

  getGasPrice():
    Promise<bigint>;
}

/*
 * ============================================================
 * PREPARE EXECUTION CONTEXT
 * ============================================================
 *
 * IMPORTANT:
 *
 * NO estimateGas().
 *
 * Only:
 *
 *   pending nonce
 *   current fee
 *
 * immediately before broadcast.
 */
async function prepareExecutionContext(
  publicClient:
    FeePublicClient,

  account:
    Account,

  gasLimit:
    bigint,
): Promise<ExecutionContext> {
  console.log("");

  console.log(
    "[TX] Loading pending nonce + current fee...",
  );

  const [
    nonce,
    block,
    priorityFee,
  ] =
    await Promise.all([
      publicClient.getTransactionCount({
        address:
          account.address,

        blockTag:
          "pending",
      }),

      publicClient.getBlock(),

      publicClient
        .estimateMaxPriorityFeePerGas()
        .catch(
          () => 1n,
        ),
    ]);

  /*
   * ========================================================
   * EIP-1559
   * ========================================================
   */

  if (
    block.baseFeePerGas !==
      null &&
    block.baseFeePerGas !==
      undefined
  ) {
    const priority =
      priorityFee > 0n
        ? priorityFee
        : 1n;

    const bufferedBaseFee =
      applyFeeMultiplier(
        block.baseFeePerGas,
      );

    const bufferedPriorityFee =
      applyFeeMultiplier(
        priority,
      );

    const maxFeePerGas =
      bufferedBaseFee +
      bufferedPriorityFee;

    console.log(
      `[TX] Base fee: ${block.baseFeePerGas}`,
    );

    console.log(
      `[TX] Base fee +20%: ${bufferedBaseFee}`,
    );

    console.log(
      `[TX] Priority fee: ${priority}`,
    );

    console.log(
      `[TX] Priority +20%: ${bufferedPriorityFee}`,
    );

    console.log(
      `[TX] Max fee: ${maxFeePerGas}`,
    );

    return {
      nonce,

      gas:
        gasLimit,

      maxFeePerGas,

      maxPriorityFeePerGas:
        bufferedPriorityFee,
    };
  }

  /*
   * ========================================================
   * LEGACY
   * ========================================================
   */

  const gasPrice =
    await publicClient.getGasPrice();

  if (
    gasPrice <= 0n
  ) {
    throw new Error(
      `Invalid gasPrice: ${gasPrice}`,
    );
  }

  const bufferedGasPrice =
    applyFeeMultiplier(
      gasPrice,
    );

  console.log(
    `[TX] Gas price: ${gasPrice}`,
  );

  console.log(
    `[TX] Gas price +20%: ${bufferedGasPrice}`,
  );

  return {
    nonce,

    gas:
      gasLimit,

    gasPrice:
      bufferedGasPrice,
  };
}

/*
 * ============================================================
 * COMMAND
 * ============================================================
 */

export function createMintCommand(
  dependencies:
    MintCommandDependencies,
): Command {
  const command =
    new Command(
      "mint",
    );

  command
    .description(
      "Execute FCFS NFT mint",
    )

    .requiredOption(
      "--slug <slug>",
      "OpenSea collection/drop slug",
    )

    .requiredOption(
      "--chain-id <chainId>",
      "EVM chain ID",
    )

    .requiredOption(
      "--wallet <address>",
      "Minting wallet address",
    )

    .option(
      "--quantity <quantity>",
      "Mint quantity",
      "1",
    )

    .option(
      "--confirm",
      "Actually broadcast transaction",
      false,
    )

    .action(
      async (
        options:
          MintOptions,
      ) => {
        await runMint(
          options,
          dependencies,
        );
      },
    );

  return command;
}

/*
 * ============================================================
 * MAIN
 * ============================================================
 */

async function runMint(
  options:
    MintOptions,

  dependencies:
    MintCommandDependencies,
): Promise<void> {
  const slug =
    options.slug;

  const chainId =
    parseChainId(
      options.chainId,
    );

  const quantity =
    parsePositiveInteger(
      options.quantity,
      "quantity",
    );

  const wallet =
    options.wallet as Address;

  const confirm =
    Boolean(
      options.confirm,
    );

  const {
    rpcManager,
    openSea,
    account,
  } =
    dependencies;

  /*
   * ==========================================================
   * HEADER
   * ==========================================================
   */

  console.log("");

  console.log(
    "========================================",
  );

  console.log(
    "              FCFS MINT",
  );

  console.log(
    "========================================",
  );

  console.log(
    `Collection : ${slug}`,
  );

  console.log(
    `Chain      : ${chainId}`,
  );

  console.log(
    `Wallet     : ${wallet}`,
  );

  console.log(
    `Quantity   : ${quantity}`,
  );

  console.log(
    `Confirm    : ${confirm}`,
  );

  console.log(
    "Gas        : estimate ONCE +20%",
  );

  console.log(
    "Fee        : current +20% at broadcast",
  );

  console.log(
    "Plan       : IN MEMORY",
  );

  console.log(
    "File       : NONE",
  );

  console.log(
    "========================================",
  );

  /*
   * ==========================================================
   * VALIDATE ACCOUNT
   * ==========================================================
   */

  if (
    account.address.toLowerCase() !==
    wallet.toLowerCase()
  ) {
    throw new Error(
      [
        "Wallet mismatch.",
        `CLI wallet:     ${wallet}`,
        `Account wallet: ${account.address}`,
      ].join("\n"),
    );
  }

  /*
   * ==========================================================
   * CHAIN
   * ==========================================================
   */

  console.log("");

  console.log(
    "[CHAIN] Resolving chain...",
  );

  const chainManager =
    new ChainContextManager(
      rpcManager,
    );

  const chainName =
    chainManager.getNameByChainId(
      chainId,
    );

  console.log(
    `[CHAIN] ${chainName}`,
  );

  const chain =
    CHAINS[chainName];

  if (!chain) {
    throw new Error(
      `Unsupported chain: ${chainName}`,
    );
  }

  /*
   * ==========================================================
   * RPC
   * ==========================================================
   */

  const rpcUrls =
    RPCS[chainName];

  if (
    !rpcUrls ||
    rpcUrls.length === 0
  ) {
    throw new Error(
      `No RPC configured for ${chainName}`,
    );
  }

  const primaryRpc =
    rpcUrls[0];

  console.log(
    `[RPC] Primary: ${primaryRpc}`,
  );

  /*
   * ==========================================================
   * PUBLIC CLIENT
   * ==========================================================
   *
   * DO NOT annotate as:
   *
   *   PublicClient
   *
   * Let viem infer the exact chain type.
   */
  const publicClient =
    createPublicClient({
      chain,

      transport:
        http(
          primaryRpc,
          {
            timeout:
              1_500,
          },
        ),
    });

  /*
   * ==========================================================
   * WALLET CLIENT
   * ==========================================================
   */

  const walletClient =
    createWalletClient({
      account,

      chain,

      transport:
        http(
          primaryRpc,
          {
            timeout:
              1_500,
          },
        ),
    });

  /*
   * ==========================================================
   * PREPARER
   * ==========================================================
   *
   * EVERYTHING happens in memory.
   *
   * No prepared-mint.json.
   *
   * Preparer:
   *
   *   1. find NEXT phase
   *   2. wait T-10s
   *   3. 1s polling
   *   4. 250ms polling
   *   5. Discovery
   *   6. retry 409/422
   *   7. estimateGas ONE TIME
   *   8. gas +20%
   */
  console.log("");

  console.log(
    "[FLOW] Starting MintPreparer...",
  );

  const preparer =
    new MintPreparer(
      openSea,

      publicClient,
    );

  const prepared:
    PreparedMintPlan =
      await preparer.prepare({
        slug,

        wallet,

        chainId,

        quantity,
      });

  /*
   * ==========================================================
   * PLAN READY
   * ==========================================================
   */

  console.log("");

  console.log(
    "[PLAN] IN MEMORY",
  );

  console.log(
    `[PLAN] Target: ${prepared.to}`,
  );

  console.log(
    `[PLAN] Value: ${prepared.value}`,
  );

  console.log(
    `[PLAN] Gas estimate: ${prepared.gasEstimate}`,
  );

  console.log(
    `[PLAN] Gas limit: ${prepared.gasLimit}`,
  );

  console.log(
    "[PLAN] Gas buffer: +20%",
  );

  if (
    prepared.stageName
  ) {
    console.log(
      `[PLAN] Phase: ${prepared.stageName}`,
    );
  }

  /*
   * ==========================================================
   * MINT PLAN
   * ==========================================================
   */

  const plan:
    MintPlan = {
    chainId:
      prepared.chainId,

    wallet:
      prepared.wallet,

    quantity:
      prepared.quantity,

    to:
      prepared.to,

    data:
      prepared.data,

    value:
      prepared.value,

    createdAt:
      prepared.createdAt,
  };

  /*
   * ==========================================================
   * DRY RUN
   * ==========================================================
   */

  if (
    !confirm
  ) {
    console.log("");

    console.log(
      "========================================",
    );

    console.log(
      "DRY RUN",
    );

    console.log(
      "Transaction was NOT broadcast.",
    );

    console.log(
      `[PLAN] Gas estimate: ${prepared.gasEstimate}`,
    );

    console.log(
      `[PLAN] Gas limit: ${prepared.gasLimit}`,
    );

    console.log(
      "[PLAN] Fee: current +20% at broadcast.",
    );

    console.log(
      "Use --confirm to broadcast.",
    );

    console.log(
      "========================================",
    );

    return;
  }

  /*
   * ==========================================================
   * CURRENT FEE
   * ==========================================================
   *
   * This is deliberately AFTER:
   *
   *   Discovery
   *   estimateGas
   *
   * We do NOT load fee while waiting for phase.
   */
  const executionContext =
    await prepareExecutionContext(
      publicClient,
      account,
      prepared.gasLimit,
    );

  /*
   * ==========================================================
   * TX READY
   * ==========================================================
   */

  console.log("");

  console.log(
    "[TX] READY",
  );

  console.log(
    `[TX] Nonce: ${executionContext.nonce}`,
  );

  console.log(
    `[TX] Gas: ${executionContext.gas}`,
  );

  if (
    "maxFeePerGas" in
    executionContext
  ) {
    console.log(
      `[TX] Max fee: ${executionContext.maxFeePerGas}`,
    );

    console.log(
      `[TX] Priority fee: ${executionContext.maxPriorityFeePerGas}`,
    );
  } else {
    console.log(
      `[TX] Gas price: ${executionContext.gasPrice}`,
    );
  }

  /*
   * ==========================================================
   * EXECUTOR
   * ==========================================================
   */

  console.log("");

  console.log(
    "[EXECUTOR] Signing...",
  );

  const executor =
  new MintExecutor(
    walletClient,
    chainName,
    account,
    rpcManager,
  );

  const execution =
    await executor.execute(
      plan,

      executionContext,
    );

  /*
   * ==========================================================
   * SUCCESS
   * ==========================================================
   */

  console.log("");

  console.log(
    "========================================",
  );

  console.log(
    "[SUCCESS] Mint transaction broadcast.",
  );

  console.log(
    `TX       : ${execution.hash}`,
  );

  console.log(
    `Latency  : ${execution.latencyMs} ms`,
  );

  console.log(
    `RPC      : ${execution.rpcUrl}`,
  );

  console.log(
    "========================================",
  );
}