import { Command } from "commander";

import {
  privateKeyToAccount,
} from "viem/accounts";

import {
  config,
} from "../config/env.js";

import {
  OpenSeaClient,
} from "../opensea/client.js";

import {
  RpcManager,
} from "../rpc/manager.js";

import {
  createMintDiscoverCommand,
} from "./commands/mint-discover.js";

import {
  createMintCommand,
} from "./commands/mint.js";


/*
 * --------------------------------------------------
 * PROGRAM
 * --------------------------------------------------
 */

const program =
  new Command();

program
  .name("nft-mint-cli")
  .description(
    "Multi-chain NFT mint CLI",
  )
  .version("1.0.0");


/*
 * --------------------------------------------------
 * GLOBAL DEPENDENCIES
 * --------------------------------------------------
 */


/*
 * RPC manager
 *
 * Shared by all commands.
 */

const rpcManager =
  new RpcManager();


/*
 * OpenSea API client
 */

const openSea =
  new OpenSeaClient(
    config.openSeaApiKey,
  );


/*
 * Signing account
 *
 * PRIVATE_KEY must come from .env
 */

const account =
  privateKeyToAccount(
    config.privateKey as `0x${string}`,
  );


/*
 * --------------------------------------------------
 * COMMANDS
 * --------------------------------------------------
 */


/*
 * Mint discovery
 */

program.addCommand(
  createMintDiscoverCommand(
    openSea,
  ),
);


/*
 * Real mint command
 */

program.addCommand(
  createMintCommand({
    rpcManager,

    openSea,

    account,
  }),
);


/*
 * --------------------------------------------------
 * RUN
 * --------------------------------------------------
 */

program
  .parseAsync(
    process.argv,
  )
  .catch(
    (error: unknown) => {
      console.error("");

      console.error(
        "[ERROR]",
      );

      console.error(
        error instanceof Error
          ? error.message
          : String(error),
      );

      process.exitCode = 1;
    },
  );