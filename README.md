# @jason-vaughan/openclaw-ebay-research

**Read-only eBay market research for your [OpenClaw](https://openclaw.ai) agent** — search live listings, see what's *actually selling*, fetch item detail, look up the right category, and (with eBay Insights access) pull true sold-price history. Direct REST via the `client_credentials` OAuth flow: an app token only. **No seller account. No user OAuth. No MCP server. No third-party gateway.**

> ⭐ **Find this plugin useful?** If `openclaw-ebay-research` saves you time, please **star it** (the ⭐ at the top of this ClawHub page) — stars help other resellers and OpenClaw operators discover it and keep it maintained. Thank you!

## Looking for...

- An OpenClaw plugin to **check what something sells for on eBay**? → yes, this.
- A way to see **what's *actually selling*** — real sales velocity, not just asking prices? → yes, the `whats_selling` tool.
- **Sold-price history** for an item over the last 90 days? → yes (once eBay grants you Marketplace Insights access).
- To **find the cheapest / best-deal** listing, with a clickable link? → yes.
- The **right eBay category** for something you're about to list? → yes (taxonomy lookup — feeds the sister seller plugin's `create_offer`).
- Full **detail on a specific listing**, or a pasted eBay URL? → yes.
- An eBay research plugin that talks **straight to eBay's REST API** — no MCP, no middleman SaaS? → yes, this is it.

Built for agents that need to answer questions like:

- *"What are used Nikon D750 bodies **actually selling** for?"* ← sales-velocity signal, units sold + price
- *"What does a Nikon D750 sell for on eBay right now?"*
- *"Find me a used Nikon D750 under $500 — cheapest first."*
- *"Tell me about this listing: https://www.ebay.com/itm/..."*
- *"What did Nikon D750s actually sell for in the last 90 days?"* (gated by Insights access)
- *"What category should this go in on eBay?"*

Every result ships with the canonical eBay `itemWebUrl`, so the agent hands you clickable links — not just price text.

## Status

**v0.3.0 — production-ready, 7 tools.** Auth status, active-listing search, **sales-velocity (`whats_selling`)**, item detail, category suggestions + subtree, and the gated sold-history tool. 163 unit tests; every release hardened through independent Critic review. Published on [ClawHub](https://clawhub.ai) as `@jason-vaughan/openclaw-ebay-research` and **live-validated against eBay production (2026-06-12)**. Deploys in "demo mode" without keys (tools register but return a clear credentials-not-configured error until you drop a credentials JSON in place).

## Tools

| Tool | Purpose |
|---|---|
| `ebay_research_auth_status` | Returns app-token state, environment (sandbox/production), expiry. Never echoes the token itself. |
| `ebay_research_search_active_listings` | Search current live listings. Filters: sort (price_asc/price_desc/best_match), condition, price_min/max, marketplace_id, limit, offset. Returns title, price, condition, seller, item_id, **itemWebUrl**. |
| `ebay_research_get_item` | Fetch full detail for one item by item_id. Includes itemWebUrl, seller info, shipping, full description. |
| `ebay_research_whats_selling` | **Sales-velocity signal** — which *live* listings have actually sold units (eBay `estimatedSoldQuantity`), at their current ask. One call searches then inspects the top `sampleSize` (default 10) listings, returns proven sellers (`minSoldQuantity`, default 1) sorted by units sold, plus `medianPrice` (the recommended anchor), min/max, and `soldWeightedMeanPrice` (secondary cross-check — weights current ask by lifetime units sold). Price stats are bucketed to the marketplace's primary currency. No special access needed — uses the base scope. The interim answer to "what's it *actually* selling for" while gated sold-history (below) is pending; note this reflects current asking prices on listings that have sold, not historical sold prices. |
| `ebay_research_get_category_suggestions` | "What category does this go in on eBay?" — free-text query → ranked list of suggestions with `categoryId`, `categoryName`, and full ancestor chain. The `categoryId` is exactly what `openclaw-ebay-seller`'s `create_offer` needs. |
| `ebay_research_get_category_subtree` | Drill down one level into a category by category_id. Each child node carries its own categoryId for further drill-down plus an `isLeaf` flag (sellable leaves are what `create_offer` requires). |
| `ebay_research_get_sold_history` | Historical SOLD listings + aggregate stats (min/max/mean/median/p25/p75) over a date window (default 90 days, max 90). Distinct from `search_active_listings` (which shows current asking prices). **Requires `enableInsights: true` AND eBay-granted Marketplace Insights API access.** When disabled, returns `{ status: 'disabled', reason }` so the agent can explain. |

## Install

1. **Create an eBay developer app** at <https://developer.ebay.com/my/keys>. You need either Sandbox keys (for testing) or Production keys (for real-world data). Note your `App ID (Client ID)` and `Cert ID (Client Secret)`.

2. **Write a credentials file** at `~/.openclaw/secrets/ebay-research-credentials.json` (mode `0600`):

   ```json
   {
     "client_id": "your-app-id",
     "cert_id": "your-cert-id",
     "environment": "sandbox"
   }
   ```

   Set `environment` to `production` once you've validated against sandbox.

3. **Install the plugin** into your OpenClaw gateway (typically inside the container):

   ```bash
   openclaw plugins install clawhub:@jason-vaughan/openclaw-ebay-research
   openclaw plugins enable tangleclaw-ebay-research
   ```

   > **Why two commands?** Community-installed OpenClaw plugins currently don't auto-enable on install — only bundled plugins do, due to a gating quirk in the OpenClaw runtime (filed upstream as [openclaw/openclaw#87188](https://github.com/openclaw/openclaw/issues/87188), with empirical confirmation). The plugin's tools load fine after just `install`, but the `ebay-research` SKILL.md (the agent-bias layer that biases against narrating-without-calling, encodes recipes, surfaces `itemWebUrl` on every result, etc.) shows as **blocked** with `Missing requirements: config:plugins.entries.tangleclaw-ebay-research.enabled`. The `plugins enable` command flips that flag and activates the skill. This plugin already ships `enabledByDefault: true` in its manifest, so the second command will become unnecessary once #87188 ships.

4. **Restart the gateway** so it picks up the new plugin.

5. Try it — ask the agent: *"what does a nikon d750 sell for on ebay?"*

## Configuration

Configurable via `plugins.entries.tangleclaw-ebay-research.config.*`:

| Key | Default | Description |
|---|---|---|
| `credentialsPath` | `~/.openclaw/secrets/ebay-research-credentials.json` | Path to the eBay app credentials JSON. |
| `tokenPath` | `~/.openclaw/secrets/ebay-research-app-token.json` | Path where the cached app token is written + read. |
| `defaultMarketplaceId` | `EBAY_US` | Default marketplace for searches if the agent doesn't specify one. |
| `enableInsights` | `false` | Enable `ebay_research_get_sold_history`. Requires eBay-granted Marketplace Insights API access; leave `false` until granted. |

### Enabling Marketplace Insights (sold-listing data)

`ebay_research_get_sold_history` calls eBay's **Marketplace Insights API**, which is a gated surface — you must apply for access through the eBay Developer portal before it works:

1. Sign in at <https://developer.ebay.com/> with your developer account.
2. Apply for **Marketplace Insights API** access (the listing is at the bottom of the API catalog page; approval is a separate process from regular app registration).
3. Once eBay grants access, set `plugins.entries.tangleclaw-ebay-research.config.enableInsights = true` and restart your OpenClaw gateway.
4. The plugin will request the additional `buy.marketplace.insights` OAuth scope automatically.

Until access is granted, leave `enableInsights = false`. The tool will still be visible to agents but will return a clear `{ status: "disabled", reason: "..." }` response rather than hitting an authorization error.

## How it works

- The plugin uses the `client_credentials` OAuth flow: at first tool call, it POSTs `client_id` + `cert_id` (HTTP Basic auth) to eBay's token endpoint and gets back an app-level access token (TTL ~2 hours). The token is cached at `tokenPath` and reused; when it expires, the plugin auto-refreshes silently.
- No user OAuth, no refresh tokens, no per-user consent — this token represents your eBay developer app, not any seller.
- Sandbox base URL: `https://api.sandbox.ebay.com`. Production: `https://api.ebay.com`. Decided by `environment` in your credentials file.
- All HTTP requests have a 30-second timeout.
- Errors return the eBay API's error code + message verbatim where possible.

## eBay API compliance (your responsibility as operator)

This plugin is a client for eBay's developer APIs. Installing it grants you **no** eBay API access — you bring your own eBay developer application and keyset, and your usage is governed by the agreements you accept when you register it:

- **Your own keyset, your own agreement.** Each operator must register their own application at <https://developer.ebay.com/my/keys> and accept the [eBay API License Agreement](https://developer.ebay.com/join/api-license-agreement). The plugin authors are not a party to your agreement with eBay; one operator's keyset must never be shared with another deployment.
- **Marketplace Account Deletion compliance.** eBay disables production keysets until you either stand up a deletion-notification endpoint or claim the exemption. This plugin persists no eBay user data, so the *"I do not persist eBay data"* exemption typically fits research-only deployments — but it is **your** attestation to make in the eBay portal.
- **Stay inside the License Agreement's data rules.** The agreement restricts deriving marketplace-level statistics — e.g., average selling price or GMV for an eBay category, or sales/activity rates across listings — except where the information is specific to the authenticated user and shown only to that user. Use this plugin's results for your own research and pricing decisions; do not republish aggregates, resell eBay data, or build public analytics on top of it.
- **Respect call limits.** The default limit (5,000 calls/day) is far above what interactive agent use produces. Don't wire these tools into high-frequency polling loops or bulk-harvesting jobs.
- **Sold-history access is granted by eBay, not by this plugin.** `get_sold_history` works only after eBay approves your application for the Marketplace Insights API (see [Enabling Marketplace Insights](#enabling-marketplace-insights-sold-listing-data)).

## Pairs well with

- [`@jason-vaughan/openclaw-ebay-seller`](https://github.com/Jason-Vaughan/openclaw-ebay-seller) (sister plugin — read+write seller-side tools with OAuth + approval gating). The seller plugin's `create_offer` needs a category_id, which is exactly what this plugin's `ebay_research_get_category_suggestions` returns. Install both side-by-side.

## More from TangleClaw

- [`@jason-vaughan/openclaw-google-oauth`](https://github.com/Jason-Vaughan/openclaw-google-oauth) — Google Workspace tools for your OpenClaw agent (Gmail, Calendar, Drive, Docs, Sheets, Slides) via direct OAuth. Useful alongside this plugin when your agent needs to email Gmail summaries of eBay research, drop a sold-price comparison into a Drive spreadsheet, or schedule a Calendar reminder around a listing window. Install: `openclaw plugins install clawhub:@jason-vaughan/openclaw-google-oauth`.

## Out of scope (deferred to later versions)

- Bulk pricing-engine analysis across many SKUs.
- Buyer-side checkout / cart APIs.
- Trading API fallbacks (used only if a REST gap forces it).
- eBay Motors / specialty marketplaces.

## License

MIT
