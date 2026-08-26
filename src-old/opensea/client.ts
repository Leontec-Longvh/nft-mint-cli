import type {
  Address,
  Hex,
} from "viem";

import type {
  BuildMintRequest,
  OpenSeaCollection,
  OpenSeaCollectionStats,
  OpenSeaDrop,
  OpenSeaMintTransaction,
  OpenSeaNft,
} from "./types.js";

const OPENSEA_API =
  "https://api.opensea.io/api/v2";

/*
 * ------------------------------------------------------------
 * Raw OpenSea API types
 * ------------------------------------------------------------
 */

interface RawCollection {
  collection?: string;

  name?: string;

  description?: string;

  image_url?: string;

  banner_image_url?: string;

  external_url?: string;

  opensea_url?: string;
}

interface RawCollectionStats {
  total_supply?: number;

  num_owners?: number;

  floor_price?: number;

  floor_price_symbol?: string;

  total_volume?: number;

  sales?: number;
}

interface RawDropStage {
  name?: string;

  label?: string;

  /*
   * OpenSea may return these as:
   *
   *   number
   *   numeric string
   *   ISO-8601 string
   *
   * We normalize them below.
   */

  start_time?:
    | number
    | string;

  end_time?:
    | number
    | string;

  price?: string;

  max_mint_per_wallet?: number;

  max_supply?: number;
}

interface RawDrop {
  slug?: string;

  name?: string;

  description?: string;

  image_url?: string;

  banner_image_url?: string;

  contract_address?: string;

  chain?: string;

  total_supply?: number;

  max_supply?: number;

  stages?: RawDropStage[];
}

interface RawNft {
  identifier: string;

  collection?: string;

  name?: string;

  description?: string;

  image_url?: string;

  animation_url?: string;

  contract?: string;

  token_standard?: string;
}

interface RawNftsResponse {
  nfts?: RawNft[];
}

interface RawMintTransaction {
  to?: string;

  data?: string;

  value?: string;

  chain?: string;
}

export interface OpenSeaNftsResponse {
  nfts: OpenSeaNft[];
}

/*
 * ------------------------------------------------------------
 * Timestamp normalization
 * ------------------------------------------------------------
 *
 * Converts:
 *
 *   1760000000
 *   "1760000000"
 *   1760000000000
 *   "1760000000000"
 *   "2026-08-25T12:00:00.000Z"
 *
 * into:
 *
 *   Unix timestamp in seconds
 *
 * Returns undefined for invalid/missing values.
 */

function parseUnixSeconds(
  value:
    | number
    | string
    | undefined,
): number | undefined {
  if (
    value === undefined ||
    value === null
  ) {
    return undefined;
  }

  /*
   * ----------------------------------------------------------
   * Number
   * ----------------------------------------------------------
   */

  if (
    typeof value === "number"
  ) {
    if (
      !Number.isFinite(
        value,
      )
    ) {
      return undefined;
    }

    /*
     * Milliseconds.
     *
     * Unix seconds are currently around 1.7e9.
     * Milliseconds are around 1.7e12.
     */

    if (
      value >
      10_000_000_000
    ) {
      return Math.floor(
        value / 1000,
      );
    }

    return Math.floor(
      value,
    );
  }

  /*
   * ----------------------------------------------------------
   * String
   * ----------------------------------------------------------
   */

  const text =
    value.trim();

  if (
    text.length === 0
  ) {
    return undefined;
  }

  /*
   * Numeric timestamp.
   */

  if (
    /^\d+(?:\.\d+)?$/.test(
      text,
    )
  ) {
    const numeric =
      Number(text);

    if (
      !Number.isFinite(
        numeric,
      )
    ) {
      return undefined;
    }

    if (
      numeric >
      10_000_000_000
    ) {
      return Math.floor(
        numeric / 1000,
      );
    }

    return Math.floor(
      numeric,
    );
  }

  /*
   * ISO-8601 / date string.
   */

  const milliseconds =
    Date.parse(text);

  if (
    Number.isNaN(
      milliseconds,
    )
  ) {
    return undefined;
  }

  return Math.floor(
    milliseconds / 1000,
  );
}

/*
 * ------------------------------------------------------------
 * OpenSea client
 * ------------------------------------------------------------
 */

export class OpenSeaClient {
  constructor(
    private readonly apiKey: string,
  ) {}

  /*
   * ----------------------------------------------------------
   * HTTP
   * ----------------------------------------------------------
   */

  private async request<T>(
    path: string,
    init?: RequestInit,
  ): Promise<T> {
    const response =
      await fetch(
        `${OPENSEA_API}${path}`,
        {
          ...init,

          headers: {
            accept:
              "application/json",

            "X-API-KEY":
              this.apiKey,

            "Content-Type":
              "application/json",

            ...(init?.headers ?? {}),
          },
        },
      );

    const text =
      await response.text();

    if (
      !response.ok
    ) {
      throw new Error(
        `OpenSea API ${response.status}: ${text}`,
      );
    }

    if (
      !text
    ) {
      return {} as T;
    }

    return JSON.parse(
      text,
    ) as T;
  }

  /*
   * ----------------------------------------------------------
   * Collection
   * ----------------------------------------------------------
   */

  async getCollection(
    slug: string,
  ): Promise<OpenSeaCollection> {
    const raw =
      await this.request<RawCollection>(
        `/collections/${encodeURIComponent(
          slug,
        )}`,
      );

    return {
      collection:
        raw.collection ??
        slug,

      name:
        raw.name,

      description:
        raw.description,

      imageUrl:
        raw.image_url,

      bannerImageUrl:
        raw.banner_image_url,

      externalUrl:
        raw.external_url,

      openseaUrl:
        raw.opensea_url,
    };
  }

  /*
   * ----------------------------------------------------------
   * Collection stats
   * ----------------------------------------------------------
   */

  async getCollectionStats(
    slug: string,
  ): Promise<OpenSeaCollectionStats> {
    const raw =
      await this.request<RawCollectionStats>(
        `/collections/${encodeURIComponent(
          slug,
        )}/stats`,
      );

    return {
      totalSupply:
        raw.total_supply,

      numOwners:
        raw.num_owners,

      floorPrice:
        raw.floor_price,

      floorPriceSymbol:
        raw.floor_price_symbol,

      volume:
        raw.total_volume,

      sales:
        raw.sales,
    };
  }

  /*
   * ----------------------------------------------------------
   * Drop
   * ----------------------------------------------------------
   */

  async getDrop(
    slug: string,
  ): Promise<OpenSeaDrop> {
    const raw =
      await this.request<RawDrop>(
        `/drops/${encodeURIComponent(
          slug,
        )}`,
      );

    return {
      slug:
        raw.slug ??
        slug,

      name:
        raw.name,

      description:
        raw.description,

      imageUrl:
        raw.image_url,

      bannerImageUrl:
        raw.banner_image_url,

      contractAddress:
        raw.contract_address as
          | Address
          | undefined,

      chain:
        raw.chain,

      totalSupply:
        raw.total_supply,

      maxSupply:
        raw.max_supply,

      stages:
        (raw.stages ?? []).map(
          (
            stage,
          ) => ({
            label:
              stage.label ??
              stage.name,

            /*
             * IMPORTANT:
             *
             * Normalize timestamps here.
             *
             * MintDiscovery therefore always receives
             * Unix seconds and never has to deal with
             * ISO strings / milliseconds.
             */

            startTime:
              parseUnixSeconds(
                stage.start_time,
              ),

            endTime:
              parseUnixSeconds(
                stage.end_time,
              ),

            price:
              stage.price !==
                undefined
                ? BigInt(
                    stage.price,
                  )
                : undefined,

            maxPerWallet:
              stage.max_mint_per_wallet,

            maxSupply:
              stage.max_supply,
          }),
        ),
    };
  }

  /*
   * ----------------------------------------------------------
   * NFTs
   * ----------------------------------------------------------
   */

  async getNfts(
    slug: string,
    options?: {
      limit?: number;
    },
  ): Promise<OpenSeaNftsResponse> {
    const params =
      new URLSearchParams();

    if (
      options?.limit !==
      undefined
    ) {
      params.set(
        "limit",
        String(
          options.limit,
        ),
      );
    }

    const query =
      params.toString();

    const raw =
      await this.request<RawNftsResponse>(
        `/collection/${encodeURIComponent(
          slug,
        )}/nfts${
          query
            ? `?${query}`
            : ""
        }`,
      );

    return {
      nfts:
        (raw.nfts ?? []).map(
          (
            nft,
          ) => ({
            identifier:
              nft.identifier,

            collection:
              nft.collection,

            name:
              nft.name,

            description:
              nft.description,

            imageUrl:
              nft.image_url,

            animationUrl:
              nft.animation_url,

            contract:
              nft.contract as
                | Address
                | undefined,

            tokenStandard:
              nft.token_standard,
          }),
        ),
    };
  }

  /*
   * ----------------------------------------------------------
   * Build mint transaction
   * ----------------------------------------------------------
   */

  async buildMintTransaction(
    slug: string,
    request: BuildMintRequest,
  ): Promise<OpenSeaMintTransaction> {
    const raw =
      await this.request<RawMintTransaction>(
        `/drops/${encodeURIComponent(
          slug,
        )}/mint`,
        {
          method:
            "POST",

          body:
            JSON.stringify({
              minter:
                request.minter,

              quantity:
                request.quantity,
            }),
        },
      );

    /*
     * Target
     */

    if (
      !raw.to ||
      !raw.to.startsWith(
        "0x",
      )
    ) {
      throw new Error(
        [
          "OpenSea mint response missing 'to'.",

          `Response: ${JSON.stringify(
            raw,
          )}`,
        ].join("\n"),
      );
    }

    /*
     * Calldata
     */

    if (
      !raw.data ||
      !raw.data.startsWith(
        "0x",
      )
    ) {
      throw new Error(
        [
          "OpenSea mint response missing 'data'.",

          `Response: ${JSON.stringify(
            raw,
          )}`,
        ].join("\n"),
      );
    }

    /*
     * Value
     */

    if (
      raw.value ===
      undefined
    ) {
      throw new Error(
        [
          "OpenSea mint response missing 'value'.",

          `Response: ${JSON.stringify(
            raw,
          )}`,
        ].join("\n"),
      );
    }

    return {
      to:
        raw.to as Address,

      data:
        raw.data as Hex,

      value:
        BigInt(
          raw.value,
        ),
    };
  }
}