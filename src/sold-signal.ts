import { type AuthConfig, currencyForMarketplace } from "./auth.js";
import {
  searchActiveListings,
  getItem,
  type SortOption,
  type ConditionFilter,
} from "./browse.js";

export interface SalesVelocityParams {
  query: string;
  condition?: ConditionFilter | ConditionFilter[];
  priceMin?: number;
  priceMax?: number;
  marketplaceId?: string;
  /** How many top search results to inspect with getItem. Default 10, max 20. */
  sampleSize?: number;
  /** Drop listings whose estimatedSoldQuantity is below this. Default 1 (proven sellers only); pass 0 to keep everything inspected. */
  minSoldQuantity?: number;
  sort?: SortOption;
}

export interface SalesVelocityItem {
  itemId: string;
  title?: string;
  price?: { value: string; currency: string };
  condition?: string;
  itemWebUrl?: string;
  seller?: { username?: string; feedbackPercentage?: string };
  /** Estimated units sold on this ACTIVE listing (eBay Browse estimatedAvailabilities). */
  estimatedSoldQuantity: number;
  estimatedAvailabilityStatus?: string;
  estimatedAvailableQuantity?: number;
}

export interface SalesVelocityStats {
  /** The marketplace's primary currency. ALL price stats below are computed over ONLY items priced in this currency. */
  currency: string;
  /** Listings meeting minSoldQuantity (across all currencies). */
  matchedCount: number;
  /** How many of the matched listings were priced in `currency` and thus included in the price stats. */
  pricedInCurrency: number;
  /** Total estimated units sold across all matched listings (currency-agnostic count). */
  totalSoldQuantity: number;
  /** True if matched listings carried more than one currency; off-currency listings are EXCLUDED from price stats (see items[].price for their native currency). */
  mixedCurrencies: boolean;
  /** Plain median of current asking prices (primary currency) — the safest single pricing anchor. */
  medianPrice?: number;
  minPrice?: number;
  maxPrice?: number;
  /**
   * Current asking price weighted by estimatedSoldQuantity (primary currency only).
   * CAVEAT: weights each listing's CURRENT ask by its LIFETIME units sold, so one high-volume
   * listing can dominate. Use as a secondary cross-check against medianPrice, not a sole anchor.
   */
  soldWeightedMeanPrice?: number;
}

export interface SalesVelocityResult {
  query: string;
  marketplaceId: string;
  /** Listings fetched + inspected via getItem. inspected === matchedCount + belowThreshold + skipped. */
  inspected: number;
  /** Inspected listings whose sold quantity was below minSoldQuantity (dropped from items). */
  belowThreshold: number;
  /** Inspections that failed (item became unavailable mid-flight etc.) — skipped, not fatal. */
  skipped: number;
  /** Listings meeting minSoldQuantity, sorted by estimatedSoldQuantity descending. */
  items: SalesVelocityItem[];
  stats: SalesVelocityStats;
  note: string;
}

const DEFAULT_MARKETPLACE = "EBAY_US";
const DEFAULT_SAMPLE_SIZE = 10;
const MAX_SAMPLE_SIZE = 20;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

interface RawAvailability {
  estimatedSoldQuantity?: number;
  estimatedAvailableQuantity?: number;
  estimatedAvailabilityStatus?: string;
}

/** Sum sold quantities across availability entries (multi-variation listings can carry several). */
function soldQuantityOf(detail: Record<string, unknown>): {
  sold: number;
  status?: string;
  available?: number;
} {
  const avails = detail.estimatedAvailabilities as RawAvailability[] | undefined;
  if (!Array.isArray(avails) || avails.length === 0) {
    return { sold: 0 };
  }
  let sold = 0;
  let available: number | undefined;
  for (const a of avails) {
    if (typeof a?.estimatedSoldQuantity === "number") sold += a.estimatedSoldQuantity;
    if (typeof a?.estimatedAvailableQuantity === "number") {
      available = (available ?? 0) + a.estimatedAvailableQuantity;
    }
  }
  return { sold, status: avails[0]?.estimatedAvailabilityStatus, available };
}

export async function getSalesVelocity(
  config: AuthConfig,
  params: SalesVelocityParams,
  fetchImpl: typeof fetch = fetch
): Promise<SalesVelocityResult> {
  if (!params.query || params.query.trim() === "") {
    throw new Error("getSalesVelocity: query is required and cannot be empty.");
  }
  const sampleSize = params.sampleSize ?? DEFAULT_SAMPLE_SIZE;
  if (sampleSize < 1 || sampleSize > MAX_SAMPLE_SIZE) {
    throw new Error(
      `getSalesVelocity: sampleSize must be between 1 and ${MAX_SAMPLE_SIZE}.`
    );
  }
  const minSold = params.minSoldQuantity ?? 1;
  if (minSold < 0) {
    throw new Error("getSalesVelocity: minSoldQuantity must be >= 0.");
  }
  const marketplaceId = params.marketplaceId ?? DEFAULT_MARKETPLACE;

  const search = await searchActiveListings(
    config,
    {
      query: params.query,
      condition: params.condition,
      priceMin: params.priceMin,
      priceMax: params.priceMax,
      marketplaceId,
      sort: params.sort,
      limit: sampleSize,
    },
    fetchImpl
  );

  const summaries = search.items.filter((s) => s.itemId);
  const detailResults = await Promise.allSettled(
    summaries.map((s) => getItem(config, { itemId: s.itemId, marketplaceId }, fetchImpl))
  );

  let skipped = 0;
  let belowThreshold = 0;
  const items: SalesVelocityItem[] = [];
  detailResults.forEach((res, i) => {
    if (res.status === "rejected") {
      skipped += 1;
      return;
    }
    const detail = res.value;
    const summary = summaries[i];
    const { sold, status, available } = soldQuantityOf(detail);
    if (sold < minSold) {
      belowThreshold += 1;
      return;
    }
    const price =
      (detail.price as SalesVelocityItem["price"]) ?? summary.price ?? undefined;
    items.push({
      itemId: summary.itemId,
      title: (detail.title as string) ?? summary.title,
      price,
      condition: (detail.condition as string) ?? summary.condition,
      itemWebUrl: (detail.itemWebUrl as string) ?? summary.itemWebUrl,
      seller: summary.seller
        ? {
            username: summary.seller.username,
            feedbackPercentage: summary.seller.feedbackPercentage,
          }
        : undefined,
      estimatedSoldQuantity: sold,
      estimatedAvailabilityStatus: status,
      estimatedAvailableQuantity: available,
    });
  });

  items.sort((a, b) => b.estimatedSoldQuantity - a.estimatedSoldQuantity);

  // Price stats are computed ONLY over the marketplace's primary currency.
  // Mixing currencies into one mean/median is meaningless, so off-currency
  // listings stay in `items` (with their native currency) but are excluded here.
  const primaryCurrency = currencyForMarketplace(marketplaceId);
  const currenciesSeen = new Set(
    items.map((it) => it.price?.currency).filter((c): c is string => Boolean(c))
  );
  const priced = items
    .filter((it) => it.price?.currency === primaryCurrency)
    .map((it) => ({ qty: it.estimatedSoldQuantity, value: parseFloat(it.price?.value ?? "") }))
    .filter((p) => Number.isFinite(p.value));

  const stats: SalesVelocityStats = {
    currency: primaryCurrency,
    matchedCount: items.length,
    pricedInCurrency: priced.length,
    totalSoldQuantity: items.reduce((acc, it) => acc + it.estimatedSoldQuantity, 0),
    mixedCurrencies: currenciesSeen.size > 1,
  };
  if (priced.length > 0) {
    const values = priced.map((p) => p.value).sort((a, b) => a - b);
    const mid = Math.floor(values.length / 2);
    const median =
      values.length % 2 === 0 ? (values[mid - 1] + values[mid]) / 2 : values[mid];
    const totalQty = priced.reduce((acc, p) => acc + p.qty, 0);
    stats.minPrice = round2(values[0]);
    stats.maxPrice = round2(values[values.length - 1]);
    stats.medianPrice = round2(median);
    stats.soldWeightedMeanPrice =
      totalQty > 0
        ? round2(priced.reduce((acc, p) => acc + p.value * p.qty, 0) / totalQty)
        : undefined;
  }

  return {
    query: params.query,
    marketplaceId,
    inspected: summaries.length,
    belowThreshold,
    skipped,
    items,
    stats,
    note:
      "Sales-velocity signal from ACTIVE listings (eBay estimatedSoldQuantity): units sold on listings that are still live, priced at their CURRENT ask. This is NOT historical sold-transaction data — for true sold prices use ebay_research_get_sold_history (requires eBay Marketplace Insights access). Price stats cover only " +
      primaryCurrency +
      "-priced listings" +
      (stats.mixedCurrencies ? " (other currencies were found and excluded from the stats)." : "."),
  };
}
