import { Type } from "typebox";
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { getAuthStatus, type AuthConfig } from "./auth.js";
import {
  searchActiveListings,
  getItem,
  type SortOption,
  type ConditionFilter,
} from "./browse.js";
import {
  getCategorySuggestions,
  getCategorySubtree,
} from "./taxonomy.js";
import { getSoldHistory } from "./insights.js";
import { getSalesVelocity } from "./sold-signal.js";

const configSchema = Type.Object({
  credentialsPath: Type.String({
    default: "~/.openclaw/secrets/ebay-research-credentials.json",
    description:
      "Path to the eBay app credentials JSON. Required keys: client_id, cert_id, environment ('sandbox' or 'production').",
  }),
  tokenPath: Type.String({
    default: "~/.openclaw/secrets/ebay-research-app-token.json",
    description:
      "Path where the cached app token is read + written (auto-refreshed when expired).",
  }),
  defaultMarketplaceId: Type.String({
    default: "EBAY_US",
    description:
      "Marketplace used when the agent doesn't specify one (e.g., EBAY_US, EBAY_GB, EBAY_DE).",
  }),
  enableInsights: Type.Boolean({
    default: false,
    description:
      "Enable the ebay_research_get_sold_history tool. Requires eBay-granted Marketplace Insights API access (apply via the eBay Developer portal). When false, the tool returns a clear 'disabled' status without calling the API.",
  }),
  httpTimeoutMs: Type.Optional(
    Type.Integer({
      minimum: 1000,
      default: 30000,
      description:
        "HTTP request timeout in milliseconds (applies to every eBay REST call + the token endpoint). Default 30000 (30s). Raise on slow networks.",
    })
  ),
  tokenRefreshSafetyWindowMs: Type.Optional(
    Type.Integer({
      minimum: 0,
      default: 60000,
      description:
        "How many milliseconds before token expiry to proactively refresh. Default 60000 (60s). Lower for tighter freshness windows; raise if you observe race-window 401s.",
    })
  ),
});

function authConfig(config: {
  credentialsPath: string;
  tokenPath: string;
  httpTimeoutMs?: number;
  tokenRefreshSafetyWindowMs?: number;
}): AuthConfig {
  return {
    credentialsPath: config.credentialsPath,
    tokenPath: config.tokenPath,
    httpTimeoutMs: config.httpTimeoutMs,
    tokenRefreshSafetyWindowMs: config.tokenRefreshSafetyWindowMs,
  };
}

export default defineToolPlugin({
  id: "tangleclaw-ebay-research",
  name: "TangleClaw eBay Research",
  description:
    "OpenClaw plugin for read-only eBay market research — search current listings, fetch item detail, look up sold-listing history (gated by eBay Marketplace Insights access). Direct REST via client_credentials OAuth (app token only — no seller account, no user OAuth, no MCP). Surfaces clickable itemWebUrl on every result.",
  configSchema,
  tools: (tool) => [
    tool({
      name: "ebay_research_auth_status",
      label: "eBay Research Auth Status",
      description:
        "READ / CHECK / SHOW the eBay Research plugin's app-token connection state. Returns whether credentials are present, the active environment (sandbox or production), cached-token expiry, and a reason if not connected. Never echoes the token itself. Call this when the operator asks 'is ebay connected', 'check ebay status', 'is the research plugin configured', or to debug why a search is failing.",
      parameters: Type.Object({}),
      async execute(_params, config) {
        return getAuthStatus(authConfig(config));
      },
    }),
    tool({
      name: "ebay_research_search_active_listings",
      label: "Search Active eBay Listings",
      description:
        "SEARCH / FIND / LOOK UP / BROWSE current live eBay listings by keyword. ALWAYS call this tool — do not narrate, do not reuse previous results — whenever the operator asks: what does X sell for / cost on eBay, find me a deal on X, what's the cheapest X on eBay, find a Y condition X, what X are available, browse / search eBay for X, show me listings for X, what's listed on eBay right now for X. Live listings change minute-to-minute, so always re-run a fresh query — never assume an earlier result is still current. Returns up to `limit` items (default 10). Each item includes title, price, condition, seller, item_id, AND a clickable `itemWebUrl` (the canonical eBay URL the operator can open in their browser). CRITICAL — 'what does X cost / what's it going for / what's the price of X' is a MARKET-PRICE question, NOT a cheapest question: do NOT `sort='price_asc'` and do NOT report the lowest listing as 'the price'. For branded or high-value items (GPUs, cameras, phones, consoles, laptops...) the cheapest keyword matches are almost always ACCESSORIES — brackets, cables, fan shrouds, parts, manuals — that keyword-stuff the product name; sorting cheapest-first surfaces $13 junk while the real item sits below the fold. Defend against this: apply a `priceMin` floor sized to the item (hundreds, even thousands for a GPU/workstation) and/or a `categoryIds` filter, and report a representative middle-of-pack price, never the floor. For a real 'what is it worth' answer, PREFER `ebay_research_whats_selling` (it leads with the median of what's actually selling). ONLY use `sort='price_asc'` when the operator explicitly wants the cheapest / a deal / 'find me a cheap X'. Pass `condition` to filter to USED, NEW, etc. Pass `priceMax` to cap. Pass `priceMin` to floor (use liberally for expensive items). Pass `marketplaceId` (default EBAY_US) to switch markets. Pair with `ebay_research_get_item` to drill into a specific result.",
      parameters: Type.Object({
        query: Type.String({
          description:
            "Search keywords (eBay's free-text search box). Examples: 'nikon d750', 'macbook pro 16 m1', 'levi 501 raw denim'.",
        }),
        sort: Type.Optional(
          Type.Union(
            [
              Type.Literal("price_asc"),
              Type.Literal("price_desc"),
              Type.Literal("best_match"),
              Type.Literal("newly_listed"),
            ],
            {
              description:
                "Result order. 'price_asc' = cheapest first (use for best-deal queries). 'price_desc' = most expensive first. 'newly_listed' = most recently listed. Default 'best_match' = eBay's relevance ranking.",
            }
          )
        ),
        condition: Type.Optional(
          Type.Union(
            [
              Type.Literal("NEW"),
              Type.Literal("USED"),
              Type.Literal("UNSPECIFIED"),
              Type.Literal("CERTIFIED_REFURBISHED"),
              Type.Literal("SELLER_REFURBISHED"),
              Type.Literal("MANUFACTURER_REFURBISHED"),
              Type.Literal("FOR_PARTS_OR_NOT_WORKING"),
            ],
            {
              description:
                "Filter to a single item condition. Most common: 'NEW' or 'USED'.",
            }
          )
        ),
        priceMin: Type.Optional(
          Type.Number({
            minimum: 0,
            description: "Minimum price filter (in marketplace currency, default USD).",
          })
        ),
        priceMax: Type.Optional(
          Type.Number({
            minimum: 0,
            description: "Maximum price filter (in marketplace currency, default USD).",
          })
        ),
        marketplaceId: Type.Optional(
          Type.String({
            description:
              "eBay marketplace id (e.g., EBAY_US, EBAY_GB, EBAY_DE). Defaults to the plugin's defaultMarketplaceId (EBAY_US unless reconfigured).",
          })
        ),
        limit: Type.Optional(
          Type.Integer({
            minimum: 1,
            maximum: 200,
            default: 10,
            description: "How many results to return (1-200). Default 10.",
          })
        ),
        offset: Type.Optional(
          Type.Integer({
            minimum: 0,
            default: 0,
            description: "Pagination offset (default 0). Combine with limit for pages.",
          })
        ),
        categoryIds: Type.Optional(
          Type.Array(Type.String(), {
            description:
              "Optional eBay category id filter. Get category ids from `ebay_research_get_category_suggestions` or `ebay_research_get_category_subtree`.",
          })
        ),
      }),
      async execute(params, config) {
        const cfg = {
          ...authConfig(config),
        };
        const marketplaceId =
          params.marketplaceId ??
          (config as { defaultMarketplaceId?: string }).defaultMarketplaceId ??
          "EBAY_US";
        const result = await searchActiveListings(cfg, {
          query: params.query,
          sort: params.sort as SortOption | undefined,
          condition: params.condition as ConditionFilter | undefined,
          priceMin: params.priceMin,
          priceMax: params.priceMax,
          marketplaceId,
          limit: params.limit,
          offset: params.offset,
          categoryIds: params.categoryIds,
        });
        return {
          marketplaceId,
          total: result.total,
          limit: result.limit,
          offset: result.offset,
          count: result.items.length,
          items: result.items.map((item) => ({
            itemId: item.itemId,
            title: item.title,
            price: item.price,
            condition: item.condition,
            seller: item.seller,
            itemLocation: item.itemLocation,
            imageUrl: item.image?.imageUrl,
            itemWebUrl: item.itemWebUrl,
            shipping: item.shippingOptions?.[0]?.shippingCost,
          })),
          next: result.next,
        };
      },
    }),
    tool({
      name: "ebay_research_get_item",
      label: "Get eBay Item Detail",
      description:
        "READ / VIEW / FETCH / SHOW the full detail of one eBay listing by item_id. Call this — do not narrate — when the operator asks to see / view / read / tell me about / drill into / get details on a specific eBay listing, OR when the operator pastes an eBay URL (parse the item_id from the URL path). Returns full title, full description, all images, seller, condition, shipping options, return policy, item location, listing format (auction/buy-it-now). Get the item_id from a prior `ebay_research_search_active_listings` call's results, or by parsing it from an eBay URL.",
      parameters: Type.Object({
        itemId: Type.String({
          description:
            "The eBay item id (looks like 'v1|123456789|0'). From a search result's itemId field, or parsed from an eBay item URL.",
        }),
        marketplaceId: Type.Optional(
          Type.String({
            description:
              "eBay marketplace id (default EBAY_US). Must match the marketplace where the item is listed.",
          })
        ),
      }),
      async execute(params, config) {
        const cfg = authConfig(config);
        const marketplaceId =
          params.marketplaceId ??
          (config as { defaultMarketplaceId?: string }).defaultMarketplaceId ??
          "EBAY_US";
        return getItem(cfg, {
          itemId: params.itemId,
          marketplaceId,
        });
      },
    }),
    tool({
      name: "ebay_research_whats_selling",
      label: "What's Actually Selling on eBay",
      description:
        "DEMAND-CHECK / SALES-VELOCITY signal: find which LIVE eBay listings for a query have actually sold units, and at what price. This is the GO-TO tool for any 'what does X cost / what's the price of X / what's X worth / what's it going for' question — PREFER it over a plain price_asc search, which reports cheapest-accessory junk instead of the real price. ALWAYS call this tool — do not narrate, do not substitute a plain search — whenever the operator asks: what does X cost, what's the price of X, what is X actually selling for, is X selling, what do X really go for, how fast does X sell, show me listings with real sales, demand check on X, which X are moving, price X based on real sales. One call does everything internally: searches live listings, inspects the top sampleSize of them (default 10) for eBay's estimatedSoldQuantity, and returns only proven sellers (minSoldQuantity, default 1) sorted by units sold. Lead your pricing answer with stats.medianPrice (the safest anchor) plus stats.totalSoldQuantity; treat stats.soldWeightedMeanPrice as a secondary cross-check only (it weights each listing's CURRENT ask by LIFETIME units sold, so one high-volume listing can skew it). Price stats cover only the marketplace's primary currency; if stats.mixedCurrencies is true, off-currency listings were excluded from the stats. IMPORTANT: estimatedSoldQuantity is units sold on listings still LIVE at their current ask — it is NOT historical sold-transaction data. Distinct from `ebay_research_search_active_listings` (asking prices only, no sales evidence) and from `ebay_research_get_sold_history` (true historical sold prices; requires gated Marketplace Insights access). Costs ~1+sampleSize API calls, so prefer the default sampleSize unless the operator asks for broader coverage. Pass priceMin (or condition) to keep accessory/junk listings out of the sample.",
      parameters: Type.Object({
        query: Type.String({
          description:
            "Search keywords, same as search_active_listings. Examples: 'nikon d750 body', 'iphone 14 128gb unlocked'.",
        }),
        condition: Type.Optional(
          Type.Union(
            [
              Type.Literal("NEW"),
              Type.Literal("USED"),
              Type.Literal("UNSPECIFIED"),
              Type.Literal("CERTIFIED_REFURBISHED"),
              Type.Literal("SELLER_REFURBISHED"),
              Type.Literal("MANUFACTURER_REFURBISHED"),
              Type.Literal("FOR_PARTS_OR_NOT_WORKING"),
            ],
            {
              description:
                "Filter to a single item condition. Most common: 'NEW' or 'USED'.",
            }
          )
        ),
        priceMin: Type.Optional(
          Type.Number({
            minimum: 0,
            description:
              "Minimum price filter — recommended to exclude accessory/junk listings keyword-stuffed with the product name.",
          })
        ),
        priceMax: Type.Optional(
          Type.Number({
            minimum: 0,
            description: "Maximum price filter (in marketplace currency, default USD).",
          })
        ),
        marketplaceId: Type.Optional(
          Type.String({
            description:
              "eBay marketplace id (e.g., EBAY_US, EBAY_GB). Defaults to the plugin's defaultMarketplaceId.",
          })
        ),
        sampleSize: Type.Optional(
          Type.Integer({
            minimum: 1,
            maximum: 20,
            default: 10,
            description:
              "How many top search results to inspect for sold quantity (1-20, default 10). Each costs one extra API call.",
          })
        ),
        minSoldQuantity: Type.Optional(
          Type.Integer({
            minimum: 0,
            default: 1,
            description:
              "Only return listings with at least this many units sold (default 1). Pass 0 to include zero-sale listings in the output too.",
          })
        ),
      }),
      async execute(params, config) {
        const cfg = authConfig(config);
        const marketplaceId =
          params.marketplaceId ??
          (config as { defaultMarketplaceId?: string }).defaultMarketplaceId ??
          "EBAY_US";
        return getSalesVelocity(cfg, {
          query: params.query,
          condition: params.condition as ConditionFilter | undefined,
          priceMin: params.priceMin,
          priceMax: params.priceMax,
          marketplaceId,
          sampleSize: params.sampleSize,
          minSoldQuantity: params.minSoldQuantity,
        });
      },
    }),
    tool({
      name: "ebay_research_get_category_suggestions",
      label: "Suggest eBay Categories",
      description:
        "LOOK UP / FIND / SUGGEST the eBay category an item belongs in by a free-text query. ALWAYS call this tool — do not narrate, do not guess a category id — whenever the operator asks: what category does X go in on eBay, what category is X listed in, what's the eBay category for X, find the right eBay category for X, where should I list X. Returns ranked suggestions; each suggestion has a `categoryId` (the value the seller plugin's create_offer needs), a `categoryName`, and an `ancestors` chain showing the full path (e.g. Cameras & Photo → Digital Cameras → DSLR Cameras). Pair with `ebay_research_get_category_subtree` to explore siblings of a suggested category.",
      parameters: Type.Object({
        query: Type.String({
          description:
            "Free-text describing the item. Examples: 'nikon d750', 'mens vintage leather jacket', 'iphone 14 pro 256gb'.",
        }),
        marketplaceId: Type.Optional(
          Type.String({
            description: "eBay marketplace id (default EBAY_US).",
          })
        ),
        limit: Type.Optional(
          Type.Integer({
            minimum: 1,
            maximum: 50,
            default: 10,
            description: "Max number of category suggestions to return (default 10).",
          })
        ),
      }),
      async execute(params, config) {
        const cfg = authConfig(config);
        const marketplaceId =
          params.marketplaceId ??
          (config as { defaultMarketplaceId?: string }).defaultMarketplaceId ??
          "EBAY_US";
        return getCategorySuggestions(cfg, {
          query: params.query,
          marketplaceId,
          limit: params.limit,
        });
      },
    }),
    tool({
      name: "ebay_research_get_sold_history",
      label: "Get eBay Sold History",
      description:
        "READ / FETCH historical SOLD listings on eBay for a query, over a date window (default 90 days, max 90 — Marketplace Insights API cap). ALWAYS call this tool — do not guess — whenever the operator asks: what did X actually sell for, what's the going rate for X, what have X been selling at, sold history for X, completed sales for X, how much did X sell for last month. Returns aggregate stats PLUS the raw sold-item list (with `itemWebUrl` for each). Stats are bucketed per currency: `stats.primaryCurrency` is the marketplace's currency, `stats.primary` has the sampleSize / min / max / mean / median / p25 / p75 for items in that currency (rounded to 2 decimals), and `stats.byCurrency` gives the per-currency breakdown when results mix. Distinct from `ebay_research_search_active_listings` (which shows current ASKING prices on live listings). REQUIRES `enableInsights: true` in plugin config AND an eBay-granted Marketplace Insights API access (apply at https://developer.ebay.com/). When disabled, returns a structured `{ status: 'disabled', reason }` rather than failing — that means access isn't configured, NOT that no sales happened.",
      parameters: Type.Object({
        query: Type.String({
          description:
            "Search keywords. Examples: 'nikon d750 body', 'macbook pro 16 m1 2021', 'levi 501 raw'.",
        }),
        days: Type.Optional(
          Type.Integer({
            minimum: 1,
            maximum: 90,
            default: 90,
            description: "Look-back window in days (1-90, capped by eBay).",
          })
        ),
        condition: Type.Optional(
          Type.Union(
            [
              Type.Literal("NEW"),
              Type.Literal("USED"),
              Type.Literal("UNSPECIFIED"),
              Type.Literal("CERTIFIED_REFURBISHED"),
              Type.Literal("SELLER_REFURBISHED"),
              Type.Literal("MANUFACTURER_REFURBISHED"),
              Type.Literal("FOR_PARTS_OR_NOT_WORKING"),
            ],
            { description: "Filter to a single condition. Most common: NEW or USED." }
          )
        ),
        priceMin: Type.Optional(Type.Number({ minimum: 0 })),
        priceMax: Type.Optional(Type.Number({ minimum: 0 })),
        marketplaceId: Type.Optional(
          Type.String({ description: "eBay marketplace id (default EBAY_US)." })
        ),
        limit: Type.Optional(
          Type.Integer({
            minimum: 1,
            maximum: 100,
            default: 50,
            description: "Page size (1-100). Larger sample = better statistics.",
          })
        ),
        offset: Type.Optional(Type.Integer({ minimum: 0, default: 0 })),
      }),
      async execute(params, config) {
        const insightsEnabled = (config as { enableInsights?: boolean }).enableInsights ?? false;
        if (!insightsEnabled) {
          return {
            status: "disabled",
            reason:
              "Marketplace Insights tool is disabled. Set plugins.entries.tangleclaw-ebay-research.config.enableInsights=true to enable, AND ensure your eBay app has been granted Marketplace Insights API access (apply at https://developer.ebay.com/).",
          };
        }
        const cfg = authConfig(config);
        const marketplaceId =
          params.marketplaceId ??
          (config as { defaultMarketplaceId?: string }).defaultMarketplaceId ??
          "EBAY_US";
        return getSoldHistory(cfg, {
          query: params.query,
          days: params.days,
          condition: params.condition as ConditionFilter | undefined,
          priceMin: params.priceMin,
          priceMax: params.priceMax,
          marketplaceId,
          limit: params.limit,
          offset: params.offset,
        });
      },
    }),
    tool({
      name: "ebay_research_get_category_subtree",
      label: "Get eBay Category Subtree",
      description:
        "READ / FETCH / VIEW the immediate children of an eBay category by category_id. Use to drill DOWN one level (e.g. given Cameras & Photo, list Digital Cameras / Film Cameras / Lenses ...). Each child node has its own categoryId for further drill-down, a categoryName, and an `isLeaf` flag (true means a sellable leaf category, which is what the seller plugin's create_offer requires). Get a starting categoryId from `ebay_research_get_category_suggestions` or from a parent category's children list.",
      parameters: Type.Object({
        categoryId: Type.String({
          description:
            "eBay category id (e.g. '625' for Cameras & Photo). Get from get_category_suggestions or from a parent subtree's children.",
        }),
        marketplaceId: Type.Optional(
          Type.String({
            description: "eBay marketplace id (default EBAY_US).",
          })
        ),
      }),
      async execute(params, config) {
        const cfg = authConfig(config);
        const marketplaceId =
          params.marketplaceId ??
          (config as { defaultMarketplaceId?: string }).defaultMarketplaceId ??
          "EBAY_US";
        return getCategorySubtree(cfg, {
          categoryId: params.categoryId,
          marketplaceId,
        });
      },
    }),
  ],
});
