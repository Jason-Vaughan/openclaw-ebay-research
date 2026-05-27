import {
  apiBaseUrl,
  getAppToken,
  withTimeout,
  currencyForMarketplace,
  DEFAULT_SCOPE,
  INSIGHTS_SCOPE,
  type AuthConfig,
} from "./auth.js";
import type { ConditionFilter, SortOption } from "./browse.js";

export interface SoldHistoryParams {
  query: string;
  marketplaceId?: string;
  condition?: ConditionFilter | ConditionFilter[];
  priceMin?: number;
  priceMax?: number;
  days?: number;
  sort?: SortOption;
  limit?: number;
  offset?: number;
}

export interface SoldItem {
  itemId: string;
  title: string;
  soldPrice?: { value: string; currency: string };
  lastSoldDate?: string;
  condition?: string;
  conditionId?: string;
  itemWebUrl?: string;
  seller?: { username?: string; feedbackPercentage?: string };
}

export interface SoldHistoryStatsBucket {
  sampleSize: number;
  min?: number;
  max?: number;
  mean?: number;
  median?: number;
  p25?: number;
  p75?: number;
}

export interface SoldHistoryStats {
  // Items with a usable price across ALL currencies in the result set.
  sampleSize: number;
  // eBay's reported total match count for the query (currency-agnostic).
  total: number;
  // Marketplace's primary currency — derived from marketplaceId, not from
  // the items. Use this to tell the operator what currency `primary` is in.
  primaryCurrency: string;
  // Stats for items priced in primaryCurrency. `sampleSize: 0` (no other
  // fields) when none of the results matched primaryCurrency.
  primary: SoldHistoryStatsBucket;
  // Per-currency breakdown for every currency observed in the result set,
  // including primaryCurrency when present. Surface when results mix.
  byCurrency: Record<string, SoldHistoryStatsBucket>;
}

export interface SoldHistoryResult {
  query: string;
  marketplaceId: string;
  windowDays: number;
  windowFrom: string;
  windowTo: string;
  stats: SoldHistoryStats;
  items: SoldItem[];
  next?: string;
  truncated: boolean;
}

const DEFAULT_MARKETPLACE = "EBAY_US";
const DEFAULT_DAYS = 90;
const MAX_DAYS = 90;

function buildSortParam(sort?: SortOption): string | undefined {
  switch (sort) {
    case "price_asc":
      return "price";
    case "price_desc":
      return "-price";
    case "newly_listed":
      return "lastSoldDate";
    case "best_match":
    case undefined:
      return undefined;
    default:
      return undefined;
  }
}

function buildFilterParam(
  params: SoldHistoryParams,
  fromIso: string,
  marketplaceId: string
): string {
  const filters: string[] = [];
  filters.push(`lastSoldDate:[${fromIso}..]`);
  if (params.condition) {
    const conditions = Array.isArray(params.condition)
      ? params.condition
      : [params.condition];
    if (conditions.length > 0) {
      filters.push(`conditions:{${conditions.join("|")}}`);
    }
  }
  if (params.priceMin !== undefined || params.priceMax !== undefined) {
    const lo = params.priceMin ?? 0;
    const hi = params.priceMax ?? "";
    filters.push(`price:[${lo}..${hi}]`);
    filters.push(`priceCurrency:${currencyForMarketplace(marketplaceId)}`);
  }
  return filters.join(",");
}

function quantile(sorted: number[], q: number): number | undefined {
  if (sorted.length === 0) return undefined;
  const idx = (sorted.length - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function round2(n: number | undefined): number | undefined {
  return n === undefined ? undefined : Math.round(n * 100) / 100;
}

function buildBucket(sortedPrices: number[]): SoldHistoryStatsBucket {
  const bucket: SoldHistoryStatsBucket = { sampleSize: sortedPrices.length };
  if (sortedPrices.length > 0) {
    bucket.min = round2(sortedPrices[0]);
    bucket.max = round2(sortedPrices[sortedPrices.length - 1]);
    bucket.mean = round2(
      sortedPrices.reduce((acc, v) => acc + v, 0) / sortedPrices.length
    );
    bucket.median = round2(quantile(sortedPrices, 0.5));
    bucket.p25 = round2(quantile(sortedPrices, 0.25));
    bucket.p75 = round2(quantile(sortedPrices, 0.75));
  }
  return bucket;
}

function computeStats(
  items: SoldItem[],
  total: number,
  marketplaceId: string
): SoldHistoryStats {
  const primaryCurrency = currencyForMarketplace(marketplaceId);

  const pricesByCurrency: Record<string, number[]> = {};
  for (const item of items) {
    if (!item.soldPrice) continue;
    const v = parseFloat(item.soldPrice.value);
    if (!Number.isFinite(v)) continue;
    const currency = item.soldPrice.currency || primaryCurrency;
    if (!pricesByCurrency[currency]) pricesByCurrency[currency] = [];
    pricesByCurrency[currency].push(v);
  }

  const byCurrency: Record<string, SoldHistoryStatsBucket> = {};
  let totalSampleSize = 0;
  for (const [currency, prices] of Object.entries(pricesByCurrency)) {
    prices.sort((a, b) => a - b);
    byCurrency[currency] = buildBucket(prices);
    totalSampleSize += prices.length;
  }

  const primary: SoldHistoryStatsBucket =
    byCurrency[primaryCurrency] ?? { sampleSize: 0 };

  return {
    sampleSize: totalSampleSize,
    total,
    primaryCurrency,
    primary,
    byCurrency,
  };
}

interface RawInsightsResponse {
  total?: number;
  limit?: number;
  offset?: number;
  next?: string;
  itemSales?: Array<{
    itemId?: string;
    title?: string;
    price?: { value?: string; currency?: string };
    lastSoldPrice?: { value?: string; currency?: string };
    lastSoldDate?: string;
    condition?: string;
    conditionId?: string;
    itemWebUrl?: string;
    seller?: { username?: string; feedbackPercentage?: string };
  }>;
}

interface EbayError {
  errors?: Array<{
    errorId?: number;
    message?: string;
    longMessage?: string;
  }>;
}

async function callInsightsRest<T>(
  config: AuthConfig,
  path: string,
  qs: URLSearchParams,
  marketplaceId: string,
  fetchImpl: typeof fetch
): Promise<T> {
  const scopes = [DEFAULT_SCOPE, INSIGHTS_SCOPE];
  const token = await getAppToken(config, { fetchImpl, scopes });
  const doRequest = async (accessToken: string, base: string) =>
    withTimeout(
      fetchImpl(`${base}${path}?${qs.toString()}`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "X-EBAY-C-MARKETPLACE-ID": marketplaceId,
          Accept: "application/json",
        },
      }),
      `ebay.insights ${path}`,
      config.httpTimeoutMs
    );
  let res = await doRequest(token.access_token, apiBaseUrl(token.environment));
  if (res.status === 401) {
    const refreshed = await getAppToken(config, {
      force: true,
      fetchImpl,
      scopes,
    });
    if (refreshed.environment !== token.environment) {
      throw new Error(
        `eBay environment changed mid-request (${token.environment} → ${refreshed.environment}). Restart the OpenClaw gateway to pick up the new credentials cleanly.`
      );
    }
    res = await doRequest(refreshed.access_token, apiBaseUrl(refreshed.environment));
  }
  if (!res.ok) {
    const text = await res.text();
    let parsed: EbayError | undefined;
    try {
      parsed = JSON.parse(text) as EbayError;
    } catch {
      parsed = undefined;
    }
    const errorId = parsed?.errors?.[0]?.errorId;
    const message =
      parsed?.errors?.[0]?.longMessage ??
      parsed?.errors?.[0]?.message ??
      text.slice(0, 300);
    const hint =
      res.status === 403 || /scope/i.test(message)
        ? " (hint: your eBay app may not yet have Marketplace Insights access; apply via the eBay Developer portal)"
        : "";
    throw new Error(
      `eBay Insights API call failed (${res.status} ${res.statusText}${errorId ? ` errorId=${errorId}` : ""}): ${message}${hint}`
    );
  }
  return (await res.json()) as T;
}

export async function getSoldHistory(
  config: AuthConfig,
  params: SoldHistoryParams,
  fetchImpl: typeof fetch = fetch
): Promise<SoldHistoryResult> {
  if (!params.query || params.query.trim() === "") {
    throw new Error("getSoldHistory: query is required and cannot be empty.");
  }
  const requestedDays = params.days ?? DEFAULT_DAYS;
  if (requestedDays < 1 || requestedDays > MAX_DAYS) {
    throw new Error(
      `getSoldHistory: days must be between 1 and ${MAX_DAYS} (Marketplace Insights window cap).`
    );
  }
  const limit = params.limit ?? 50;
  if (limit < 1 || limit > 100) {
    throw new Error("getSoldHistory: limit must be between 1 and 100.");
  }
  const offset = params.offset ?? 0;
  const marketplaceId = params.marketplaceId ?? DEFAULT_MARKETPLACE;
  const now = Date.now();
  const fromIso = new Date(
    now - requestedDays * 24 * 60 * 60 * 1000
  ).toISOString();
  const toIso = new Date(now).toISOString();

  const qs = new URLSearchParams();
  qs.set("q", params.query);
  qs.set("limit", String(limit));
  qs.set("offset", String(offset));
  qs.set("filter", buildFilterParam(params, fromIso, marketplaceId));
  const sort = buildSortParam(params.sort);
  if (sort) qs.set("sort", sort);

  const raw = await callInsightsRest<RawInsightsResponse>(
    config,
    "/buy/marketplace_insights/v1/item_sales/search",
    qs,
    marketplaceId,
    fetchImpl
  );

  const items: SoldItem[] = (raw.itemSales ?? []).map((sale) => ({
    itemId: sale.itemId ?? "",
    title: sale.title ?? "",
    soldPrice:
      sale.lastSoldPrice && sale.lastSoldPrice.value
        ? {
            value: sale.lastSoldPrice.value,
            currency: sale.lastSoldPrice.currency ?? "USD",
          }
        : sale.price && sale.price.value
          ? {
              value: sale.price.value,
              currency: sale.price.currency ?? "USD",
            }
          : undefined,
    lastSoldDate: sale.lastSoldDate,
    condition: sale.condition,
    conditionId: sale.conditionId,
    itemWebUrl: sale.itemWebUrl,
    seller: sale.seller,
  }));

  const total = raw.total ?? items.length;
  const stats = computeStats(items, total, marketplaceId);

  return {
    query: params.query,
    marketplaceId,
    windowDays: requestedDays,
    windowFrom: fromIso,
    windowTo: toIso,
    stats,
    items,
    next: raw.next,
    truncated: total > items.length,
  };
}

export const _internal = {
  buildSortParam,
  buildFilterParam,
  computeStats,
  quantile,
};
