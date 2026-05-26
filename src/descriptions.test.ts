import { describe, it, expect } from "vitest";
import { getToolPluginMetadata } from "openclaw/plugin-sdk/tool-plugin";
import plugin from "./index.js";

interface ToolDef {
  name: string;
  label?: string;
  description: string;
  parameters: unknown;
}

function collectTools(): ToolDef[] {
  const meta = getToolPluginMetadata(plugin);
  if (!meta) throw new Error("plugin metadata missing — defineToolPlugin failed?");
  return meta.tools as ToolDef[];
}

const READ_VERBS = [
  "read",
  "fetch",
  "list",
  "search",
  "find",
  "browse",
  "show",
  "look up",
  "look at",
  "view",
  "get",
  "check",
];

function countMatches(text: string, needles: string[]): number {
  const lower = text.toLowerCase();
  return needles.filter((n) => lower.includes(n)).length;
}

describe("description quality", () => {
  it("read tools each include at least two read-action verbs to help small models route", () => {
    const tools = collectTools();
    const readTools = tools.filter((t) => t.name !== "ebay_research_auth_status");
    for (const tool of readTools) {
      const hits = countMatches(tool.description, READ_VERBS);
      expect(hits, `tool ${tool.name} should mention 2+ read verbs, got ${hits}`).toBeGreaterThanOrEqual(2);
    }
  });

  it("search tool description mentions price + itemWebUrl + filter capabilities", () => {
    const tools = collectTools();
    const search = tools.find((t) => t.name === "ebay_research_search_active_listings");
    expect(search).toBeTruthy();
    const desc = search!.description.toLowerCase();
    expect(desc).toContain("price");
    expect(desc).toContain("itemweburl");
    expect(desc).toContain("sort");
    expect(desc).toContain("condition");
  });

  it("get_item description references parsing an eBay URL", () => {
    const tools = collectTools();
    const get = tools.find((t) => t.name === "ebay_research_get_item");
    expect(get).toBeTruthy();
    expect(get!.description.toLowerCase()).toContain("url");
  });

  it("auth_status description promises NOT to echo the token", () => {
    const tools = collectTools();
    const status = tools.find((t) => t.name === "ebay_research_auth_status");
    expect(status).toBeTruthy();
    expect(status!.description.toLowerCase()).toContain("never echoes the token");
  });

  it("category-suggestions description references the seller-plugin handoff (categoryId)", () => {
    const tools = collectTools();
    const sug = tools.find(
      (t) => t.name === "ebay_research_get_category_suggestions"
    );
    expect(sug).toBeTruthy();
    expect(sug!.description.toLowerCase()).toContain("categoryid");
    expect(sug!.description.toLowerCase()).toContain("ancestors");
  });

  it("category-subtree description mentions the isLeaf flag (which create_offer requires)", () => {
    const tools = collectTools();
    const sub = tools.find(
      (t) => t.name === "ebay_research_get_category_subtree"
    );
    expect(sub).toBeTruthy();
    expect(sub!.description.toLowerCase()).toContain("isleaf");
  });
});
