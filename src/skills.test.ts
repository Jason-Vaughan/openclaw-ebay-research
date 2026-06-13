import { describe, it, expect, beforeAll } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_PATH = join(__dirname, "..", "skills", "ebay-research", "SKILL.md");

let skill = "";

beforeAll(async () => {
  skill = await readFile(SKILL_PATH, "utf8");
});

describe("SKILL.md frontmatter", () => {
  it("has the correct name slug", () => {
    expect(skill).toMatch(/^---[\s\S]*?\nname: ebay-research\n/);
  });
  it("has a description in frontmatter", () => {
    expect(skill).toMatch(/^---[\s\S]*?\ndescription: [^\n]+\n/);
  });
  it("declares the openclaw config requirement matching the plugin id", () => {
    expect(skill).toContain("plugins.entries.tangleclaw-ebay-research.enabled");
  });
});

describe("SKILL.md mentions every tool by name", () => {
  const tools = [
    "ebay_research_auth_status",
    "ebay_research_search_active_listings",
    "ebay_research_get_item",
    "ebay_research_get_category_suggestions",
    "ebay_research_get_category_subtree",
    "ebay_research_get_sold_history",
    "ebay_research_whats_selling",
  ];
  for (const tool of tools) {
    it(`mentions ${tool}`, () => {
      expect(skill).toContain(tool);
    });
  }
});

describe("SKILL.md core rules", () => {
  it("has a 'Rule zero' (never narrate, always re-call) section", () => {
    expect(skill.toLowerCase()).toContain("rule zero");
    expect(skill.toLowerCase()).toContain("never narrate");
    expect(skill.toLowerCase()).toContain("re-call");
  });

  it("has a 'Rule one' (on tool error, fix and re-call) section", () => {
    expect(skill.toLowerCase()).toContain("rule one");
    expect(skill.toLowerCase()).toContain("on tool error");
  });

  it("has a rule mandating itemWebUrl surfacing on every listing reference", () => {
    expect(skill.toLowerCase()).toContain("itemweburl");
    expect(skill.toLowerCase()).toContain("surface");
  });

  it("teaches that cheapest is not the price (accessory-contamination rule)", () => {
    const s = skill.toLowerCase();
    expect(s).toContain("rule three");
    expect(s).toContain("accessor"); // accessories pollute branded/high-value searches
    expect(s).toContain("market price");
    expect(s).toContain("pricemin"); // the defense
  });
});

describe("SKILL.md buyer-side recipes (mandatory per build plan)", () => {
  const recipes = [
    /what does .*sell for/i,
    /best deal/i,
    /under \$/i,
    /tell me about this ebay listing/i,
  ];
  for (const recipe of recipes) {
    it(`includes recipe matching ${recipe}`, () => {
      expect(skill).toMatch(recipe);
    });
  }
});

describe("SKILL.md seller-side recipes (mandatory per build plan)", () => {
  it("includes a price-check candidate listing recipe", () => {
    expect(skill.toLowerCase()).toContain("price-check");
    expect(skill.toLowerCase()).toContain("candidate listing");
  });
  it("includes a category-lookup recipe pointing at create_offer", () => {
    expect(skill.toLowerCase()).toContain("category");
    expect(skill.toLowerCase()).toContain("create_offer");
  });
});

describe("SKILL.md cross-plugin hook", () => {
  it("references the sister seller plugin by id", () => {
    expect(skill).toContain("tangleclaw-ebay-seller");
  });
  it("explicitly forbids the agent from calling ebay_seller_confirm_pending itself", () => {
    expect(skill).toContain("ebay_seller_confirm_pending");
    expect(skill.toLowerCase()).toContain("never call");
    // The strongest guard: even when the operator says affirmative things,
    // the agent must NOT redeem the token autonomously.
    expect(skill.toLowerCase()).toContain("even if the operator");
  });
});

describe("SKILL.md Insights gating", () => {
  it("documents that the disabled response is not a 'no sales' answer", () => {
    expect(skill.toLowerCase()).toContain("enableinsights");
    expect(skill.toLowerCase()).toContain("disabled");
    expect(skill.toLowerCase()).toContain("no sales happened");
  });
  it("distinguishes the disabled-response case from a real zero-sample-size result", () => {
    expect(skill.toLowerCase()).toContain("samplesize");
  });
});

describe("SKILL.md 'NOT' boundaries", () => {
  it("explicitly says no write operations", () => {
    expect(skill.toLowerCase()).toContain("no write operations");
  });
  it("explicitly defers Trading API fallbacks", () => {
    expect(skill.toLowerCase()).toContain("trading api");
  });
});
