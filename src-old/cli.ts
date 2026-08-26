import { Command } from "commander";
import { privateKeyToAccount } from "viem/accounts";
import type { Address } from "viem";

import { config } from "./config.js";
import { OpenSeaClient } from "./opensea.js";
import { resolveChain } from "./chains.js";
import { runMint } from "./mint-engine.js";

interface CliOptions {
  slug: string;
  chainId: string;
  wallet: string;
  quantity: string;
  confirm?: boolean;
}

function parsePositiveInt(value: string, name: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return n;
}

const program = new Command();

program
  .name("nft-mint-cli")
  .description("Minimal FCFS NFT mint CLI (OpenSea drops)")
  .version("2.0.0")
  .requiredOption("--slug <slug>", "OpenSea collection/drop slug")
  .requiredOption("--chain-id <chainId>", "EVM chain ID")
  .requiredOption("--wallet <address>", "Minting wallet address")
  .option("--quantity <quantity>", "Mint quantity", "1")
  .option("--confirm", "Actually broadcast the transaction", false)
  .action(async (options: CliOptions) => {
    const chainId = parsePositiveInt(options.chainId, "chain-id");
    const quantity = parsePositiveInt(options.quantity, "quantity");
    const wallet = options.wallet as Address;
    const { chain, rpcUrls } = resolveChain(chainId);
    const extraRpcUrls = config.extraRpcUrls.filter((u) => !rpcUrls.includes(u));

    const account = privateKeyToAccount(config.privateKey);
    const openSea = new OpenSeaClient(config.openSeaApiKey);

    console.log("========================================");
    console.log("              FCFS MINT");
    console.log("========================================");
    console.log(`Collection : ${options.slug}`);
    console.log(`Chain      : ${chain.name} (${chainId})`);
    console.log(`Wallet     : ${wallet}`);
    console.log(`Quantity   : ${quantity}`);
    console.log(`Confirm    : ${Boolean(options.confirm)}`);
    console.log(`RPCs raced : ${rpcUrls.length + extraRpcUrls.length}`);
    console.log("========================================");

    await runMint(
      { slug: options.slug, chainId, wallet, quantity, confirm: Boolean(options.confirm) },
      { openSea, account, chain, rpcUrls: [...rpcUrls, ...extraRpcUrls] },
    );
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error("");
  console.error("[ERROR]", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
