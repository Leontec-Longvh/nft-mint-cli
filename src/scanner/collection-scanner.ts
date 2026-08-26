import {
  OpenSeaClient,
} from "../opensea/client.js";

import {
  PhaseDetector,
} from "../phase/phase-detector.js";

import type {
  CollectionSnapshot,
} from "./types.js";

export class CollectionScanner {
  constructor(
    private readonly openSea: OpenSeaClient,
    private readonly phaseDetector =
      new PhaseDetector(),
  ) {}

  async scan(
    slug: string,
  ): Promise<CollectionSnapshot> {
    const [
      collection,
      stats,
      drop,
      nfts,
    ] = await Promise.all([
      this.openSea.getCollection(slug),

      this.openSea
        .getCollectionStats(slug)
        .catch(() => null),

      this.openSea
        .getDrop(slug)
        .catch(() => null),

      this.openSea
        .getNfts(slug, {
          limit: 20,
        })
        .catch(() => ({
          nfts: [],
        })),
    ]);

    const phase =
      this.phaseDetector.detect(
        drop,
      );

    return {
      slug,

      scannedAt: Date.now(),

      collection,

      stats,

      drop,

      sampleNfts:
        nfts.nfts ?? [],

      phase,

      source: {
        opensea: true,
      },
    };
  }
}