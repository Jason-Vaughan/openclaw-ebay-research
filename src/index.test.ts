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

describe("plugin surface", () => {
  it("has the expected plugin id", () => {
    expect((plugin as { id: string }).id).toBe("tangleclaw-ebay-research");
  });

  it("registers exactly 7 tools (auth + browse x2 + sold-signal + taxonomy x2 + insights)", () => {
    const tools = collectTools();
    expect(tools).toHaveLength(7);
  });

  it("registers all expected tool names", () => {
    const tools = collectTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "ebay_research_auth_status",
      "ebay_research_get_category_subtree",
      "ebay_research_get_category_suggestions",
      "ebay_research_get_item",
      "ebay_research_get_sold_history",
      "ebay_research_search_active_listings",
      "ebay_research_whats_selling",
    ]);
  });

  it("manifest contracts.tools exactly matches the registered tools (drift guard)", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const here = dirname(fileURLToPath(import.meta.url));
    const manifest = JSON.parse(
      await readFile(join(here, "..", "openclaw.plugin.json"), "utf8")
    ) as { contracts?: { tools?: string[] } };
    const declared = [...(manifest.contracts?.tools ?? [])].sort();
    const registered = collectTools()
      .map((t) => t.name)
      .sort();
    expect(declared).toEqual(registered);
  });

  it("every tool has a label, description, and parameters schema", () => {
    const tools = collectTools();
    for (const tool of tools) {
      expect(tool.label, `tool ${tool.name} is missing a label`).toBeTruthy();
      expect(
        tool.description.length,
        `tool ${tool.name} description is too short`
      ).toBeGreaterThan(40);
      expect(tool.parameters).toBeTruthy();
    }
  });
});
