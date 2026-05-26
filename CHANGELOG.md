# Changelog

All notable changes to `@tangleclaw/openclaw-ebay-research` are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

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
