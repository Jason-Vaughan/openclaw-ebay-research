# @tangleclaw/openclaw-ebay-research

OpenClaw plugin for **read-only eBay market research** — search current listings, fetch item detail, look up categories, query sold-listing history. Direct REST via the `client_credentials` OAuth flow (app token only — no seller account, no user OAuth, no MCP, no third-party gateway).

Built for OpenClaw agents that need to answer questions like:

- *"What does a Nikon D750 sell for on eBay?"*
- *"What's the link to the best deal on a Nikon D750?"*
- *"Find me a used Nikon D750 under $500."*
- *"Tell me about this eBay listing: https://www.ebay.com/itm/..."*
- *"What did Nikon D750s actually sell for in the last 90 days?"* (gated by Insights access)
- *"What category should this go in on eBay?"* (taxonomy lookup — useful for seller plugins too)

Every search result includes the canonical eBay `itemWebUrl`, so the agent can hand the operator clickable links — not just price text.

## Status

**v0.1.0** — scaffold + first three tools (auth_status, search_active_listings, get_item). Sandbox-tested where live keys are available; deploys in "demo mode" without keys (tools register but return a clear credentials-not-configured error until you drop a credentials JSON in place).

## Tools

| Tool | Purpose |
|---|---|
| `ebay_research_auth_status` | Returns app-token state, environment (sandbox/production), expiry. Never echoes the token itself. |
| `ebay_research_search_active_listings` | Search current live listings. Filters: sort (price_asc/price_desc/best_match), condition, price_min/max, marketplace_id, limit, offset. Returns title, price, condition, seller, item_id, **itemWebUrl**. |
| `ebay_research_get_item` | Fetch full detail for one item by item_id. Includes itemWebUrl, seller info, shipping, full description. |

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
   openclaw plugins install @tangleclaw/openclaw-ebay-research
   ```

4. **Restart the gateway** so it picks up the new plugin.

5. Try it — ask the agent: *"what does a nikon d750 sell for on ebay?"*

## Configuration

Configurable via `plugins.entries.tangleclaw-ebay-research.config.*`:

| Key | Default | Description |
|---|---|---|
| `credentialsPath` | `~/.openclaw/secrets/ebay-research-credentials.json` | Path to the eBay app credentials JSON. |
| `tokenPath` | `~/.openclaw/secrets/ebay-research-app-token.json` | Path where the cached app token is written + read. |
| `defaultMarketplaceId` | `EBAY_US` | Default marketplace for searches if the agent doesn't specify one. |

## How it works

- The plugin uses the `client_credentials` OAuth flow: at first tool call, it POSTs `client_id` + `cert_id` (HTTP Basic auth) to eBay's token endpoint and gets back an app-level access token (TTL ~2 hours). The token is cached at `tokenPath` and reused; when it expires, the plugin auto-refreshes silently.
- No user OAuth, no refresh tokens, no per-user consent — this token represents your eBay developer app, not any seller.
- Sandbox base URL: `https://api.sandbox.ebay.com`. Production: `https://api.ebay.com`. Decided by `environment` in your credentials file.
- All HTTP requests have a 30-second timeout.
- Errors return the eBay API's error code + message verbatim where possible.

## Pairs well with

- [`@tangleclaw/openclaw-ebay-seller`](https://github.com/Jason-Vaughan/openclaw-ebay-seller) (sister plugin — read+write seller-side tools with OAuth + approval gating). The seller plugin's `create_offer` needs a category_id, which is exactly what this plugin's `ebay_research_get_categories` returns. Install both side-by-side.

## Out of scope (deferred to later versions)

- Bulk pricing-engine analysis across many SKUs.
- Buyer-side checkout / cart APIs.
- Trading API fallbacks (used only if a REST gap forces it).
- eBay Motors / specialty marketplaces.

## License

MIT
