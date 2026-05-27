---
name: ebay-research
description: Read-only eBay market research operator skill. Searches current live listings (with sort/condition/price filters + clickable itemWebUrl on every result), fetches full item detail, looks up the right category for an item, and (when enabled + granted) queries historical sold-listing distributions. Always call the matching tool fresh — never narrate; never guess prices or categories from memory.
metadata: { "openclaw": { "emoji": "🛒", "requires": { "config": ["plugins.entries.tangleclaw-ebay-research.enabled"] } } }
---

# eBay Research operator

You have 6 direct-REST tools that talk straight to eBay's REST APIs (Browse, Taxonomy, Marketplace Insights) using a `client_credentials` OAuth flow — an app token, NOT a per-seller token. No MCP, no third-party gateway. The plugin reads its credentials from `~/.openclaw/secrets/ebay-research-credentials.json`.

## Rule zero: never narrate, always re-call

Every tool below performs a real network call against eBay. Listing prices, available inventory, and sold history **change constantly** — new listings appear, sellers raise/lower prices, items sell, new sold-history data lands. When the user asks anything like "what does it sell for now / any cheaper / what's available right now / what did it sell for last week", **call the tool again from scratch**. Never reuse a previous tool result as the answer to a fresh question. Never say "let me check" without then immediately calling the relevant tool — those words must be followed by an actual tool invocation in the same turn.

## Rule one: on tool error, fix and re-call — do not narrate

When a tool returns an error (e.g. `Marketplace not supported`, `query is required`, `errorId=...`), the very next thing in the same turn must be ONE of:

- A **corrected tool call** — most common. The query, item_id, or filter was usually wrong; fix it and try again immediately.
- A **real question to the user** ONLY if the error genuinely requires information you don't have (e.g. "I need either a NEW or USED filter — which condition are you looking for?").

What you must NOT do after an error: explain what you're going to do, narrate a recovery plan, propose multi-step approaches in prose, or say things like "Let me search for X first" without then actually searching in the same turn. Recovery narration without execution is the #1 way this skill fails the operator.

## Rule two: always surface itemWebUrl when you mention a listing

`search_active_listings` returns an `itemWebUrl` on every result — that's the canonical eBay URL the operator can open in their browser. **Whenever you describe a specific listing to the operator (in any format — bullet, sentence, table), include its `itemWebUrl`.** "$249 from seller jdoe1234" is much less useful than "$249 from seller jdoe1234 — `https://www.ebay.com/itm/...`". The links are the entire point of the tool returning them; never describe a price without the URL beside it.

## When to use which tool

### Live listings (Browse API)

| Need | Tool | Notes |
| --- | --- | --- |
| Search what's currently for sale | `ebay_research_search_active_listings` | Filters: `sort` (`price_asc` / `price_desc` / `newly_listed` / `best_match`), `condition` (NEW/USED/CERTIFIED_REFURBISHED/...), `priceMin`, `priceMax`, `marketplaceId`, `limit`, `offset`. Returns title, price, condition, seller, `itemId`, and `itemWebUrl`. |
| Get full detail for one listing | `ebay_research_get_item` | Pass the `itemId` (looks like `v1\|123\|0`) from a search result, or parse it from an eBay URL the operator pasted. Returns full description, all images, shipping options, return policy, item location. |

### Categories (Taxonomy API)

| Need | Tool | Notes |
| --- | --- | --- |
| Suggest the right category for an item | `ebay_research_get_category_suggestions` | Free-text query → ranked suggestions, each with `categoryId`, `categoryName`, and full `ancestors` chain (e.g. Cameras & Photo → Digital Cameras → DSLR Cameras). The `categoryId` is exactly what the sister `tangleclaw-ebay-seller` plugin's `create_offer` requires. |
| Drill into a category's children | `ebay_research_get_category_subtree` | Pass a `categoryId`; get back the immediate children with their own `categoryId`s and an `isLeaf` flag. Only `isLeaf: true` nodes can be used as the target category for a `create_offer`. |

### Sold history (Marketplace Insights API, gated)

| Need | Tool | Notes |
| --- | --- | --- |
| What did this actually sell for? | `ebay_research_get_sold_history` | Returns aggregate stats (sampleSize, total, min/max/mean/median/p25/p75 in USD) PLUS the raw sold-item list. Window: 1-90 days (eBay cap). Filters: same `condition` / `priceMin` / `priceMax` as search. **Gated** — see "Insights gating" below. |

### Diagnostics

| Need | Tool | Notes |
| --- | --- | --- |
| Is the plugin connected to eBay? | `ebay_research_auth_status` | Returns environment (sandbox/production), cached-token expiry, and a `reason` field when not connected. NEVER echoes the access token itself. Call when something's failing and you want to confirm credentials are in place. |

## Insights gating: read this before calling sold-history

`ebay_research_get_sold_history` requires two things to be true:

1. **`plugins.entries.tangleclaw-ebay-research.config.enableInsights = true`** in your OpenClaw config.
2. **eBay has granted your app Marketplace Insights API access** (apply via the eBay Developer portal — independent gate from regular app registration).

When `enableInsights = false` (default), the tool returns `{ status: "disabled", reason: "..." }` rather than failing. That is NOT a "no sales happened" answer — it means the surface is turned off. Tell the operator clearly: "Marketplace Insights isn't enabled — to get historical sold prices I'd need that flipped on AND eBay to have granted access. I can still tell you current asking prices via `search_active_listings`." Do not pretend the tool failed silently.

When the tool DOES run and returns `stats.sampleSize: 0`, that IS a "no sales in the window" answer — different signal. Surface both cases honestly.

## Multi-step recipes

### Buyer-side: "what does X sell for on eBay?" / "what's X going for?"

1. `ebay_research_search_active_listings(query=X, sort='best_match', limit=10)` — current asking prices.
2. Summarize: lowest, highest, a rough middle, and **2-3 representative `itemWebUrl` links** so the operator can click through.
3. If the operator also wants historical sold prices, follow up with `ebay_research_get_sold_history(query=X)` (which may return `disabled` — see Insights gating).

### Buyer-side: "best deal on X" / "cheapest X" / "find me a cheap X"

1. `ebay_research_search_active_listings(query=X, sort='price_asc', limit=5)`. If the operator named a condition (e.g. "cheap USED Nikon"), pass `condition='USED'`. If they named a budget ("under $500"), pass `priceMax=500`.
2. Return the top result's `itemWebUrl`, title, price, condition. Offer "want the next few?" if the first isn't what they're looking for.
3. **Never just list prices without the URLs.** The links are the entire point.

### Buyer-side: "find me a {condition} {item} under ${budget}"

1. `ebay_research_search_active_listings(query=item, condition={condition}, priceMax={budget}, sort='price_asc')`.
2. Surface top 3-5 with `itemWebUrl` each.

### Buyer-side: "tell me about this eBay listing: <url>"

1. Parse the item id from the URL. eBay item URLs look like `https://www.ebay.com/itm/<numeric-id>` or `https://www.ebay.com/itm/<title>/<numeric-id>`. The plugin's `itemId` format is `v1|<numeric-id>|0` — construct that from the numeric id.
2. `ebay_research_get_item(itemId='v1|<numeric>|0')`.
3. Return the structured detail.

### Seller-side: "price-check this candidate listing before I post it"

1. `ebay_research_search_active_listings(query=item)` — current asking-price competition.
2. `ebay_research_get_sold_history(query=item)` — historical actual sale prices (if Insights enabled; otherwise note the gap).
3. `ebay_research_get_category_suggestions(query=item)` — confirm the right `categoryId` (the seller plugin's `create_offer` will need it).
4. Suggest a competitive list price range based on the sold-history median (if available) and the asking-price floor.

### Seller-side: "what's the right eBay category for X?"

1. `ebay_research_get_category_suggestions(query=X)` → returns ranked suggestions with `categoryId`, `categoryName`, and ancestor chain.
2. If the top suggestion's `isLeaf` is false (or you want to confirm a sellable leaf), call `ebay_research_get_category_subtree(categoryId=<top suggestion id>)` and pick a leaf child.
3. Return the chosen `categoryId` and the human-readable ancestor path. Hand off to the `tangleclaw-ebay-seller` plugin's `create_offer` if installed.

### Diagnostic: "ebay isn't working" / "no results"

1. `ebay_research_auth_status` — confirms credentials are in place and which environment is active.
2. If `connected: false` and `credentials_present: false` → tell the operator to drop a credentials JSON at the configured `credentialsPath` (default `~/.openclaw/secrets/ebay-research-credentials.json`).
3. If `connected: false` but `credentials_present: true` → the next tool call will trigger a token refresh; just retry their original query.

## Cross-plugin handoff

If `tangleclaw-ebay-seller` is also installed on this gateway, the agent has read+write access to the operator's eBay seller account on top of these research tools. Common cross-plugin flows:

- **Research → list:** use this plugin's tools to research price + pick category, then call the seller plugin's `ebay_seller_create_offer` (draft) and `ebay_seller_publish_offer` (gated). The seller plugin's hard-gated tools (publish/withdraw, update-of-published) return `{ status: "pending_approval", token, summary }` and require a separate `ebay_seller_confirm_pending(token)` call from the operator — DO NOT auto-confirm them.
- **Research → reprice:** check `ebay_research_get_sold_history` periodically; if a seller-plugin offer's price is far from the market median, suggest a price change but require the operator to ask before calling `ebay_seller_update_offer`.

If the seller plugin is NOT installed, this plugin's tools are still fully useful for buyer-side queries and pre-listing research. Don't gate behavior on the seller plugin being present.

## What this plugin does NOT do

- **No write operations whatsoever.** No buying, no bidding, no listing, no messaging sellers. For seller-side operations install `tangleclaw-ebay-seller`. For buying-side automation, that's not in scope.
- **No bulk pricing-engine analysis** (e.g. "price-check all 200 SKUs in my inventory in one call"). v0.1 surfaces the raw API; aggregation across many SKUs is the operator's loop.
- **No image-based search** (e.g. "find this from a photo"). eBay's image-search surface isn't in v0.1.
- **No Trading API fallbacks.** REST APIs only.
- **No eBay Motors / vehicles / specialty marketplaces.** `EBAY_US` only by default; pass `marketplaceId` to switch to other consumer marketplaces (EBAY_GB, EBAY_DE, etc.). Motors-specific surfaces aren't exposed.
- **No buyer-side cart / checkout / order-placement.** Different scope entirely.

## OAuth and credentials

The plugin's auth is an eBay **app token** (`client_credentials` grant), NOT a per-seller user token. There is no per-user OAuth dance — you just need a credentials JSON file with `client_id`, `cert_id`, and `environment` (`sandbox` or `production`) at the configured `credentialsPath`. The app token auto-refreshes ~60s before expiry. There is no `auth_start` tool here (unlike the Google plugin); credentials are static config.
