# Smoke-test prompt — `openclaw-ebay-research`

Paste this whole block into a fresh OpenClaw chat after installing the plugin. It exercises every tool surface against real eBay APIs. Run it once after install, and again any time you change the deployment (new keys, new gateway version, new model).

**Prerequisites:**
- Plugin installed on the gateway.
- `~/.openclaw/secrets/ebay-research-credentials.json` populated with real keys (mode 0600).
- `enableInsights: true` ONLY if your eBay app has been granted Marketplace Insights API access; otherwise leave it false and the sold-history test below should return the disabled-status response, not an error.

---

## Prompt to paste

I'm smoke-testing the `tangleclaw-ebay-research` OpenClaw plugin. Walk through every tool and report what you see. Don't narrate — call the tool, then show me the result, then move to the next one.

1. **Auth status** — call `ebay_research_auth_status` and report: `connected`, `environment`, `expires_at`, any `warnings`, and the `reason` field if present.

2. **Active listings search** — call `ebay_research_search_active_listings` with `query="nikon d750"` and `limit=5`. Report the count, the first item's title + price + `itemWebUrl`, and the first item's seller username.

3. **Best deal filter** — call `ebay_research_search_active_listings` with `query="nikon d750"`, `sort="price_asc"`, `condition="USED"`, `priceMax=500`, `limit=3`. Report each result's title + price + condition + `itemWebUrl`.

4. **Non-US marketplace** — call `ebay_research_search_active_listings` with `query="bmx bike"`, `marketplaceId="EBAY_GB"`, `limit=3`. Report the prices (should be in GBP, not USD) and confirm the currency is GBP.

5. **Item detail** — pick any `itemId` from step 2's results, then call `ebay_research_get_item` with it. Report the full title, condition, seller name, and shipping options summary.

6. **Category suggestions** — call `ebay_research_get_category_suggestions` with `query="vintage leather jacket"`. Report the top 3 suggestions' `categoryId` + `categoryName` + the full ancestor chain for the top suggestion.

7. **Category subtree** — call `ebay_research_get_category_subtree` with the top suggestion's `categoryId` from step 6. Report how many children it has and the first 3 children's `categoryName` + `isLeaf` status.

8. **Sold history** — call `ebay_research_get_sold_history` with `query="nikon d750 body"`, `days=30`.
   - If the tool returns `{ status: "disabled", reason }`: report the reason verbatim and confirm this is expected because Insights isn't enabled on this deployment.
   - If the tool runs: report `stats.sampleSize`, `stats.total`, `stats.median`, `stats.min`, `stats.max`, and one sample item's title + soldPrice + lastSoldDate + itemWebUrl.

Format each step's output as a clear short bullet list under a numbered heading. Do not skip any step. If any step returns an error, report the error verbatim and continue to the next step.

---

## What to look for

| Step | Pass | Fail |
|---|---|---|
| 1 | `connected: true`, `environment` matches your creds file, no warnings | `credentials_present: false` → check secrets path; warnings → fix file perms |
| 2 | At least one result with non-empty `itemWebUrl` | Empty list → check credentials; missing itemWebUrl → eBay API response shape changed |
| 3 | Results sorted price-ascending, all USED, all ≤ $500 | Unsorted → sort param bug; wrong condition → filter bug |
| 4 | Prices in GBP, currency confirmed | Prices in USD → currency-per-marketplace bug regression |
| 5 | Full structured detail returned | "errorId=..." → check the itemId format (`v1\|<id>\|0`) |
| 6 | 3+ suggestions, top suggestion has multi-level ancestors | Empty → query too vague or Taxonomy API regression |
| 7 | Children list, at least one `isLeaf: false` (or all leaves at deep enough nodes) | Empty children → categoryId chosen poorly; pick a higher-level one |
| 8 | Either `disabled` with clear reason OR real stats with samples | Other error → check Insights grant status + scope handling |

## When something fails

1. Call `ebay_research_auth_status` again — see the `warnings` array and `reason` field for clues.
2. Check `~/.openclaw/secrets/ebay-research-credentials.json` exists with mode `0600` and valid JSON.
3. Check `~/.openclaw/secrets/ebay-research-app-token.json` exists; if it's there but `expires_at` is in the past, the next tool call will auto-refresh — try again.
4. Check the gateway's startup log for plugin-load errors.
