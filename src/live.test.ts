import { describe, it, expect } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import { access } from "node:fs/promises";
import { getAppToken, getAuthStatus } from "./auth.js";
import { searchActiveListings } from "./browse.js";
import { getCategorySuggestions, getCategorySubtree } from "./taxonomy.js";
import { getSoldHistory } from "./insights.js";

const LIVE_ENABLED = process.env.RUN_LIVE_TESTS === "1";

const credsPath = process.env.EBAY_RESEARCH_CREDENTIALS_PATH
  ? process.env.EBAY_RESEARCH_CREDENTIALS_PATH
  : join(homedir(), ".openclaw/secrets/ebay-research-credentials.json");
const tokenPath = process.env.EBAY_RESEARCH_TOKEN_PATH
  ? process.env.EBAY_RESEARCH_TOKEN_PATH
  : join(homedir(), ".openclaw/secrets/ebay-research-app-token.json");

async function credentialsAvailable(): Promise<boolean> {
  try {
    await access(credsPath);
    return true;
  } catch {
    return false;
  }
}

const describeIfLive = LIVE_ENABLED ? describe : describe.skip;

describeIfLive("live eBay Browse API integration", () => {
  it("can fetch a real app token", async () => {
    if (!(await credentialsAvailable())) {
      console.warn(`Skipping: credentials not at ${credsPath}`);
      return;
    }
    const token = await getAppToken({ credentialsPath: credsPath, tokenPath });
    expect(token.access_token.length).toBeGreaterThan(10);
    expect(["sandbox", "production"]).toContain(token.environment);
  });

  it("reports connected via getAuthStatus", async () => {
    if (!(await credentialsAvailable())) return;
    const status = await getAuthStatus({ credentialsPath: credsPath, tokenPath });
    expect(status.credentials_present).toBe(true);
    expect(status.connected).toBe(true);
  });

  it("can search a common query and get at least one result with itemWebUrl", async () => {
    if (!(await credentialsAvailable())) return;
    const result = await searchActiveListings(
      { credentialsPath: credsPath, tokenPath },
      { query: "laptop", limit: 5 }
    );
    expect(result.items.length).toBeGreaterThan(0);
    const first = result.items[0];
    expect(first.itemId).toBeTruthy();
    expect(first.itemWebUrl ?? "").toMatch(/^https?:\/\//);
  });

  it("can suggest a category for a common query", async () => {
    if (!(await credentialsAvailable())) return;
    const result = await getCategorySuggestions(
      { credentialsPath: credsPath, tokenPath },
      { query: "nikon d750", limit: 3 }
    );
    expect(result.treeId).toBeTruthy();
    expect(result.suggestions.length).toBeGreaterThan(0);
    expect(result.suggestions[0].categoryId).toBeTruthy();
    expect(result.suggestions[0].categoryName).toBeTruthy();
  });

  it("can fetch a subtree for a suggested category", async () => {
    if (!(await credentialsAvailable())) return;
    const suggested = await getCategorySuggestions(
      { credentialsPath: credsPath, tokenPath },
      { query: "camera", limit: 1 }
    );
    if (suggested.suggestions.length === 0) return;
    const top = suggested.suggestions[0].ancestors[0]?.categoryId ?? suggested.suggestions[0].categoryId;
    const subtree = await getCategorySubtree(
      { credentialsPath: credsPath, tokenPath },
      { categoryId: top }
    );
    expect(subtree.root.categoryId).toBe(top);
  });
});

const INSIGHTS_ENABLED =
  LIVE_ENABLED && process.env.RUN_INSIGHTS_TESTS === "1";
const describeIfInsights = INSIGHTS_ENABLED ? describe : describe.skip;

describeIfInsights("live Marketplace Insights API integration", () => {
  it("can fetch sold history for a common query", async () => {
    if (!(await credentialsAvailable())) return;
    const result = await getSoldHistory(
      { credentialsPath: credsPath, tokenPath },
      { query: "nikon d750", days: 90, limit: 25 }
    );
    expect(result.windowDays).toBe(90);
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.stats.sampleSize).toBeGreaterThan(0);
    if (result.stats.median !== undefined) {
      expect(result.stats.median).toBeGreaterThan(0);
    }
  });
});

if (!LIVE_ENABLED) {
  describe("live tests skipped", () => {
    it("set RUN_LIVE_TESTS=1 to enable", () => {
      expect(LIVE_ENABLED).toBe(false);
    });
  });
}
