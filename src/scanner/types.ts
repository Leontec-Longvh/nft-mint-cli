import type {
  OpenSeaCollection,
  OpenSeaCollectionStats,
  OpenSeaDrop,
  OpenSeaNft,
} from "../opensea/types.js";

import type {
  PhaseDetection,
} from "../phase/types.js";

export interface CollectionSnapshot {
  slug: string;

  scannedAt: number;

  collection: OpenSeaCollection;

  stats: OpenSeaCollectionStats | null;

  drop: OpenSeaDrop | null;

  sampleNfts: OpenSeaNft[];

  phase: PhaseDetection;

  source: {
    opensea: true;
  };
}