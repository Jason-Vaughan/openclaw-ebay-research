# Changelog

All notable changes to `@tangleclaw/openclaw-ebay-research` are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- **Chunk R4 — SKILL.md + skills.test.ts (2026-05-26).** `skills/ebay-research/SKILL.md` lands per the openclaw-google-oauth precedent: frontmatter declares the plugin-id config requirement; Rule zero (never narrate, always re-call fresh — listings + prices + sold history change between turns), Rule one (on tool error, fix and re-call in the same turn — no narration), Rule two (always surface `itemWebUrl` when describing any listing). Per-tool decision tables grouped by API (Browse / Taxonomy / Insights / diagnostics). Multi-step recipes: four buyer-side (price check, best deal, condition+budget, URL parse), two seller-side (price-check candidate before listing, category lookup → create_offer handoff), one diagnostic. Explicit cross-plugin handoff to `tangleclaw-ebay-seller` including a NEVER-auto-confirm rule for hard-gated tools. Dedicated "Insights gating" section distinguishes the disabled-status response from a real zero-sample-size result. `src/skills.test.ts` (24 tests) asserts the SKILL.md mentions every tool, has each required rule, includes each mandatory recipe, and references the seller plugin. Skill content is the highest-leverage agent-bias artifact per the Google plugin precedent.

- **Chunk R3 — Marketplace Insights tool (2026-05-26).** New read tool `ebay_research_get_sold_history(query, days?, condition?, priceMin?, priceMax?, marketplaceId?, limit?, offset?)`. Returns aggregate stats (sampleSize, total, min/max/mean/median/p25/p75 in USD) plus the raw sold-item list (each with `itemWebUrl`). Distinct from `search_active_listings` — that's current ASKING prices; this is historical SOLD prices over a 1-90 day window. **Feature-flagged:** disabled by default via `plugins.entries.tangleclaw-ebay-research.config.enableInsights = false`. When disabled, returns `{ status: 'disabled', reason: '...' }` rather than failing — the agent can explain rather than throwing. When enabled, requests the `buy.marketplace.insights` OAuth scope alongside the default scope; auth.ts grew an optional `scopes: string[]` parameter and a scope-superset cache check (cached token is reused only if it contains all requested scopes, otherwise refreshed). README has a new "Enabling Marketplace Insights" walkthrough covering eBay's gated approval process.

### Changed

- `requestAppToken` + `getAppToken` accept an optional `scopes: string[]` (defaults to `[DEFAULT_SCOPE]` — backward compatible). `isTokenFresh` now also checks `cached.scopes ⊇ requested.scopes`.
- Exported `DEFAULT_SCOPE` and added `INSIGHTS_SCOPE` constants.

- **Chunk R2 — Taxonomy API tools (2026-05-26).** Two new read tools land:
  - `ebay_research_get_category_suggestions` — free-text query → ranked category suggestions with `categoryId` + `categoryName` + full ancestor chain. The categoryId is exactly what the sister seller plugin's `create_offer` needs.
  - `ebay_research_get_category_subtree` — drill down one level into a category by category_id. Each child node carries an `isLeaf` flag (sellable leaves are what `create_offer` requires).
  - `src/taxonomy.ts` adds an internal `getDefaultCategoryTreeId` that caches the per-marketplace tree id for the process lifetime (the tree id is stable; restart the gateway if eBay ever bumps it).
  - **Plan deviation noted:** the build plan called for `ebay_research_get_categories` (top-level tree fetch) but the full eBay category tree is several MB; ranked suggestions via the Taxonomy API's `get_category_suggestions` endpoint is materially more useful for both buyer-side ("what category does X belong in?") and seller-side ("what categoryId should create_offer use?") flows. Documented here for traceability.
- Initial scaffold (TypeScript, vitest, openclaw plugin SDK).
- `src/auth.ts`: eBay `client_credentials` OAuth flow with app-token cache + auto-refresh + Sandbox/Production URL switching.
- `src/browse.ts`: eBay Browse API HTTP client (typed responses + error normalization).
- Three tools wired via `defineToolPlugin`:
  - `ebay_research_auth_status` — never echoes the token itself.
  - `ebay_research_search_active_listings` — filters sort/condition/price_min/price_max/marketplace, returns `itemWebUrl` on every result.
  - `ebay_research_get_item` — full item detail by item_id.
- Unit tests with mocked HTTP for auth + browse + tool surface.
- Description-quality tests (read tools must explicitly declare read verbs).
- Live tests gated by `RUN_LIVE_TESTS=1` (skipped without keys).
- `openclaw.plugin.json` manifest.
- README with install + tool reference + configuration.
- MIT LICENSE.
