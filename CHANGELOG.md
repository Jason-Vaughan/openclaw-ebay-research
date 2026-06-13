# Changelog

All notable changes to `@tangleclaw/openclaw-ebay-research` are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.3.1] - 2026-06-12

### Internal

- **README rewritten as the plugin's ClawHub face** — stronger headline + "no MCP / no seller account / no gateway" value prop, a "Looking for…" discoverability block, a ⭐ star call-to-action near the top (framed as a *plugin*, not a skill), `whats_selling` featured in the example questions, and the `## Status` section refreshed to v0.3.0 (7 tools, 163 tests, `clawhub.ai`). Fixed a stale "6 direct-REST tools" count in SKILL.md (now 7). Docs-only, no behavior change.

## [0.3.0] - 2026-06-12

### Added

- **New tool `ebay_research_whats_selling` — sales-velocity signal from active listings.** Answers "what is X *actually* selling for / is X selling?" using eBay Browse's `estimatedSoldQuantity` (units sold on a listing that is still live), which is available under the base `api_scope` we already have — no Marketplace Insights gating. One agent call fans out internally (deterministic code, not a model-driven tool chain): searches live listings, inspects the top `sampleSize` (default 10, max 20) via `getItem` concurrently, keeps only listings meeting `minSoldQuantity` (default 1), sorts by units sold, and returns per-item sold quantity + `medianPrice` (the recommended anchor), `min`/`max`, `totalSoldQuantity`, and `soldWeightedMeanPrice` (a skew-aware secondary cross-check). Failed item fetches are skipped (counted in `skipped`), never fatal. `estimatedSoldQuantity` lives on the `Item` schema, not `ItemSummary`, so the search→getItem fan-out is required; doing it inside the tool keeps the agent to a single call and sidesteps long model-driven tool chains. Price stats are **bucketed to the marketplace's primary currency** (mirroring `insights.ts`) — off-currency listings stay in `items` with their native currency but are excluded from the blended stats, with a `mixedCurrencies` flag when they appear; `medianPrice` is documented as the recommended anchor and `soldWeightedMeanPrice` as a skew-prone secondary cross-check (it weights current ask by lifetime units). Counters reconcile: `inspected === matchedCount + belowThreshold + skipped`. Clearly distinct in the response `note`, README, and SKILL.md from `get_sold_history` (true historical sold transactions, gated) — the signal is current asking price on listings that have sold, not historical sold prices. 13 new unit tests incl. mixed-currency, missing-price, and all-fetches-fail cases (162 total); independent Critic reviewed. Implements [#13](https://github.com/Jason-Vaughan/openclaw-ebay-research/issues/13).

### Internal

- **README gains an "eBay API compliance (your responsibility as operator)" section.** Makes explicit what was previously implied: installing the plugin grants no eBay API access; each operator registers their own eBay application and accepts the eBay API License Agreement themselves; the Marketplace Account Deletion attestation (endpoint vs "I do not persist eBay data" exemption) is the operator's to make; the License Agreement's restrictions on deriving marketplace-level statistics (category-average prices, GMV, cross-listing sales rates) apply to how operators use the results — own-research/pricing use is the intended pattern, republishing aggregates is not; call limits should be respected (no polling loops / bulk harvesting); and sold-history access is granted by eBay (Marketplace Insights approval), not by the plugin. Also refreshed the stale `## Status` section (still said v0.1.0/3 tools) to reflect the full tool surface, ClawHub publication, and the first live production validation (2026-06-12). No behavior change.
- **Declared `ebay_research_whats_selling` in the manifest `contracts.tools`** (it was registered in code but missing from the manifest, so the gateway rejected it on load), and added a drift-guard test asserting the manifest tool list exactly matches the registered tools so this can't silently regress.

## [0.2.3] - 2026-05-27

### Internal

- **README documents the install-time `openclaw plugins enable` step** while [openclaw/openclaw#87188](https://github.com/openclaw/openclaw/issues/87188) is open. Operators installing from ClawHub today hit a "Missing requirements: config:plugins.entries.tangleclaw-ebay-research.enabled" message on the skill panel because community-installed plugins don't auto-enable on install (only bundled plugins do). Until OpenClaw resolves the bundled-only short-circuit in its activation logic, operators need to run `openclaw plugins enable tangleclaw-ebay-research` after install — the README now shows that as part of the standard install sequence with a callout explaining why, and a note that this plugin's manifest already ships `enabledByDefault: true`, so the second step disappears automatically once #87188 ships. No behavior change in the plugin itself.

## [0.2.2] - 2026-05-27

### Internal

- **`enabledByDefault: true` in `openclaw.plugin.json`.** Sets the manifest hint so OpenClaw treats the plugin as enabled-on-install when its activation logic respects the field for community-origin plugins. The `SKILL.md` gates itself on `plugins.entries.tangleclaw-ebay-research.enabled` (canonical pattern shared with `tavily`, `open-prose`, etc.) — without this manifest hint, fresh installs come up with the skill in a "blocked / missing requirements" state and the operator must run `openclaw plugins enable tangleclaw-ebay-research` manually. With this hint, the install flow should flip the flag automatically. Many bundled OpenClaw plugins (`azure-speech`, `anthropic`, `browser`, etc.) use the same field. No behavior change for installs that already had the plugin explicitly enabled.

## [0.2.1] - 2026-05-27

### Internal

- **ClawHub publish gate.** Added `openclaw.compat.pluginApi` (`>=2026.5.22`) and `openclaw.build.openclawVersion` (`2026.5.22`) to `package.json` so `clawhub package publish` accepts the plugin as an external code-plugin artifact. Pattern-lifted from `openclaw-google-oauth` v0.3.2.
- **Human-readable description on ClawHub.** Rewrote the `description` field in both `package.json` and `openclaw.plugin.json` to follow the canonical README-opener style established for `@tangleclaw` plugins: opens with the operator's benefit ("Read-only eBay market research for your OpenClaw agent"), comma-lists the surfaces instead of parenthetically enumerating verbs, leads the differentiator with negative space ("No seller account, no user OAuth, no MCP server"), closes with the operator-facing payoff ("Every result ships with a clickable itemWebUrl"). No behavior change.
- **GitHub Actions workflow** at `.github/workflows/publish-clawhub.yml` — auto-publishes to ClawHub on every `v*.*.*` tag push (and supports manual `workflow_dispatch` for republishing an existing tag if a publish fails). Copied wholesale from `openclaw-google-oauth`'s working setup. Requires a `CLAWHUB_TOKEN` repository secret.

## [0.2.0] - 2026-05-27

### Added

- **Per-currency bucketing in `ebay_research_get_sold_history` stats** (closes #1). `SoldHistoryStats` now exposes `primaryCurrency` (derived from `marketplaceId`), a `primary` bucket of stats for items priced in that currency, and a `byCurrency` map with stats for every currency observed in the result set. International searches (`EBAY_DE`, `EBAY_GB`, etc.) that return a few stragglers in other currencies are now bucketed cleanly instead of silently blending mismatched prices into one mis-labeled distribution.
- **Configurable HTTP timeout + token-refresh safety window** (closes #2). Two new plugin config keys: `httpTimeoutMs` (default 30000) applies to every eBay REST call + the token endpoint; `tokenRefreshSafetyWindowMs` (default 60000) controls how early before expiry a cached token is proactively refreshed. Both thread through `AuthConfig` so operators on slow networks or with tight freshness needs can tune the plugin without forking.

### Changed

- **`SoldHistoryStats` output shape reshaped.** The pre-v0.2 flat shape (`{ sampleSize, total, currency, min, max, mean, median, p25, p75 }`) is replaced by `{ sampleSize, total, primaryCurrency, primary: { sampleSize, min, max, mean, median, p25, p75 }, byCurrency: Record<currency, bucket> }`. Pre-1.0 breaking change — operators reading from `stats.min` directly need to read from `stats.primary.min` instead. SKILL.md + the `get_sold_history` tool description updated to reflect the new shape.

### Fixed

- **Redact `Basic` / `Bearer` blobs from token-error messages** (closes #3). `requestAppToken` now passes the eBay token-endpoint error body through `redactAuthHeaders` before slicing it into the thrown error. Defends against the theoretical case where eBay's error body echoes a credential header back — credentials can no longer slip into logs / error-reporting pipelines via the thrown error.
- **Round `min` / `max` / `mean` / `median` / `p25` / `p75` to 2 decimal places** in `get_sold_history` stats (closes #5). Eliminates floating-point artifacts like `224.0000000000001` from quantile math when surfacing currency values to the operator.

### Internal

- **Tests for the malformed-JSON 500 fallback branch** in all three REST call paths (`callBrowse`, `callEbayRest`, `callInsightsRest`) — closes #4. Confirms the `text.slice(0, 300)` fallback surfaces a meaningful error when eBay returns a bare-text 500.

## [0.1.0] - 2026-05-26

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
