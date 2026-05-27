# Changelog

All notable changes to `@tangleclaw/openclaw-ebay-research` are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- **Six read-only eBay research tools** wired via `defineToolPlugin`:
  - `ebay_research_auth_status` — connection diagnostics, never echoes the access token, surfaces credential-file-permissions warnings.
  - `ebay_research_search_active_listings` — Browse API search with filters: `sort` (price_asc/price_desc/best_match/newly_listed), `condition` (NEW/USED/...), `priceMin/priceMax` (auto-currency per marketplace), `marketplaceId`, `limit` (1-200), `offset` (offset+limit capped at eBay's 10000 hard limit). Returns `itemWebUrl` on every result so the agent can hand operators clickable links.
  - `ebay_research_get_item` — Browse API single-item detail by item_id (URL-encoded for eBay's pipe-delimited id format).
  - `ebay_research_get_category_suggestions` — Taxonomy API ranked suggestions with `categoryId` + `categoryName` + ancestor chain. The categoryId is exactly what the sister `tangleclaw-ebay-seller` plugin's `create_offer` needs.
  - `ebay_research_get_category_subtree` — Taxonomy API drill-down with per-child `categoryId` + `isLeaf` flag (leaves are what `create_offer` requires).
  - `ebay_research_get_sold_history` — Marketplace Insights API sold listings + aggregate stats (sampleSize, total, min/max/mean/median/p25/p75 in marketplace currency) over a 1-90 day window. **Feature-flagged** via `plugins.entries.tangleclaw-ebay-research.config.enableInsights = false`; returns `{ status: "disabled", reason }` when off rather than failing. Requires eBay-granted Marketplace Insights API access.
- **`client_credentials` OAuth flow** (`src/auth.ts`): POSTs `client_id` + `cert_id` (HTTP Basic) to eBay's token endpoint, caches the access token at `~/.openclaw/secrets/ebay-research-app-token.json` with enforced 0600 perms (chmod-on-every-write so existing-file mode regressions can't slip in), auto-refreshes 60s before expiry, environment-aware (`sandbox` / `production` base URLs). Detects mid-request environment switches on 401-retry path and throws a clear error rather than silently calling the wrong host with the wrong token. Parses eBay's granted-scope response and verifies all requested scopes were actually granted — guards against silent scope downgrades (e.g. `buy.marketplace.insights` requested but eBay didn't grant it) that would otherwise loop forever.
- **`skills/ebay-research/SKILL.md`** — the agent-bias artifact loaded into the system prompt. Frontmatter declares the plugin-id config requirement. Rule zero (never narrate, always re-call fresh), Rule one (on tool error, fix and re-call in the same turn — no narration), Rule two (always surface `itemWebUrl` when describing a listing). Per-tool decision tables grouped by API. Recipes for buyer-side ("what does X sell for", "best deal", condition+budget, URL parse with variation-listing caveat), seller-side (price-check candidate before listing, category lookup → create_offer handoff), non-US marketplaces, and diagnostics. Explicit cross-plugin handoff to `tangleclaw-ebay-seller` with a sharp NEVER-call-`ebay_seller_confirm_pending`-yourself rule. Dedicated "Insights gating" section distinguishes the `enableInsights=false` disabled response from a real `stats.sampleSize=0` (no sales in window) result.
- **Auto-derived per-marketplace currency** for price filters: EBAY_US→USD, EBAY_GB→GBP, EBAY_DE→EUR, EBAY_CA→CAD, EBAY_AU→AUD, etc. (see `currencyForMarketplace`). Prevents the `priceCurrency:USD` hardcode that would break multi-marketplace searches.
- **Test suite** (108 unit tests, 6 live tests gated on `RUN_LIVE_TESTS=1` + optional `RUN_INSIGHTS_TESTS=1`):
  - `src/auth.test.ts` — env handling, credentials parsing, HTTP Basic encoding, token cache, expiry/scope-mismatch/env-mismatch refresh, getAuthStatus paths (including credential-perm warning), never-leak-token assertion.
  - `src/browse.test.ts` — sort/filter builders, search headers + URL params, getItem encoding, eBay error surfacing with errorId, 401→refresh→retry, env-switch protection on retry.
  - `src/taxonomy.test.ts` — tree-id cache per (env, marketplace), suggestions/subtree call shapes, error surface.
  - `src/insights.test.ts` — quantile + computeStats (median, p25/p75, currency-mix handling), scope request body, header shape, truncated flag, validation, scope-hint surfacing on 403.
  - `src/index.test.ts` — plugin metadata, tool count, names.
  - `src/descriptions.test.ts` — per-tool description quality (read-verb count, key feature mentions).
  - `src/skills.test.ts` — SKILL.md mentions every tool, has each rule, includes each mandatory recipe, has cross-plugin handoff + NEVER-auto-confirm wording.
  - `src/live.test.ts` — real-API round trips against Sandbox / Production, gated by env flags.
- **`openclaw.plugin.json` manifest** + plugin-loadable bundle. `defineToolPlugin` exposes the 6 tools with typebox parameter schemas + plain-text descriptions tuned for small-model routing.
- **README** with install, eBay-app setup walkthrough, tool reference, config schema, "Enabling Marketplace Insights" gated-approval walkthrough, sister-plugin pointer.
- **MIT LICENSE.**
- **Operator-facing prompt docs** (`docs/smoke-test-prompt.md`, `docs/skill-verification-prompt.md`) for validating the plugin behaves correctly post-deployment.
- **CHANGELOG** in Keep a Changelog format.

### Plan deviations

Two intentional plan deviations during v0.1 development, both logged here for traceability:

- **Chunks R0 + R1 merged into one session.** Plan called for separate "scaffold + auth_status" and "Browse tools" sessions; we merged them for greenfield velocity. Three tools landed in the first commit instead of one. Discussed + approved before execution.
- **`ebay_research_get_categories` replaced with `ebay_research_get_category_suggestions`.** Plan called for top-level tree fetch; eBay's full category tree is several MB and rarely what an agent actually needs. Ranked suggestions are materially more useful for both buyer-side ("what category is X?") and seller-side ("what categoryId for create_offer?") flows.
