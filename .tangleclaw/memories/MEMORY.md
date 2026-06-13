# Session Memory — openclaw-ebay-research

## Current state (as of 2026-05-27)

- **Latest version:** v0.2.3 on `main` + on ClawHub at [`@tangleclaw/openclaw-ebay-research`](https://clawhub.ai/packages/@tangleclaw/openclaw-ebay-research) (community channel, owner `@tangleclaw`).
- **Auto-publish:** `.github/workflows/publish-clawhub.yml` fires on every `v*.*.*` tag push (or manual `workflow_dispatch`). Uses the `CLAWHUB_TOKEN` repo secret (token label on the ClawHub side: `updateToken2`).
- **6 read-only eBay research tools** across Browse + Taxonomy + Marketplace Insights APIs. `ebay-research` SKILL.md ships the agent-bias layer (Rule zero never narrate, Rule one fix-and-re-call on error, Rule two always surface `itemWebUrl`).
- **All v0.1 Critic findings closed:** issues #1-#5 shipped as v0.2.0 (per-currency bucketing, configurable timeouts, token-error redaction, malformed-JSON tests, decimal rounding). 148/148 unit tests pass.

## Release flow (the recipe)

Just tag + push. The workflow handles the rest:

```bash
git tag -a vX.Y.Z -m "..."
git push origin vX.Y.Z
gh release create vX.Y.Z --notes "..."
# .github/workflows/publish-clawhub.yml does the rest
```

**Do NOT manually run `clawhub package publish`.**

## Required manifest fields (don't drop these)

`package.json` `openclaw` block must include:

```json
"openclaw": {
  "extensions": ["./dist/index.js"],
  "compat": { "pluginApi": ">=2026.5.22" },
  "build":  { "openclawVersion": "2026.5.22" }
}
```

`openclaw.plugin.json` top-level must include `"enabledByDefault": true` (forward-compat with the open OpenClaw bug below).

## Open OpenClaw bug (operator-facing workaround in README)

[openclaw/openclaw#87188](https://github.com/openclaw/openclaw/issues/87188): community plugins shipping `enabledByDefault: true` don't auto-enable on install (bundled-only short-circuit). Operators have to run `openclaw plugins enable tangleclaw-ebay-research` after install. README documents this. When OpenClaw resolves, the second install command becomes obsolete.

## Sister plugins

- [`@tangleclaw/openclaw-google-oauth`](https://github.com/Jason-Vaughan/openclaw-google-oauth) — Google Workspace cross-domain companion. README "More from @tangleclaw" section in both plugins points at each other.
- `@tangleclaw/openclaw-ebay-seller` — **planned, not yet built**. Build plan at `~/Documents/Projects/Volta/.claude/plans/openclaw-ebay-seller-build-plan.md`. When scaffolded, apply the canonical ClawHub setup from day zero (see auto-memory's `reference_clawhub_publish.md`).

## Insights gating reminder

`ebay_research_get_sold_history` is feature-flagged via `plugins.entries.tangleclaw-ebay-research.config.enableInsights` (default `false`). Requires eBay Developer-portal-granted Marketplace Insights API access. When disabled, tool returns `{ status: "disabled", reason }` rather than failing.

## Next-session candidates (none blocking)

- Live-test the v0.2.0 per-currency bucketing against real eBay Sandbox payloads (currently mock-only via unit tests).
- Monitor #87188 for OpenClaw response; ship v0.2.4 docs PR if/when the manual `plugins enable` step becomes obsolete.
- Bump `actions/checkout@v4` + `setup-node@v4` → `@v5` when supported.

## Convention reminder

All `@tangleclaw/*` plugin descriptions follow the README-opener style. Documented in auto-memory's `reference_clawhub_publish.md`.
