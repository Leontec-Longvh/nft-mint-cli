import type { Address, Hex } from "viem";

const OPENSEA_API = "https://api.opensea.io/api/v2";

export class OpenSeaApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`OpenSea API ${status}: ${body}`);
    this.name = "OpenSeaApiError";
  }
}

export interface MintStage {
  label: string;

  /**
   * Unix seconds.
   * Normalized from seconds / milliseconds / ISO strings.
   */
  startTime?: number;

  endTime?: number;

  /**
   * OpenSea's wallet eligibility.
   *
   * undefined means unknown.
   */
  eligible?: boolean;
}

export interface DropInfo {
  slug: string;
  name?: string;
  contractAddress?: Address;
  stages: MintStage[];
}

export interface MintTransaction {
  to: Address;
  data: Hex;
  value: bigint;
}

/**
 * Converts:
 *
 *   seconds
 *   milliseconds
 *   numeric strings
 *   ISO date strings
 *
 * into Unix seconds.
 */
function toUnixSeconds(
  value: unknown,
): number | undefined {
  if (
    value === undefined ||
    value === null
  ) {
    return undefined;
  }

  if (typeof value === "number") {
    return value > 10_000_000_000
      ? Math.floor(value / 1000)
      : Math.floor(value);
  }

  const text = String(value).trim();

  if (!text) {
    return undefined;
  }

  if (/^\d+(\.\d+)?$/.test(text)) {
    const n = Number(text);

    return n > 10_000_000_000
      ? Math.floor(n / 1000)
      : Math.floor(n);
  }

  const ms = Date.parse(text);

  if (Number.isNaN(ms)) {
    return undefined;
  }

  return Math.floor(ms / 1000);
}

export class OpenSeaClient {
  constructor(
    private readonly apiKey: string,
  ) {}

  private async request<T>(
    path: string,
    init?: RequestInit,
  ): Promise<T> {
    let response: Response;

    try {
      response = await fetch(
        `${OPENSEA_API}${path}`,
        {
          ...init,
          headers: {
            accept: "application/json",
            "content-type":
              "application/json",
            "x-api-key": this.apiKey,
            ...(init?.headers ?? {}),
          },
        },
      );
    } catch (error) {
      throw new Error(
        `OpenSea network error: ${
          error instanceof Error
            ? error.message
            : String(error)
        }`,
      );
    }

    const text = await response.text();

    if (!response.ok) {
      throw new OpenSeaApiError(
        response.status,
        text,
      );
    }

    if (!text) {
      return {} as T;
    }

    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(
        `OpenSea returned invalid JSON: ${text}`,
      );
    }
  }

  /**
   * Fetch collection + all mint phases.
   */
  async getDrop(
    slug: string,
  ): Promise<DropInfo> {
    const raw =
      await this.request<{
        slug?: string;
        name?: string;
        contract_address?: string;

        stages?: Array<{
          label?: string;
          name?: string;

          start_time?:
            | number
            | string;

          end_time?:
            | number
            | string;

          eligible?: boolean;

          is_eligible?: boolean;

          wallet_eligible?: boolean;
        }>;
      }>(
        `/drops/${encodeURIComponent(
          slug,
        )}`,
      );

    return {
      slug: raw.slug ?? slug,

      name: raw.name,

      contractAddress:
        raw.contract_address as
          | Address
          | undefined,

      stages: (
        raw.stages ?? []
      ).map((stage) => ({
        label:
          stage.label ??
          stage.name ??
          "unknown",

        startTime:
          toUnixSeconds(
            stage.start_time,
          ),

        endTime:
          toUnixSeconds(
            stage.end_time,
          ),

        /*
         * Prefer wallet_eligible because
         * that is the most specific field.
         */
        eligible:
          stage.wallet_eligible ??
          stage.is_eligible ??
          stage.eligible,
      })),
    };
  }

  /**
   * Ask OpenSea to build the actual mint transaction.
   *
   * IMPORTANT:
   *
   * This endpoint is the final authority for
   * wallet eligibility.
   */
  async buildMintTransaction(
    slug: string,
    minter: Address,
    quantity: number,
  ): Promise<MintTransaction> {
    const raw =
      await this.request<{
        to?: string;
        data?: string;
        value?: string;
      }>(
        `/drops/${encodeURIComponent(
          slug,
        )}/mint`,
        {
          method: "POST",

          body: JSON.stringify({
            minter,
            quantity,
          }),
        },
      );

    if (
      !raw.to ||
      !raw.to.startsWith("0x")
    ) {
      throw new Error(
        `OpenSea mint response missing 'to': ${JSON.stringify(
          raw,
        )}`,
      );
    }

    if (
      !raw.data ||
      !raw.data.startsWith("0x")
    ) {
      throw new Error(
        `OpenSea mint response missing 'data': ${JSON.stringify(
          raw,
        )}`,
      );
    }

    if (raw.value === undefined) {
      throw new Error(
        `OpenSea mint response missing 'value': ${JSON.stringify(
          raw,
        )}`,
      );
    }

    let value: bigint;

    try {
      value = BigInt(raw.value);
    } catch {
      throw new Error(
        `OpenSea returned invalid transaction value: ${String(
          raw.value,
        )}`,
      );
    }

    return {
      to: raw.to as Address,
      data: raw.data as Hex,
      value,
    };
  }
}