import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSalesVelocity } from "./sold-signal.js";
import type { AuthConfig } from "./auth.js";

let workDir: string;
let credsPath: string;
let tokenPath: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "ebay-soldsignal-test-"));
  credsPath = join(workDir, "credentials.json");
  tokenPath = join(workDir, "token.json");
  await writeFile(
    credsPath,
    JSON.stringify({ client_id: "cid", cert_id: "secret", environment: "sandbox" })
  );
  await writeFile(
    tokenPath,
    JSON.stringify({
      access_token: "test-token",
      token_type: "App",
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      environment: "sandbox",
      scopes: ["https://api.ebay.com/oauth/api_scope"],
    })
  );
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

function authConfig(): AuthConfig {
  return { credentialsPath: credsPath, tokenPath };
}

interface ItemFixture {
  itemId: string;
  price?: { value: string; currency: string };
  estimatedAvailabilities?: Array<Record<string, unknown>>;
  fail?: boolean;
}

/** Routes search + per-item getItem calls over the given fixtures. */
function mockFetch(fixtures: ItemFixture[]): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/item_summary/search")) {
      return new Response(
        JSON.stringify({
          total: fixtures.length,
          itemSummaries: fixtures.map((f) => ({
            itemId: f.itemId,
            title: `Listing ${f.itemId}`,
            price: f.price,
            condition: "USED",
            itemWebUrl: `https://www.ebay.com/itm/${f.itemId}`,
            seller: { username: "sellerx", feedbackPercentage: "99.1" },
          })),
        }),
        { status: 200 }
      );
    }
    const match = fixtures.find((f) => url.includes(encodeURIComponent(f.itemId)));
    if (match) {
      if (match.fail) {
        return new Response(
          JSON.stringify({ errors: [{ errorId: 11001, message: "The specified item ID was not found." }] }),
          { status: 404, statusText: "Not Found" }
        );
      }
      return new Response(
        JSON.stringify({
          itemId: match.itemId,
          title: `Listing ${match.itemId} (detail)`,
          price: match.price,
          condition: "USED",
          itemWebUrl: `https://www.ebay.com/itm/${match.itemId}`,
          estimatedAvailabilities: match.estimatedAvailabilities,
        }),
        { status: 200 }
      );
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
}

describe("getSalesVelocity", () => {
  it("returns proven sellers sorted by estimatedSoldQuantity desc with stats", async () => {
    const fetchImpl = mockFetch([
      {
        itemId: "v1|111|0",
        price: { value: "100.00", currency: "USD" },
        estimatedAvailabilities: [{ estimatedSoldQuantity: 5, estimatedAvailabilityStatus: "IN_STOCK", estimatedAvailableQuantity: 3 }],
      },
      {
        itemId: "v1|222|0",
        price: { value: "90.00", currency: "USD" },
        estimatedAvailabilities: [{ estimatedSoldQuantity: 0 }],
      },
      {
        itemId: "v1|333|0",
        price: { value: "120.00", currency: "USD" },
        estimatedAvailabilities: [{ estimatedSoldQuantity: 12 }],
      },
    ]);
    const res = await getSalesVelocity(authConfig(), { query: "nikon d750" }, fetchImpl);
    expect(res.inspected).toBe(3);
    expect(res.skipped).toBe(0);
    expect(res.belowThreshold).toBe(1); // the sold:0 listing
    // counters close: inspected === matched + belowThreshold + skipped
    expect(res.inspected).toBe(res.stats.matchedCount + res.belowThreshold + res.skipped);
    expect(res.items.map((i) => i.itemId)).toEqual(["v1|333|0", "v1|111|0"]);
    expect(res.items[0].estimatedSoldQuantity).toBe(12);
    expect(res.items[1].estimatedAvailabilityStatus).toBe("IN_STOCK");
    expect(res.stats.matchedCount).toBe(2);
    expect(res.stats.pricedInCurrency).toBe(2);
    expect(res.stats.mixedCurrencies).toBe(false);
    expect(res.stats.totalSoldQuantity).toBe(17);
    expect(res.stats.currency).toBe("USD");
    expect(res.stats.minPrice).toBe(100);
    expect(res.stats.maxPrice).toBe(120);
    expect(res.stats.medianPrice).toBe(110);
    // (120*12 + 100*5) / 17 = 1940/17 = 114.117... → 114.12
    expect(res.stats.soldWeightedMeanPrice).toBe(114.12);
    expect(res.note).toMatch(/ACTIVE listings/);
  });

  it("excludes off-currency listings from price stats and flags mixedCurrencies", async () => {
    const fetchImpl = mockFetch([
      {
        itemId: "v1|111|0",
        price: { value: "100.00", currency: "USD" },
        estimatedAvailabilities: [{ estimatedSoldQuantity: 4 }],
      },
      {
        itemId: "v1|222|0",
        price: { value: "9000.00", currency: "GBP" }, // off-currency for EBAY_US — must NOT pollute stats
        estimatedAvailabilities: [{ estimatedSoldQuantity: 50 }],
      },
    ]);
    const res = await getSalesVelocity(authConfig(), { query: "x", marketplaceId: "EBAY_US" }, fetchImpl);
    // both listings are returned (matched), with their native currencies
    expect(res.stats.matchedCount).toBe(2);
    expect(res.items).toHaveLength(2);
    // ...but price stats reflect ONLY the USD listing
    expect(res.stats.currency).toBe("USD");
    expect(res.stats.pricedInCurrency).toBe(1);
    expect(res.stats.mixedCurrencies).toBe(true);
    expect(res.stats.medianPrice).toBe(100);
    expect(res.stats.maxPrice).toBe(100); // the 9000 GBP did NOT leak in
    expect(res.stats.soldWeightedMeanPrice).toBe(100);
    expect(res.note).toMatch(/excluded from the stats/);
  });

  it("counts a matched listing with no price in totalSoldQuantity but not in price stats", async () => {
    const fetchImpl = mockFetch([
      { itemId: "v1|111|0", estimatedAvailabilities: [{ estimatedSoldQuantity: 8 }] }, // no price
    ]);
    const res = await getSalesVelocity(authConfig(), { query: "x" }, fetchImpl);
    expect(res.items).toHaveLength(1);
    expect(res.stats.matchedCount).toBe(1);
    expect(res.stats.totalSoldQuantity).toBe(8);
    expect(res.stats.pricedInCurrency).toBe(0);
    expect(res.stats.medianPrice).toBeUndefined();
    expect(res.stats.soldWeightedMeanPrice).toBeUndefined();
  });

  it("survives all detail fetches failing (skipped == inspected, empty items)", async () => {
    const fetchImpl = mockFetch([
      { itemId: "v1|111|0", price: { value: "10.00", currency: "USD" }, fail: true },
      { itemId: "v1|222|0", price: { value: "20.00", currency: "USD" }, fail: true },
    ]);
    const res = await getSalesVelocity(authConfig(), { query: "x" }, fetchImpl);
    expect(res.skipped).toBe(2);
    expect(res.inspected).toBe(2);
    expect(res.items).toHaveLength(0);
    expect(res.stats.matchedCount).toBe(0);
    expect(res.stats.totalSoldQuantity).toBe(0);
    expect(res.stats.medianPrice).toBeUndefined();
  });

  it("computes an odd-count median correctly", async () => {
    const fetchImpl = mockFetch([
      { itemId: "v1|1|0", price: { value: "10.00", currency: "USD" }, estimatedAvailabilities: [{ estimatedSoldQuantity: 1 }] },
      { itemId: "v1|2|0", price: { value: "30.00", currency: "USD" }, estimatedAvailabilities: [{ estimatedSoldQuantity: 1 }] },
      { itemId: "v1|3|0", price: { value: "20.00", currency: "USD" }, estimatedAvailabilities: [{ estimatedSoldQuantity: 1 }] },
    ]);
    const res = await getSalesVelocity(authConfig(), { query: "x" }, fetchImpl);
    expect(res.stats.medianPrice).toBe(20); // middle of [10,20,30]
  });

  it("minSoldQuantity=0 keeps zero-sale listings", async () => {
    const fetchImpl = mockFetch([
      { itemId: "v1|111|0", price: { value: "50.00", currency: "USD" }, estimatedAvailabilities: [{ estimatedSoldQuantity: 0 }] },
    ]);
    const res = await getSalesVelocity(
      authConfig(),
      { query: "widget", minSoldQuantity: 0 },
      fetchImpl
    );
    expect(res.items).toHaveLength(1);
    expect(res.items[0].estimatedSoldQuantity).toBe(0);
  });

  it("treats missing estimatedAvailabilities as zero sold", async () => {
    const fetchImpl = mockFetch([
      { itemId: "v1|111|0", price: { value: "50.00", currency: "USD" } },
    ]);
    const res = await getSalesVelocity(authConfig(), { query: "widget" }, fetchImpl);
    expect(res.items).toHaveLength(0);
    expect(res.inspected).toBe(1);
    expect(res.stats.matchedCount).toBe(0);
  });

  it("sums sold quantity across multiple availability entries", async () => {
    const fetchImpl = mockFetch([
      {
        itemId: "v1|111|0",
        price: { value: "10.00", currency: "USD" },
        estimatedAvailabilities: [
          { estimatedSoldQuantity: 3 },
          { estimatedSoldQuantity: 4 },
        ],
      },
    ]);
    const res = await getSalesVelocity(authConfig(), { query: "widget" }, fetchImpl);
    expect(res.items[0].estimatedSoldQuantity).toBe(7);
  });

  it("skips items whose detail fetch fails without failing the call", async () => {
    const fetchImpl = mockFetch([
      { itemId: "v1|111|0", price: { value: "10.00", currency: "USD" }, fail: true },
      {
        itemId: "v1|222|0",
        price: { value: "20.00", currency: "USD" },
        estimatedAvailabilities: [{ estimatedSoldQuantity: 2 }],
      },
    ]);
    const res = await getSalesVelocity(authConfig(), { query: "widget" }, fetchImpl);
    expect(res.skipped).toBe(1);
    expect(res.items).toHaveLength(1);
    expect(res.items[0].itemId).toBe("v1|222|0");
  });

  it("rejects an empty query", async () => {
    await expect(
      getSalesVelocity(authConfig(), { query: "  " }, mockFetch([]))
    ).rejects.toThrow(/query is required/);
  });

  it("rejects out-of-range sampleSize", async () => {
    await expect(
      getSalesVelocity(authConfig(), { query: "x", sampleSize: 0 }, mockFetch([]))
    ).rejects.toThrow(/sampleSize/);
    await expect(
      getSalesVelocity(authConfig(), { query: "x", sampleSize: 21 }, mockFetch([]))
    ).rejects.toThrow(/sampleSize/);
  });

  it("rejects negative minSoldQuantity", async () => {
    await expect(
      getSalesVelocity(authConfig(), { query: "x", minSoldQuantity: -1 }, mockFetch([]))
    ).rejects.toThrow(/minSoldQuantity/);
  });

  it("handles an empty search result cleanly", async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/item_summary/search")) {
        return new Response(JSON.stringify({ total: 0, itemSummaries: [] }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;
    const res = await getSalesVelocity(authConfig(), { query: "zzz" }, fetchImpl);
    expect(res.inspected).toBe(0);
    expect(res.items).toHaveLength(0);
    expect(res.stats.totalSoldQuantity).toBe(0);
  });
});
