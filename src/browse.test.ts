import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  searchActiveListings,
  getItem,
  _internal,
} from "./browse.js";
import type { AuthConfig } from "./auth.js";

let workDir: string;
let credsPath: string;
let tokenPath: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "ebay-browse-test-"));
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

describe("buildSortParam", () => {
  it("maps price_asc to 'price'", () => {
    expect(_internal.buildSortParam("price_asc")).toBe("price");
  });
  it("maps price_desc to '-price'", () => {
    expect(_internal.buildSortParam("price_desc")).toBe("-price");
  });
  it("maps newly_listed to 'newlyListed'", () => {
    expect(_internal.buildSortParam("newly_listed")).toBe("newlyListed");
  });
  it("returns undefined for best_match (eBay default)", () => {
    expect(_internal.buildSortParam("best_match")).toBeUndefined();
  });
  it("returns undefined for missing sort", () => {
    expect(_internal.buildSortParam(undefined)).toBeUndefined();
  });
});

describe("buildFilterParam", () => {
  it("returns undefined when no filters are set", () => {
    expect(
      _internal.buildFilterParam({ query: "x" }, "EBAY_US")
    ).toBeUndefined();
  });
  it("builds a single-condition filter", () => {
    expect(
      _internal.buildFilterParam({ query: "x", condition: "USED" }, "EBAY_US")
    ).toBe("conditions:{USED}");
  });
  it("builds a multi-condition filter joined by pipe", () => {
    expect(
      _internal.buildFilterParam(
        { query: "x", condition: ["NEW", "USED"] },
        "EBAY_US"
      )
    ).toBe("conditions:{NEW|USED}");
  });
  it("builds a price range filter in USD for EBAY_US", () => {
    const f = _internal.buildFilterParam(
      { query: "x", priceMin: 10, priceMax: 500 },
      "EBAY_US"
    );
    expect(f).toContain("price:[10..500]");
    expect(f).toContain("priceCurrency:USD");
  });
  it("builds a price range filter in GBP for EBAY_GB", () => {
    const f = _internal.buildFilterParam(
      { query: "x", priceMin: 10, priceMax: 500 },
      "EBAY_GB"
    );
    expect(f).toContain("priceCurrency:GBP");
    expect(f).not.toContain("priceCurrency:USD");
  });
  it("builds a price range filter in EUR for EBAY_DE", () => {
    const f = _internal.buildFilterParam(
      { query: "x", priceMin: 10, priceMax: 500 },
      "EBAY_DE"
    );
    expect(f).toContain("priceCurrency:EUR");
  });
  it("builds an open-ended price filter when only priceMin is set", () => {
    const f = _internal.buildFilterParam(
      { query: "x", priceMin: 100 },
      "EBAY_US"
    );
    expect(f).toContain("price:[100..]");
  });
  it("combines condition + price filters with commas", () => {
    const f = _internal.buildFilterParam(
      { query: "x", condition: "USED", priceMax: 200 },
      "EBAY_US"
    );
    expect(f).toBe("conditions:{USED},price:[0..200],priceCurrency:USD");
  });
});

describe("searchActiveListings", () => {
  it("calls Browse API with q, limit, offset, marketplace header, and Bearer token", async () => {
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};
    const fetchMock = (async (url: string, init: RequestInit) => {
      capturedUrl = url;
      capturedHeaders = init.headers as Record<string, string>;
      return new Response(
        JSON.stringify({
          total: 1,
          limit: 5,
          offset: 0,
          itemSummaries: [
            {
              itemId: "v1|123|0",
              title: "Test Item",
              price: { value: "10.00", currency: "USD" },
              itemWebUrl: "https://www.ebay.com/itm/123",
            },
          ],
        }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const result = await searchActiveListings(
      authConfig(),
      { query: "nikon d750", limit: 5 },
      fetchMock
    );

    expect(capturedUrl).toContain("https://api.sandbox.ebay.com/buy/browse/v1/item_summary/search");
    expect(capturedUrl).toContain("q=nikon+d750");
    expect(capturedUrl).toContain("limit=5");
    expect(capturedUrl).toContain("offset=0");
    expect(capturedHeaders.Authorization).toBe("Bearer test-token");
    expect(capturedHeaders["X-EBAY-C-MARKETPLACE-ID"]).toBe("EBAY_US");
    expect(result.total).toBe(1);
    expect(result.items[0].itemId).toBe("v1|123|0");
    expect(result.items[0].itemWebUrl).toBe("https://www.ebay.com/itm/123");
  });

  it("passes through auction fields (buyingOptions, currentBidPrice, bidCount)", async () => {
    const fetchMock = (async () =>
      new Response(
        JSON.stringify({
          total: 1,
          limit: 5,
          offset: 0,
          itemSummaries: [
            {
              itemId: "v1|999|0",
              title: "RTX PRO 6000 (auction)",
              price: { value: "2100.00", currency: "USD" },
              buyingOptions: ["AUCTION"],
              currentBidPrice: { value: "2100.00", currency: "USD" },
              bidCount: 7,
              itemWebUrl: "https://www.ebay.com/itm/999",
            },
          ],
        }),
        { status: 200 }
      )) as unknown as typeof fetch;

    const result = await searchActiveListings(
      authConfig(),
      { query: "rtx pro 6000", limit: 5 },
      fetchMock
    );
    const it0 = result.items[0];
    expect(it0.buyingOptions).toEqual(["AUCTION"]);
    expect(it0.currentBidPrice).toEqual({ value: "2100.00", currency: "USD" });
    expect(it0.bidCount).toBe(7);
  });

  it("passes sort + filter params when set", async () => {
    let capturedUrl = "";
    const fetchMock = (async (url: string) => {
      capturedUrl = url;
      return new Response(
        JSON.stringify({ total: 0, limit: 10, offset: 0, itemSummaries: [] }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    await searchActiveListings(
      authConfig(),
      {
        query: "nikon d750",
        sort: "price_asc",
        condition: "USED",
        priceMax: 500,
      },
      fetchMock
    );

    expect(capturedUrl).toContain("sort=price");
    expect(capturedUrl).toContain("filter=conditions");
    expect(decodeURIComponent(capturedUrl)).toContain("conditions:{USED}");
    expect(decodeURIComponent(capturedUrl)).toContain("price:[0..500]");
  });

  it("uses the override marketplaceId when provided", async () => {
    let capturedHeaders: Record<string, string> = {};
    const fetchMock = (async (_url: string, init: RequestInit) => {
      capturedHeaders = init.headers as Record<string, string>;
      return new Response(
        JSON.stringify({ total: 0, limit: 10, offset: 0, itemSummaries: [] }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    await searchActiveListings(
      authConfig(),
      { query: "x", marketplaceId: "EBAY_GB" },
      fetchMock
    );
    expect(capturedHeaders["X-EBAY-C-MARKETPLACE-ID"]).toBe("EBAY_GB");
  });

  it("rejects empty query", async () => {
    await expect(
      searchActiveListings(authConfig(), { query: "" }, fetch)
    ).rejects.toThrow(/query is required/);
  });

  it("rejects out-of-range limit", async () => {
    await expect(
      searchActiveListings(authConfig(), { query: "x", limit: 0 }, fetch)
    ).rejects.toThrow(/limit must be/);
    await expect(
      searchActiveListings(authConfig(), { query: "x", limit: 500 }, fetch)
    ).rejects.toThrow(/limit must be/);
  });

  it("rejects offset+limit exceeding eBay's 10000 hard cap", async () => {
    await expect(
      searchActiveListings(
        authConfig(),
        { query: "x", offset: 9999, limit: 10 },
        fetch
      )
    ).rejects.toThrow(/10000/);
  });

  it("passes priceCurrency:GBP when searching EBAY_GB with a price range", async () => {
    let capturedUrl = "";
    const fetchMock = (async (url: string) => {
      capturedUrl = url;
      return new Response(
        JSON.stringify({ total: 0, limit: 10, offset: 0, itemSummaries: [] }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;
    await searchActiveListings(
      authConfig(),
      { query: "bmx", marketplaceId: "EBAY_GB", priceMax: 200 },
      fetchMock
    );
    expect(decodeURIComponent(capturedUrl)).toContain("priceCurrency:GBP");
  });

  it("surfaces eBay API error responses with errorId + message", async () => {
    const fetchMock = (async () =>
      new Response(
        JSON.stringify({
          errors: [
            {
              errorId: 12001,
              message: "Marketplace not supported",
              longMessage: "The marketplace EBAY_XX is not supported.",
            },
          ],
        }),
        { status: 400, statusText: "Bad Request" }
      )) as unknown as typeof fetch;
    await expect(
      searchActiveListings(
        authConfig(),
        { query: "x", marketplaceId: "EBAY_XX" },
        fetchMock
      )
    ).rejects.toThrow(/errorId=12001.*not supported/);
  });

  it("throws clearly when 401-retry detects an environment switch", async () => {
    let calls = 0;
    const fetchMock = (async () => {
      calls += 1;
      if (calls === 1) {
        // First (browse) request → 401. Swap creds to production HERE so
        // the next force-refresh getAppToken reads the new env.
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
      // Second call: oauth token refresh (now against production creds).
      return new Response(
        JSON.stringify({
          access_token: "prod",
          token_type: "App",
          expires_in: 7200,
          scope: "https://api.ebay.com/oauth/api_scope",
        }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;
    await expect(
      searchActiveListings(authConfig(), { query: "x" }, fetchMock)
    ).rejects.toThrow(/environment changed mid-request/);
  });

  it("surfaces a meaningful error when eBay returns non-JSON 500", async () => {
    const fetchMock = (async () =>
      new Response("Internal Server Error", {
        status: 500,
        statusText: "Internal Server Error",
      })) as unknown as typeof fetch;
    await expect(
      searchActiveListings(authConfig(), { query: "x" }, fetchMock)
    ).rejects.toThrow(/Internal Server Error/);
  });

  it("retries once on 401 with a fresh token", async () => {
    // Set a fresh cached token so the first call uses it.
    let calls = 0;
    const responses = [
      // browse call #1 -> 401
      new Response(JSON.stringify({ errors: [{ errorId: 1001, message: "expired" }] }), {
        status: 401,
        statusText: "Unauthorized",
      }),
      // token refresh
      new Response(
        JSON.stringify({ access_token: "fresh", token_type: "App", expires_in: 7200 }),
        { status: 200 }
      ),
      // browse call #2 -> success
      new Response(
        JSON.stringify({ total: 1, limit: 10, offset: 0, itemSummaries: [] }),
        { status: 200 }
      ),
    ];
    const fetchMock = (async () => {
      const r = responses[calls];
      calls += 1;
      return r;
    }) as unknown as typeof fetch;

    const result = await searchActiveListings(
      authConfig(),
      { query: "x" },
      fetchMock
    );
    expect(calls).toBe(3);
    expect(result.total).toBe(1);
  });
});

describe("getItem", () => {
  it("calls the item endpoint with the encoded itemId", async () => {
    let capturedUrl = "";
    const fetchMock = (async (url: string) => {
      capturedUrl = url;
      return new Response(
        JSON.stringify({ itemId: "v1|123|0", title: "Detail" }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;
    const result = await getItem(
      authConfig(),
      { itemId: "v1|123|0" },
      fetchMock
    );
    expect(capturedUrl).toContain("/buy/browse/v1/item/v1%7C123%7C0");
    expect((result as { title: string }).title).toBe("Detail");
  });

  it("rejects empty itemId", async () => {
    await expect(getItem(authConfig(), { itemId: "" }, fetch)).rejects.toThrow(
      /itemId is required/
    );
  });
});
