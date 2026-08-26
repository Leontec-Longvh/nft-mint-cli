import {
  Command,
} from "commander";

import type {
  Address,
} from "viem";

import {
  OpenSeaClient,
} from "../../opensea/client.js";

import {
  MintDiscovery,
} from "../../mint/mint-discovery.js";

export function createMintDiscoverCommand(
  openSea: OpenSeaClient,
): Command {
  const command =
    new Command("mint-discover");

  command
    .description(
      "Discover NFT mint transaction from OpenSea",
    )
    .requiredOption(
      "--slug <slug>",
      "OpenSea collection slug",
    )
    .requiredOption(
      "--wallet <address>",
      "Minter wallet address",
    )
    .requiredOption(
      "--chain-id <number>",
      "Target chain ID",
    )
    .option(
      "--quantity <number>",
      "Mint quantity",
      "1",
    )
    .action(
      async (options) => {
        const discovery =
          new MintDiscovery(
            openSea,
          );

        const plan =
          await discovery.discover({
            slug:
              options.slug,

            wallet:
              options.wallet as Address,

            chainId:
              Number(
                options.chainId,
              ),

            quantity:
              Number(
                options.quantity,
              ),
          });

        console.log(
          "\nMint Plan",
        );

        console.log(
          "────────────────────────",
        );

        console.log(
          `Chain ID : ${plan.chainId}`,
        );

        console.log(
          `Wallet   : ${plan.wallet}`,
        );

        console.log(
          `Target   : ${plan.to}`,
        );

        console.log(
          `Value    : ${plan.value} wei`,
        );

        console.log(
          `Quantity : ${plan.quantity}`,
        );

        console.log(
          `Calldata : ${plan.data}`,
        );

        console.log(
          "────────────────────────",
        );
      },
    );

  return command;
}