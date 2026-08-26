import type { Address, Hex } from "viem";

const OPENSEA_API = "https://api.opensea.io/api/v2";

export interface MintStage {
  label: string;
  /** Unix seconds, normalized regardless of OpenSea's raw format. */
  startTime?: number;
  endTime?: number;
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

/** Normalizes seconds / milliseconds / ISO strings into Unix seconds. */
function toUnixSeconds(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;

  if (typeof value === "number") {
    return value > 10_000_000_000 ? Math.floor(value / 1000) : Math.floor(value);
  }

  const text = String(value).trim();
  if (!text) return undefined;

  if (/^\d+(\.\d+)?$/.test(text)) {
    const n = Number(text);
    return n > 10_000_000_000 ? Math.floor(n / 1000) : Math.floor(n);
  }

  const ms = Date.parse(text);
  return Number.isNaN(ms) ? undefined : Math.floor(ms / 1000);
}

export class OpenSeaClient {
  constructor(private readonly apiKey: string) {}

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${OPENSEA_API}${path}`, {
      ...init,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        ...(init?.headers ?? {}),
      },
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`OpenSea API ${response.status}: ${text}`);
    }
    return text ? (JSON.parse(text) as T) : ({} as T);
  }

  /** Collection info + current mint phases. */
  async getDrop(slug: string): Promise<DropInfo> {
    const raw = await this.request<{
      slug?: string;
      name?: string;
      contract_address?: string;
      stages?: Array<{
        label?: string;
        name?: string;
        start_time?: number | string;
        end_time?: number | string;
        eligible?: boolean;
        is_eligible?: boolean;
        wallet_eligible?: boolean;
      }>;
    }>(`/drops/${encodeURIComponent(slug)}`);

    return {
      slug: raw.slug ?? slug,
      name: raw.name,
      contractAddress: raw.contract_address as Address | undefined,
      stages: (raw.stages ?? []).map((s) => ({
        label: s.label ?? s.name ?? "unknown",
        startTime: toUnixSeconds(s.start_time),
        endTime: toUnixSeconds(s.end_time),
        eligible: s.wallet_eligible ?? s.is_eligible ?? s.eligible,
      })),
    };
  }

  /** Builds the actual mint calldata. This is the on-chain source of truth. */
  async buildMintTransaction(
    slug: string,
    minter: Address,
    quantity: number,
  ): Promise<MintTransaction> {
    const raw = await this.request<{ to?: string; data?: string; value?: string }>(
      `/drops/${encodeURIComponent(slug)}/mint`,
      {
        method: "POST",
        body: JSON.stringify({ minter, quantity }),
      },
    );

    if (!raw.to?.startsWith("0x")) {
      throw new Error(`OpenSea mint response missing 'to': ${JSON.stringify(raw)}`);
    }
    if (!raw.data?.startsWith("0x")) {
      throw new Error(`OpenSea mint response missing 'data': ${JSON.stringify(raw)}`);
    }
    if (raw.value === undefined) {
      throw new Error(`OpenSea mint response missing 'value': ${JSON.stringify(raw)}`);
    }

    return { to: raw.to as Address, data: raw.data as Hex, value: BigInt(raw.value) };
  }
}
