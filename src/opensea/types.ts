import type {
  Address,
  Hex,
} from "viem";

/**
 * OpenSea Collection
 */
export interface OpenSeaCollection {
  collection: string;
  name?: string;
  description?: string;
  imageUrl?: string;
  bannerImageUrl?: string;
  externalUrl?: string;
  openseaUrl?: string;
}

/**
 * OpenSea Collection Stats
 */
export interface OpenSeaCollectionStats {
  totalSupply?: number;
  numOwners?: number;
  floorPrice?: number;
  floorPriceSymbol?: string;
  volume?: number;
  sales?: number;
}

/**
 * OpenSea Drop
 */
export interface OpenSeaDrop {
  slug: string;

  name?: string;

  description?: string;

  imageUrl?: string;

  bannerImageUrl?: string;

  contractAddress?: Address;

  chain?: string;

  totalSupply?: number;

  maxSupply?: number;

  stages: OpenSeaMintStage[];
}

/**
 * Mint stage.
 *
 * Keep this normalized.
 * Do not depend on OpenSea's raw field names
 * outside the OpenSea client.
 */
export interface OpenSeaMintStage {
  label?: string;

  startTime?: number;

  endTime?: number;

  price?: bigint;

  maxPerWallet?: number;

  maxSupply?: number;
}

/**
 * NFT returned by OpenSea scanner.
 */
export interface OpenSeaNft {
  identifier: string;

  collection?: string;

  name?: string;

  description?: string;

  imageUrl?: string;

  animationUrl?: string;

  contract?: Address;

  tokenStandard?: string;
}

/**
 * Raw request used to build a mint transaction.
 */
export interface BuildMintRequest {
  minter: Address;

  quantity: number;
}

/**
 * Normalized mint transaction.
 *
 * Everything after OpenSeaClient uses this type.
 */
export interface OpenSeaMintTransaction {
  to: Address;
  data: Hex;
  value: bigint;
}