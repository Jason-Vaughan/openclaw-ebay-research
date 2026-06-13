import {
  apiBaseUrl,
  getAppToken,
  withTimeout,
  currencyForMarketplace,
  type AuthConfig,
} from "./auth.js";

export type SortOption = "price_asc" | "price_desc" | "best_match" | "newly_listed";
export type ConditionFilter = "NEW" | "USED" | "UNSPECIFIED" | "CERTIFIED_REFURBISHED" | "SELLER_REFURBISHED" | "MANUFACTURER_REFURBISHED" | "FOR_PARTS_OR_NOT_WORKING";

export interface SearchParams {
  query: string;
  sort?: SortOption;
  condition?: ConditionFilter | ConditionFilter[];
  priceMin?: number;
  priceMax?: number;
  marketplaceId?: string;
  limit?: number;
  offset?: number;
  categoryIds?: string[];
}

export interface SearchResult {
  total: number;
  limit: number;
  offset: number;
  items: SearchItemSummary[];
  href?: string;
  next?: string;
  prev?: string;
}

export interface SearchItemSummary {
  itemId: string;
  title: string;
  price?: { value: string; currency: string };
  /** eBay buying options: FIXED_PRICE, AUCTION, BEST_OFFER (can be multiple). */
  buyingOptions?: string[];
  /** Present for auctions — the current high bid (distinct from `price`). */
  currentBidPrice?: { value: string; currency: string };
  /** Number of bids placed (auctions). */
  bidCount?: number;
  condition?: string;
  conditionId?: string;
  itemWebUrl?: string;
  itemHref?: string;
  seller?: { username?: string; feedbackPercentage?: string; feedbackScore?: number };
  itemLocation?: { country?: string; postalCode?: string };
  image?: { imageUrl?: string };
  thumbnailImages?: Array<{ imageUrl?: string }>;
  shippingOptions?: Array<{
    shippingCost?: { value: string; currency: string };
    shippingCostType?: string;
  }>;
}

export interface GetItemParams {
  itemId: string;
  marketplaceId?: string;
}

const DEFAULT_MARKETPLACE = "EBAY_US";

function buildSortParam(sort?: SortOption): string | undefined {
  switch (sort) {
    case "price_asc":
      return "price";
    case "price_desc":
      return "-price";
    case "newly_listed":
      return "newlyListed";
    case "best_match":
    case undefined:
      return undefined;
    default:
      return undefined;
  }
}

function buildFilterParam(
  params: SearchParams,
  marketplaceId: string
): string | undefined {
  const filters: string[] = [];
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
  return filters.length > 0 ? filters.join(",") : undefined;
}

interface EbayError {
  errors?: Array<{
    errorId?: number;
    domain?: string;
    category?: string;
    message?: string;
    longMessage?: string;
  }>;
}

async function callBrowse<T>(
  config: AuthConfig,
  path: string,
  params: URLSearchParams | undefined,
  marketplaceId: string,
  fetchImpl: typeof fetch = fetch
): Promise<T> {
  const token = await getAppToken(config, { fetchImpl });
  const qs = params && Array.from(params.keys()).length > 0 ? `?${params.toString()}` : "";
  const doRequest = async (accessToken: string, base: string) =>
    withTimeout(
      fetchImpl(`${base}${path}${qs}`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "X-EBAY-C-MARKETPLACE-ID": marketplaceId,
          Accept: "application/json",
        },
      }),
      `ebay.browse ${path}`,
      config.httpTimeoutMs
    );

  let res = await doRequest(token.access_token, apiBaseUrl(token.environment));
  if (res.status === 401) {
    const refreshed = await getAppToken(config, { force: true, fetchImpl });
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
    throw new Error(
      `eBay Browse API call failed (${res.status} ${res.statusText}${errorId ? ` errorId=${errorId}` : ""}): ${message}`
    );
  }
  return (await res.json()) as T;
}

interface RawSearchResponse {
  total?: number;
  limit?: number;
  offset?: number;
  href?: string;
  next?: string;
  prev?: string;
  itemSummaries?: SearchItemSummary[];
}

export async function searchActiveListings(
  config: AuthConfig,
  params: SearchParams,
  fetchImpl: typeof fetch = fetch
): Promise<SearchResult> {
  if (!params.query || params.query.trim() === "") {
    throw new Error("searchActiveListings: query is required and cannot be empty.");
  }
  const limit = params.limit ?? 10;
  if (limit < 1 || limit > 200) {
    throw new Error("searchActiveListings: limit must be between 1 and 200.");
  }
  const offset = params.offset ?? 0;
  if (offset < 0) {
    throw new Error("searchActiveListings: offset must be >= 0.");
  }
  if (offset + limit > 10_000) {
    throw new Error(
      "searchActiveListings: offset + limit must be <= 10000 (eBay Browse hard cap)."
    );
  }
  const marketplaceId = params.marketplaceId ?? DEFAULT_MARKETPLACE;
  const qs = new URLSearchParams();
  qs.set("q", params.query);
  qs.set("limit", String(limit));
  qs.set("offset", String(offset));
  const sort = buildSortParam(params.sort);
  if (sort) qs.set("sort", sort);
  const filter = buildFilterParam(params, marketplaceId);
  if (filter) qs.set("filter", filter);
  if (params.categoryIds && params.categoryIds.length > 0) {
    qs.set("category_ids", params.categoryIds.join(","));
  }
  const raw = await callBrowse<RawSearchResponse>(
    config,
    "/buy/browse/v1/item_summary/search",
    qs,
    marketplaceId,
    fetchImpl
  );
  return {
    total: raw.total ?? 0,
    limit: raw.limit ?? limit,
    offset: raw.offset ?? offset,
    href: raw.href,
    next: raw.next,
    prev: raw.prev,
    items: raw.itemSummaries ?? [],
  };
}

export async function getItem(
  config: AuthConfig,
  params: GetItemParams,
  fetchImpl: typeof fetch = fetch
): Promise<Record<string, unknown>> {
  if (!params.itemId || params.itemId.trim() === "") {
    throw new Error("getItem: itemId is required.");
  }
  const marketplaceId = params.marketplaceId ?? DEFAULT_MARKETPLACE;
  const path = `/buy/browse/v1/item/${encodeURIComponent(params.itemId)}`;
  return callBrowse<Record<string, unknown>>(
    config,
    path,
    undefined,
    marketplaceId,
    fetchImpl
  );
}

export const _internal = {
  buildSortParam,
  buildFilterParam,
};
