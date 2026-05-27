import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSoldHistory, _internal } from "./insights.js";
import { DEFAULT_SCOPE, INSIGHTS_SCOPE, type AuthConfig } from "./auth.js";

let workDir: string;
let credsPath: string;
let tokenPath: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "ebay-insights-test-"));
  credsPath = join(workDir, "credentials.json");
  tokenPath = join(workDir, "token.json");
  await writeFile(
    credsPath,
    JSON.stringify({
      client_id: "cid",
      cert_id: "secret",
      environment: "sandbox",
    })
  );
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

function authConfig(): AuthConfig {
  return { credentialsPath: credsPath, tokenPath };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function writeBroadToken(): Promise<void> {
  await writeFile(
    tokenPath,
    JSON.stringify({
      access_token: "broad-token",
      token_type: "App",
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      environment: "sandbox",
      scopes: [DEFAULT_SCOPE, INSIGHTS_SCOPE],
    })
  );
}

describe("quantile", () => {
  it("returns undefined on empty", () => {
    expect(_internal.quantile([], 0.5)).toBeUndefined();
  });
  it("computes median correctly for odd-length array", () => {
    expect(_internal.quantile([1, 2, 3], 0.5)).toBe(2);
  });
  it("computes median correctly for even-length array (linear interp)", () => {
    expect(_internal.quantile([1, 2, 3, 4], 0.5)).toBeCloseTo(2.5);
  });
  it("computes p25 + p75", () => {
    expect(_internal.quantile([1, 2, 3, 4, 5], 0.25)).toBe(2);
    expect(_internal.quantile([1, 2, 3, 4, 5], 0.75)).toBe(4);
  });
});

describe("computeStats", () => {
  it("returns sampleSize=0 stats for empty items", () => {
    const stats = _internal.computeStats([], 0);
    expect(stats.sampleSize).toBe(0);
    expect(stats.min).toBeUndefined();
    expect(stats.median).toBeUndefined();
  });
  it("computes min/max/mean/median/p25/p75 from items", () => {
    const items = [10, 20, 30, 40, 50].map((v) => ({
      itemId: `id-${v}`,
      title: `t-${v}`,
      soldPrice: { value: String(v), currency: "USD" },
    }));
    const stats = _internal.computeStats(items, 5);
    expect(stats.sampleSize).toBe(5);
    expect(stats.min).toBe(10);
    expect(stats.max).toBe(50);
    expect(stats.mean).toBe(30);
    expect(stats.median).toBe(30);
    expect(stats.p25).toBe(20);
    expect(stats.p75).toBe(40);
    expect(stats.currency).toBe("USD");
    expect(stats.total).toBe(5);
  });
  it("ignores items with no soldPrice or non-numeric price", () => {
    const items = [
      { itemId: "1", title: "a", soldPrice: { value: "20", currency: "USD" } },
      { itemId: "2", title: "b" },
      { itemId: "3", title: "c", soldPrice: { value: "n/a", currency: "USD" } },
    ];
    const stats = _internal.computeStats(items, 3);
    expect(stats.sampleSize).toBe(1);
    expect(stats.min).toBe(20);
  });
});

describe("buildFilterParam (insights)", () => {
  const fromIso = "2026-02-26T00:00:00.000Z";
  it("always includes lastSoldDate", () => {
    const f = _internal.buildFilterParam({ query: "x" }, fromIso, "EBAY_US");
    expect(f).toContain(`lastSoldDate:[${fromIso}..]`);
  });
  it("adds conditions filter", () => {
    const f = _internal.buildFilterParam(
      { query: "x", condition: "USED" },
      fromIso,
      "EBAY_US"
    );
    expect(f).toContain("conditions:{USED}");
  });
  it("adds USD price range filter for EBAY_US", () => {
    const f = _internal.buildFilterParam(
      { query: "x", priceMin: 50, priceMax: 500 },
      fromIso,
      "EBAY_US"
    );
    expect(f).toContain("price:[50..500]");
    expect(f).toContain("priceCurrency:USD");
  });
  it("adds GBP price range filter for EBAY_GB", () => {
    const f = _internal.buildFilterParam(
      { query: "x", priceMin: 50, priceMax: 500 },
      fromIso,
      "EBAY_GB"
    );
    expect(f).toContain("priceCurrency:GBP");
    expect(f).not.toContain("priceCurrency:USD");
  });
});

describe("getSoldHistory", () => {
  it("requests both default + insights scopes when fetching the app token", async () => {
    const calls: { url: string; body?: string }[] = [];
    const fetchMock = (async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? String(init.body) : undefined });
      if (url.includes("/identity/v1/oauth2/token")) {
        return jsonResponse({
          access_token: "fresh",
          token_type: "App",
          expires_in: 7200,
        });
      }
      return jsonResponse({
        total: 0,
        limit: 50,
        offset: 0,
        itemSales: [],
      });
    }) as unknown as typeof fetch;

    await getSoldHistory(authConfig(), { query: "x" }, fetchMock);
    const tokenCall = calls.find((c) => c.url.includes("/identity/v1/oauth2/token"));
    expect(tokenCall).toBeTruthy();
    expect(tokenCall!.body).toContain("scope=");
    const decoded = decodeURIComponent(tokenCall!.body!);
    expect(decoded).toContain(DEFAULT_SCOPE);
    expect(decoded).toContain(INSIGHTS_SCOPE);
  });

  it("calls Marketplace Insights search with q + filter + bearer + marketplace header", async () => {
    await writeBroadToken();
    let captured: { url?: string; headers?: Record<string, string> } = {};
    const fetchMock = (async (url: string, init?: RequestInit) => {
      captured = { url, headers: init?.headers as Record<string, string> };
      return jsonResponse({
        total: 2,
        limit: 50,
        offset: 0,
        itemSales: [
          {
            itemId: "v1|s1|0",
            title: "Sold Item 1",
            lastSoldPrice: { value: "199.00", currency: "USD" },
            lastSoldDate: "2026-04-12T00:00:00.000Z",
            itemWebUrl: "https://www.ebay.com/itm/s1",
          },
          {
            itemId: "v1|s2|0",
            title: "Sold Item 2",
            lastSoldPrice: { value: "249.00", currency: "USD" },
            lastSoldDate: "2026-04-20T00:00:00.000Z",
            itemWebUrl: "https://www.ebay.com/itm/s2",
          },
        ],
      });
    }) as unknown as typeof fetch;

    const result = await getSoldHistory(
      authConfig(),
      { query: "nikon d750", days: 30 },
      fetchMock
    );

    expect(captured.url).toContain(
      "/buy/marketplace_insights/v1/item_sales/search"
    );
    expect(captured.url).toContain("q=nikon+d750");
    expect(decodeURIComponent(captured.url!)).toContain("lastSoldDate:[");
    expect(captured.headers!.Authorization).toBe("Bearer broad-token");
    expect(captured.headers!["X-EBAY-C-MARKETPLACE-ID"]).toBe("EBAY_US");
    expect(result.items).toHaveLength(2);
    expect(result.stats.sampleSize).toBe(2);
    expect(result.stats.min).toBe(199);
    expect(result.stats.max).toBe(249);
    expect(result.stats.median).toBeCloseTo(224);
    expect(result.windowDays).toBe(30);
    expect(result.truncated).toBe(false);
  });

  it("marks truncated when total > items.length", async () => {
    await writeBroadToken();
    const fetchMock = (async () =>
      jsonResponse({
        total: 5000,
        limit: 50,
        offset: 0,
        itemSales: [
          {
            itemId: "v1|x|0",
            title: "t",
            lastSoldPrice: { value: "10", currency: "USD" },
          },
        ],
      })) as unknown as typeof fetch;
    const result = await getSoldHistory(
      authConfig(),
      { query: "x" },
      fetchMock
    );
    expect(result.truncated).toBe(true);
    expect(result.stats.total).toBe(5000);
  });

  it("rejects empty query", async () => {
    await expect(
      getSoldHistory(authConfig(), { query: "" }, fetch)
    ).rejects.toThrow(/query is required/);
  });

  it("rejects days outside 1-90", async () => {
    await expect(
      getSoldHistory(authConfig(), { query: "x", days: 0 }, fetch)
    ).rejects.toThrow(/days must be between/);
    await expect(
      getSoldHistory(authConfig(), { query: "x", days: 100 }, fetch)
    ).rejects.toThrow(/days must be between/);
  });

  it("surfaces a hint when eBay returns a scope-related error", async () => {
    await writeBroadToken();
    const fetchMock = (async () =>
      jsonResponse(
        {
          errors: [
            {
              errorId: 1100,
              message: "access denied",
              longMessage:
                "Insufficient permissions to access the requested resource. The requested scope is not granted to the application.",
            },
          ],
        },
        403
      )) as unknown as typeof fetch;
    await expect(
      getSoldHistory(authConfig(), { query: "x" }, fetchMock)
    ).rejects.toThrow(/Marketplace Insights access/);
  });

  it("retries once on 401 with a fresh token", async () => {
    await writeBroadToken();
    let calls = 0;
    const fetchMock = (async (url: string) => {
      calls += 1;
      if (calls === 1) {
        // first attempt at the insights endpoint → 401
        return new Response(
          JSON.stringify({ errors: [{ errorId: 1001, message: "expired" }] }),
          { status: 401, statusText: "Unauthorized" }
        );
      }
      if (url.includes("/identity/v1/oauth2/token")) {
        return jsonResponse({
          access_token: "fresh",
          token_type: "App",
          expires_in: 7200,
          scope: `${DEFAULT_SCOPE} ${INSIGHTS_SCOPE}`,
        });
      }
      return jsonResponse({ total: 0, limit: 50, offset: 0, itemSales: [] });
    }) as unknown as typeof fetch;
    const result = await getSoldHistory(authConfig(), { query: "x" }, fetchMock);
    expect(result.stats.sampleSize).toBe(0);
  });

  it("throws on 401-retry when environment changes mid-request", async () => {
    await writeBroadToken();
    let calls = 0;
    const fetchMock = (async (url: string) => {
      calls += 1;
      if (calls === 1) {
        // First insights request → 401. Swap creds to production HERE so
        // the next force-refresh reads the new env.
        await writeFile(
          credsPath,
          JSON.stringify({
            client_id: "cid",
            cert_id: "secret",
            environment: "production",
          })
        );
        return new Response(
          JSON.stringify({ errors: [{ errorId: 1001, message: "expired" }] }),
          { status: 401, statusText: "Unauthorized" }
        );
      }
      if (url.includes("/identity/v1/oauth2/token")) {
        return jsonResponse({
          access_token: "prod",
          token_type: "App",
          expires_in: 7200,
          scope: `${DEFAULT_SCOPE} ${INSIGHTS_SCOPE}`,
        });
      }
      return jsonResponse({ total: 0, itemSales: [] });
    }) as unknown as typeof fetch;
    await expect(
      getSoldHistory(authConfig(), { query: "x" }, fetchMock)
    ).rejects.toThrow(/environment changed mid-request/);
  });

  it("falls back to price when lastSoldPrice missing", async () => {
    await writeBroadToken();
    const fetchMock = (async () =>
      jsonResponse({
        total: 1,
        itemSales: [
          {
            itemId: "v1|y|0",
            title: "t",
            price: { value: "75.00", currency: "USD" },
          },
        ],
      })) as unknown as typeof fetch;
    const result = await getSoldHistory(authConfig(), { query: "x" }, fetchMock);
    expect(result.items[0].soldPrice?.value).toBe("75.00");
  });
});
