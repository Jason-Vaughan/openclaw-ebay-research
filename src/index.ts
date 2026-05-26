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
});

function authConfig(config: {
  credentialsPath: string;
  tokenPath: string;
}): AuthConfig {
  return {
    credentialsPath: config.credentialsPath,
    tokenPath: config.tokenPath,
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
        "SEARCH / FIND / LOOK UP / BROWSE current live eBay listings by keyword. ALWAYS call this tool — do not narrate, do not reuse previous results — whenever the operator asks: what does X sell for / cost on eBay, find me a deal on X, what's the cheapest X on eBay, find a Y condition X, what X are available, browse / search eBay for X, show me listings for X, what's listed on eBay right now for X. Live listings change minute-to-minute, so always re-run a fresh query — never assume an earlier result is still current. Returns up to `limit` items (default 10). Each item includes title, price, condition, seller, item_id, AND a clickable `itemWebUrl` (the canonical eBay URL the operator can open in their browser). Pass `sort='price_asc'` for cheapest-first / best-deal queries. Pass `condition` to filter to USED, NEW, etc. Pass `priceMax` to cap. Pass `priceMin` to floor. Pass `marketplaceId` (default EBAY_US) to switch markets. Pair with `ebay_research_get_item` to drill into a specific result.",
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
              "Optional eBay category id filter. Get category ids from a Taxonomy API tool (future ebay_research_get_categories).",
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
