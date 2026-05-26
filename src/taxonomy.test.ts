import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getDefaultCategoryTreeId,
  getCategorySuggestions,
  getCategorySubtree,
  _internal,
} from "./taxonomy.js";
import type { AuthConfig } from "./auth.js";

let workDir: string;
let credsPath: string;
let tokenPath: string;

beforeEach(async () => {
  _internal.clearTreeIdCache();
  workDir = await mkdtemp(join(tmpdir(), "ebay-taxonomy-test-"));
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("getDefaultCategoryTreeId", () => {
  it("fetches the tree id and caches it per (env, marketplace)", async () => {
    let calls = 0;
    const fetchMock = (async (url: string) => {
      calls += 1;
      expect(url).toContain(
        "/commerce/taxonomy/v1/get_default_category_tree_id"
      );
      expect(url).toContain("marketplace_id=EBAY_US");
      return jsonResponse({ categoryTreeId: "0", categoryTreeVersion: "127" });
    }) as unknown as typeof fetch;

    const id1 = await getDefaultCategoryTreeId(authConfig(), "EBAY_US", fetchMock);
    const id2 = await getDefaultCategoryTreeId(authConfig(), "EBAY_US", fetchMock);
    expect(id1).toBe("0");
    expect(id2).toBe("0");
    expect(calls).toBe(1);
  });

  it("re-fetches when a different marketplace is asked for", async () => {
    let calls = 0;
    const fetchMock = (async (url: string) => {
      calls += 1;
      const marketplace = url.includes("EBAY_GB") ? "GB" : "US";
      return jsonResponse({
        categoryTreeId: marketplace === "GB" ? "3" : "0",
      });
    }) as unknown as typeof fetch;
    const us = await getDefaultCategoryTreeId(authConfig(), "EBAY_US", fetchMock);
    const gb = await getDefaultCategoryTreeId(authConfig(), "EBAY_GB", fetchMock);
    expect(us).toBe("0");
    expect(gb).toBe("3");
    expect(calls).toBe(2);
  });

  it("throws if the API response is missing categoryTreeId", async () => {
    const fetchMock = (async () => jsonResponse({})) as unknown as typeof fetch;
    await expect(
      getDefaultCategoryTreeId(authConfig(), "EBAY_US", fetchMock)
    ).rejects.toThrow(/categoryTreeId/);
  });
});

describe("getCategorySuggestions", () => {
  it("calls the right path with the query + uses the cached tree id", async () => {
    const seenPaths: string[] = [];
    const fetchMock = (async (url: string) => {
      seenPaths.push(url);
      if (url.includes("get_default_category_tree_id")) {
        return jsonResponse({ categoryTreeId: "0" });
      }
      return jsonResponse({
        categorySuggestions: [
          {
            category: { categoryId: "31388", categoryName: "Digital Cameras" },
            relevancyTier: "BEST_MATCH",
            categoryTreeNodeAncestors: [
              { categoryId: "625", categoryName: "Cameras & Photo", categoryTreeNodeLevel: 1 },
            ],
          },
        ],
      });
    }) as unknown as typeof fetch;

    const result = await getCategorySuggestions(
      authConfig(),
      { query: "nikon d750" },
      fetchMock
    );

    expect(seenPaths.some((p) => p.includes("get_default_category_tree_id"))).toBe(true);
    const suggestionsUrl = seenPaths.find((p) => p.includes("get_category_suggestions"));
    expect(suggestionsUrl).toContain("/category_tree/0/get_category_suggestions");
    expect(suggestionsUrl).toContain("q=nikon+d750");
    expect(result.count).toBe(1);
    expect(result.suggestions[0].categoryId).toBe("31388");
    expect(result.suggestions[0].categoryName).toBe("Digital Cameras");
    expect(result.suggestions[0].ancestors[0].categoryName).toBe("Cameras & Photo");
    expect(result.treeId).toBe("0");
    expect(result.marketplaceId).toBe("EBAY_US");
  });

  it("respects the limit parameter", async () => {
    const fetchMock = (async (url: string) => {
      if (url.includes("get_default_category_tree_id")) {
        return jsonResponse({ categoryTreeId: "0" });
      }
      return jsonResponse({
        categorySuggestions: [
          { category: { categoryId: "1", categoryName: "A" } },
          { category: { categoryId: "2", categoryName: "B" } },
          { category: { categoryId: "3", categoryName: "C" } },
        ],
      });
    }) as unknown as typeof fetch;
    const result = await getCategorySuggestions(
      authConfig(),
      { query: "x", limit: 2 },
      fetchMock
    );
    expect(result.count).toBe(2);
    expect(result.suggestions.map((s) => s.categoryId)).toEqual(["1", "2"]);
  });

  it("returns an empty list when eBay returns no suggestions", async () => {
    const fetchMock = (async (url: string) => {
      if (url.includes("get_default_category_tree_id")) {
        return jsonResponse({ categoryTreeId: "0" });
      }
      return jsonResponse({});
    }) as unknown as typeof fetch;
    const result = await getCategorySuggestions(
      authConfig(),
      { query: "completely unknown widget xyzzy" },
      fetchMock
    );
    expect(result.count).toBe(0);
    expect(result.suggestions).toEqual([]);
  });

  it("rejects empty query", async () => {
    await expect(
      getCategorySuggestions(authConfig(), { query: "" }, fetch)
    ).rejects.toThrow(/query is required/);
  });

  it("surfaces eBay errors with errorId", async () => {
    const fetchMock = (async (url: string) => {
      if (url.includes("get_default_category_tree_id")) {
        return jsonResponse({ categoryTreeId: "0" });
      }
      return jsonResponse(
        {
          errors: [
            { errorId: 62000, message: "Invalid request", longMessage: "Bad query" },
          ],
        },
        400
      );
    }) as unknown as typeof fetch;
    await expect(
      getCategorySuggestions(authConfig(), { query: "x" }, fetchMock)
    ).rejects.toThrow(/errorId=62000.*Bad query/);
  });
});

describe("getCategorySubtree", () => {
  it("calls the right path and normalizes the tree structure", async () => {
    const fetchMock = (async (url: string) => {
      if (url.includes("get_default_category_tree_id")) {
        return jsonResponse({ categoryTreeId: "0" });
      }
      expect(url).toContain("/category_tree/0/get_category_subtree");
      expect(url).toContain("category_id=625");
      return jsonResponse({
        categorySubtreeNode: {
          category: { categoryId: "625", categoryName: "Cameras & Photo" },
          leafCategoryTreeNode: false,
          childCategoryTreeNodes: [
            {
              category: { categoryId: "31388", categoryName: "Digital Cameras" },
              leafCategoryTreeNode: false,
              childCategoryTreeNodes: [
                {
                  category: { categoryId: "31388-x", categoryName: "DSLR" },
                  leafCategoryTreeNode: true,
                },
              ],
            },
            {
              category: { categoryId: "15230", categoryName: "Lenses" },
              leafCategoryTreeNode: false,
            },
          ],
        },
      });
    }) as unknown as typeof fetch;

    const result = await getCategorySubtree(
      authConfig(),
      { categoryId: "625" },
      fetchMock
    );

    expect(result.root.categoryId).toBe("625");
    expect(result.root.categoryName).toBe("Cameras & Photo");
    expect(result.root.isLeaf).toBe(false);
    expect(result.root.children).toHaveLength(2);
    expect(result.root.children[0].children[0].isLeaf).toBe(true);
    expect(result.root.children[0].children[0].categoryName).toBe("DSLR");
  });

  it("rejects empty categoryId", async () => {
    await expect(
      getCategorySubtree(authConfig(), { categoryId: "" }, fetch)
    ).rejects.toThrow(/categoryId is required/);
  });

  it("handles missing categorySubtreeNode gracefully", async () => {
    const fetchMock = (async (url: string) => {
      if (url.includes("get_default_category_tree_id")) {
        return jsonResponse({ categoryTreeId: "0" });
      }
      return jsonResponse({});
    }) as unknown as typeof fetch;
    const result = await getCategorySubtree(
      authConfig(),
      { categoryId: "999999" },
      fetchMock
    );
    expect(result.root.categoryId).toBe("");
    expect(result.root.children).toEqual([]);
  });
});
