import { z } from "zod";

import type { Address, Config, Hex } from "./types.js";

export class MorphoApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MorphoApiError";
  }
}

export interface MorphoApiPosition {
  readonly user: Address;
  readonly marketId: Hex;
  readonly symbol: string | null;
  readonly loanSymbol: string | null;
  readonly lltv: bigint;
  readonly healthFactor: number | null;
  readonly collateral: bigint;
  readonly borrowAssets: bigint;
  readonly collateralUsd: number | null;
  readonly borrowAssetsUsd: number | null;
}

export interface MorphoApiSnapshot {
  readonly fetchedAt: number;
  readonly chainId: bigint;
  readonly marketId: Hex;
  readonly positions: readonly MorphoApiPosition[];
}

const query = `query MarketPositions($marketId: String!, $chainId: Int!, $first: Int!) {
  marketPositions(
    where: { marketUniqueKey_in: [$marketId], chainId_in: [$chainId] }
    orderBy: HealthFactor
    orderDirection: Asc
    first: $first
  ) {
    items {
      healthFactor
      user { address }
      state { collateral borrowAssets collateralUsd borrowAssetsUsd }
      market {
        marketId
        lltv
        collateralAsset { symbol }
        loanAsset { symbol }
      }
    }
  }
}`;

const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const hex32Schema = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const uintString = z.string().regex(/^\d+$/);

const itemSchema = z.object({
  healthFactor: z.number().nullable().optional(),
  user: z.object({ address: addressSchema }),
  state: z
    .object({
      collateral: uintString,
      borrowAssets: uintString.nullable().optional(),
      collateralUsd: z.number().nullable().optional(),
      borrowAssetsUsd: z.number().nullable().optional(),
    })
    .nullable()
    .optional(),
  market: z.object({
    marketId: hex32Schema,
    lltv: uintString,
    collateralAsset: z.object({ symbol: z.string().nullable().optional() }).nullable().optional(),
    loanAsset: z.object({ symbol: z.string().nullable().optional() }).nullable().optional(),
  }),
});

const envelopeSchema = z.object({
  data: z
    .object({
      marketPositions: z.object({ items: z.array(itemSchema) }),
    })
    .nullable()
    .optional(),
  errors: z.array(z.object({ message: z.string() })).nullable().optional(),
});

export class MorphoApiClient {
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly maxPositions: number;

  constructor(config: Pick<Config, "morphoApiUrl" | "morphoApiTimeoutMs" | "morphoApiMaxPositions">) {
    this.url = config.morphoApiUrl;
    this.timeoutMs = config.morphoApiTimeoutMs;
    this.maxPositions = config.morphoApiMaxPositions;
  }

  async fetchPositions(marketId: Hex, chainId: bigint): Promise<MorphoApiSnapshot> {
    const numericChainId = Number(chainId);
    if (!Number.isSafeInteger(numericChainId) || numericChainId <= 0) {
      throw new MorphoApiError(`unsupported chainId for Morpho API: ${chainId.toString()}`);
    }

    let response: Response;
    try {
      response = await fetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query,
          variables: {
            marketId,
            chainId: numericChainId,
            first: this.maxPositions,
          },
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new MorphoApiError(`Morpho API request failed: ${describe(error)}`);
    }

    if (!response.ok) {
      throw new MorphoApiError(`Morpho API HTTP ${response.status}: ${await response.text().catch(() => "")}`);
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new MorphoApiError("Morpho API returned invalid JSON");
    }

    const parsed = envelopeSchema.safeParse(json);
    if (!parsed.success) {
      throw new MorphoApiError(
        parsed.error.issues.map((issue) => `${issue.path.join(".") || "response"}: ${issue.message}`).join("; "),
      );
    }
    if (parsed.data.errors !== undefined && parsed.data.errors !== null && parsed.data.errors.length > 0) {
      throw new MorphoApiError(parsed.data.errors.map((error) => error.message).join("; "));
    }
    const items = parsed.data.data?.marketPositions.items;
    if (items === undefined) {
      throw new MorphoApiError("Morpho API response is missing marketPositions.items");
    }

    const positions: MorphoApiPosition[] = [];
    for (const item of items) {
      const state = item.state;
      if (state === undefined || state === null) continue;
      positions.push({
        user: item.user.address as Address,
        marketId: item.market.marketId as Hex,
        symbol: item.market.collateralAsset?.symbol ?? null,
        loanSymbol: item.market.loanAsset?.symbol ?? null,
        lltv: BigInt(item.market.lltv),
        healthFactor: item.healthFactor ?? null,
        collateral: BigInt(state.collateral),
        borrowAssets: BigInt(state.borrowAssets ?? "0"),
        collateralUsd: state.collateralUsd ?? null,
        borrowAssetsUsd: state.borrowAssetsUsd ?? null,
      });
    }

    return {
      fetchedAt: Date.now(),
      chainId,
      marketId,
      positions,
    };
  }
}

export function morphoApiLtvBps(position: MorphoApiPosition): number | null {
  if (position.collateralUsd === null || position.borrowAssetsUsd === null) return null;
  if (position.collateralUsd <= 0) return null;
  return Math.round((position.borrowAssetsUsd / position.collateralUsd) * 10_000);
}

export function morphoApiLiquidatable(position: MorphoApiPosition): boolean {
  return position.healthFactor !== null && position.healthFactor < 1;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
