import { Command } from "commander";

import {
  OpenSeaClient,
} from "../../opensea/client.js";
import { config } from "../../config/env.js";
export function createOpenSeaCommand() {
  const command =
    new Command("opensea");

  command
    .command("collection")
    .argument(
      "<slug>",
      "OpenSea collection slug",
    )
    .action(
      async (slug: string) => {
        try {
          const client =
            new OpenSeaClient(config.openSeaApiKey);

          const collection =
            await client.getCollection(
              slug,
            );

          console.log("");
          console.log(
            "OpenSea Collection",
          );
          console.log(
            "────────────────────────",
          );

          console.log(
            "Slug:",
            collection.collection,
          );

          console.log(
            "Name:",
            collection.name ??
              "-",
          );

          console.log(
            "Description:",
            collection.description ??
              "-",
          );

          console.log(
            "Image:",
            collection.imageUrl ??
              "-",
          );

          console.log("");
        } catch (error) {
          console.error(
            error instanceof Error
              ? error.message
              : error,
          );

          process.exitCode = 1;
        }
      },
    );

  command
    .command("stats")
    .argument(
      "<slug>",
      "OpenSea collection slug",
    )
    .action(
      async (slug: string) => {
        try {
          const client =
            new OpenSeaClient(config.openSeaApiKey);

          const stats =
            await client.getCollectionStats(
              slug,
            );

          console.log("");
          console.log(
            "Collection Stats",
          );
          console.log(
            "────────────────────────",
          );

          console.log(
            "Floor:",
            stats.floorPrice ??
              "-",
          );

          console.log(
            "Owners:",
            stats.numOwners ??
              "-",
          );

          console.log(
            "Supply:",
            stats.totalSupply ??
              "-",
          );

          console.log("");
        } catch (error) {
          console.error(
            error instanceof Error
              ? error.message
              : error,
          );

          process.exitCode = 1;
        }
      },
    );

  return command;
}