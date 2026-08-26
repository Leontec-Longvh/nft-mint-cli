import { Command } from "commander";

import {
  OpenSeaClient,
} from "../../opensea/client.js";

import {
  CollectionScanner,
} from "../../scanner/collection-scanner.js";
import {
  config,
} from "../../config/env.js";

export function createScanCommand() {
  const command =
    new Command("scan");

  command
    .command("collection")
    .argument(
      "<slug>",
      "OpenSea collection slug",
    )
    .action(
      async (slug: string) => {
        try {
          const openSea =
            new OpenSeaClient(config.openSeaApiKey);

          const scanner =
            new CollectionScanner(
              openSea,
            );

          console.log("");
          console.log(
            `Scanning: ${slug}`,
          );

          console.log(
            "────────────────────────────────",
          );

          const snapshot =
            await scanner.scan(slug);

          console.log(
            "Collection:",
            snapshot.collection.name ??
              "-",
          );

          console.log(
            "Slug:",
            snapshot.slug,
          );

          console.log(
            "NFT sample:",
            snapshot.sampleNfts.length,
          );

          console.log(
            "Drop:",
            snapshot.drop
              ? "YES"
              : "NO",
          );
          console.log(
            "Phase:",
            snapshot.phase.type,
          );

          console.log(
            "Confidence:",
            `${Math.round(
              snapshot.phase.confidence * 100,
            )}%`,
          );

          if (snapshot.phase.currentStage) {
            console.log(
              "Stage:",
              snapshot.phase.currentStage.label,
            );

            console.log(
              "Price:",
              snapshot.phase.currentStage.price ??
                "-",
            );

            console.log(
              "Start:",
              snapshot.phase.currentStage.startTime
                ?.toISOString() ??
                "-",
            );

            console.log(
              "End:",
              snapshot.phase.currentStage.endTime
                ?.toISOString() ??
                "-",
            );
          }

          if (
            snapshot.phase.nextStage
          ) {
            console.log(
              "Next:",
              snapshot.phase.nextStage.label,
            );
          }

          console.log(
            "Reasons:",
          );

          for (const reason of
            snapshot.phase.reasons) {
            console.log(
              `  - ${reason}`,
            );
          }

          if (snapshot.stats) {
            console.log(
              "Floor:",
              snapshot.stats.floorPrice  ??
                "-",
            );

            console.log(
              "Owners:",
              snapshot.stats.numOwners  ??
                "-",
            );
          }

          console.log(
            "────────────────────────────────",
          );

          console.log(
            JSON.stringify(
              snapshot.drop,
              null,
              2,
            ),
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