# Changelog

All notable changes to `@tangleclaw/openclaw-ebay-research` are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

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
