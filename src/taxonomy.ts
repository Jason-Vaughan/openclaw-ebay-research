import { apiBaseUrl, getAppToken, withTimeout, type AuthConfig } from "./auth.js";

export interface CategorySuggestionsParams {
  query: string;
  marketplaceId?: string;
  limit?: number;
}

export interface CategoryAncestor {
  categoryId: string;
  categoryName: string;
  categoryTreeNodeLevel?: number;
}

export interface CategorySuggestion {
  categoryId: string;
  categoryName: string;
  ancestors: CategoryAncestor[];
  relevancyTier?: string;
}

export interface CategorySuggestionsResult {
  marketplaceId: string;
  treeId: string;
  count: number;
  suggestions: CategorySuggestion[];
}

export interface CategorySubtreeParams {
  categoryId: string;
  marketplaceId?: string;
}

export interface CategoryNode {
  categoryId: string;
  categoryName: string;
  isLeaf: boolean;
  children: CategoryNode[];
}

export interface CategorySubtreeResult {
  marketplaceId: string;
  treeId: string;
  root: CategoryNode;
}

const DEFAULT_MARKETPLACE = "EBAY_US";

const treeIdCache = new Map<string, string>();

function cacheKey(env: string, marketplaceId: string): string {
  return `${env}::${marketplaceId}`;
}

function clearTreeIdCache(): void {
  treeIdCache.clear();
}

interface RawSuggestionsResponse {
  categorySuggestions?: Array<{
    category?: { categoryId?: string; categoryName?: string };
    categoryTreeNodeAncestors?: Array<{
      categoryId?: string;
      categoryName?: string;
      categoryTreeNodeLevel?: number;
    }>;
    relevancyTier?: string;
  }>;
}

interface RawTreeNode {
  category?: { categoryId?: string; categoryName?: string };
  childCategoryTreeNodes?: RawTreeNode[];
  leafCategoryTreeNode?: boolean;
}

interface RawSubtreeResponse {
  categorySubtreeNode?: RawTreeNode;
}

interface RawTreeIdResponse {
  categoryTreeId?: string;
  categoryTreeVersion?: string;
}

interface EbayError {
  errors?: Array<{
    errorId?: number;
    message?: string;
    longMessage?: string;
  }>;
}

async function callEbayRest<T>(
  config: AuthConfig,
  path: string,
  params: URLSearchParams | undefined,
  fetchImpl: typeof fetch
): Promise<T> {
  const token = await getAppToken(config, { fetchImpl });
  const qs = params && Array.from(params.keys()).length > 0 ? `?${params.toString()}` : "";
  const doRequest = async (accessToken: string, base: string) =>
    withTimeout(
      fetchImpl(`${base}${path}${qs}`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
        },
      }),
      `ebay.taxonomy ${path}`
    );

  let res = await doRequest(token.access_token, apiBaseUrl(token.environment));
  if (res.status === 401) {
    const refreshed = await getAppToken(config, { force: true, fetchImpl });
    if (refreshed.environment !== token.environment) {
      throw new Error(
        `eBay environment changed mid-request (${token.environment} → ${refreshed.environment}). Restart the OpenClaw gateway to pick up the new credentials cleanly.`
      );
    }
    res = await doRequest(refreshed.access_token, apiBaseUrl(refreshed.environment));
  }
  if (!res.ok) {
    const text = await res.text();
    let parsed: EbayError | undefined;
    try {
      parsed = JSON.parse(text) as EbayError;
    } catch {
      parsed = undefined;
    }
    const errorId = parsed?.errors?.[0]?.errorId;
    const message =
      parsed?.errors?.[0]?.longMessage ??
      parsed?.errors?.[0]?.message ??
      text.slice(0, 300);
    throw new Error(
      `eBay Taxonomy API call failed (${res.status} ${res.statusText}${errorId ? ` errorId=${errorId}` : ""}): ${message}`
    );
  }
  return (await res.json()) as T;
}

export async function getDefaultCategoryTreeId(
  config: AuthConfig,
  marketplaceId: string,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  const token = await getAppToken(config, { fetchImpl });
  const key = cacheKey(token.environment, marketplaceId);
  const cached = treeIdCache.get(key);
  if (cached) return cached;
  const qs = new URLSearchParams({ marketplace_id: marketplaceId });
  const raw = await callEbayRest<RawTreeIdResponse>(
    config,
    "/commerce/taxonomy/v1/get_default_category_tree_id",
    qs,
    fetchImpl
  );
  if (!raw.categoryTreeId) {
    throw new Error(
      `eBay Taxonomy: get_default_category_tree_id returned no categoryTreeId for marketplace ${marketplaceId}.`
    );
  }
  treeIdCache.set(key, raw.categoryTreeId);
  return raw.categoryTreeId;
}

export async function getCategorySuggestions(
  config: AuthConfig,
  params: CategorySuggestionsParams,
  fetchImpl: typeof fetch = fetch
): Promise<CategorySuggestionsResult> {
  if (!params.query || params.query.trim() === "") {
    throw new Error("getCategorySuggestions: query is required and cannot be empty.");
  }
  const marketplaceId = params.marketplaceId ?? DEFAULT_MARKETPLACE;
  const treeId = await getDefaultCategoryTreeId(config, marketplaceId, fetchImpl);
  const qs = new URLSearchParams({ q: params.query });
  const raw = await callEbayRest<RawSuggestionsResponse>(
    config,
    `/commerce/taxonomy/v1/category_tree/${encodeURIComponent(treeId)}/get_category_suggestions`,
    qs,
    fetchImpl
  );
  const limit = params.limit ?? 10;
  const suggestions: CategorySuggestion[] = (raw.categorySuggestions ?? [])
    .slice(0, limit)
    .map((s) => ({
      categoryId: s.category?.categoryId ?? "",
      categoryName: s.category?.categoryName ?? "",
      relevancyTier: s.relevancyTier,
      ancestors: (s.categoryTreeNodeAncestors ?? []).map((a) => ({
        categoryId: a.categoryId ?? "",
        categoryName: a.categoryName ?? "",
        categoryTreeNodeLevel: a.categoryTreeNodeLevel,
      })),
    }));
  return {
    marketplaceId,
    treeId,
    count: suggestions.length,
    suggestions,
  };
}

function normalizeNode(raw: RawTreeNode | undefined): CategoryNode {
  return {
    categoryId: raw?.category?.categoryId ?? "",
    categoryName: raw?.category?.categoryName ?? "",
    isLeaf: raw?.leafCategoryTreeNode === true,
    children: (raw?.childCategoryTreeNodes ?? []).map((child) => normalizeNode(child)),
  };
}

export async function getCategorySubtree(
  config: AuthConfig,
  params: CategorySubtreeParams,
  fetchImpl: typeof fetch = fetch
): Promise<CategorySubtreeResult> {
  if (!params.categoryId || params.categoryId.trim() === "") {
    throw new Error("getCategorySubtree: categoryId is required.");
  }
  const marketplaceId = params.marketplaceId ?? DEFAULT_MARKETPLACE;
  const treeId = await getDefaultCategoryTreeId(config, marketplaceId, fetchImpl);
  const qs = new URLSearchParams({ category_id: params.categoryId });
  const raw = await callEbayRest<RawSubtreeResponse>(
    config,
    `/commerce/taxonomy/v1/category_tree/${encodeURIComponent(treeId)}/get_category_subtree`,
    qs,
    fetchImpl
  );
  return {
    marketplaceId,
    treeId,
    root: normalizeNode(raw.categorySubtreeNode),
  };
}

export const _internal = {
  clearTreeIdCache,
  treeIdCache,
};
