import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CAPABILITIES, FAQ, INSTALL, SECTIONS, SHOTS, SPECS } from "./content";

const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const sectionSources = ["Capabilities", "Showcase", "How", "Specs", "Install", "Usage", "Faq"]
  .map((name) => readFileSync(new URL(`./sections/${name}.tsx`, import.meta.url), "utf8"))
  .join("\n");

describe("site content", () => {
  it("every capability is complete", () => {
    expect(CAPABILITIES.length).toBeGreaterThanOrEqual(8);
    for (const c of CAPABILITIES) {
      expect(c.title.trim()).not.toBe("");
      expect(c.text.trim()).not.toBe("");
      expect(c.icon).toBeTruthy();
      expect(c.points.length).toBeGreaterThan(0);
    }
    expect(new Set(CAPABILITIES.map((c) => c.title)).size).toBe(CAPABILITIES.length);
  });

  it("every nav link has a section with that id", () => {
    for (const s of SECTIONS) expect(sectionSources).toContain(`id="${s.id}"`);
    expect(appSource).toContain("<Faq />");
  });

  it("install steps start Luna and have commands", () => {
    expect(INSTALL.filter((s) => !s.optional).every((s) => s.code?.trim())).toBe(true);
    expect(INSTALL.some((s) => s.code?.includes("uv run luna-web"))).toBe(true);
  });

  it("every screenshot exists in public/", () => {
    for (const shot of SHOTS) {
      expect(existsSync(new URL(`../public/${shot.src}`, import.meta.url)), shot.src).toBe(true);
    }
  });

  it("specs and FAQ have no empty rows", () => {
    for (const g of SPECS) for (const [k, v] of g.rows) expect(k && v).toBeTruthy();
    for (const f of FAQ) expect(f.q.endsWith("?") && f.a.length > 20).toBe(true);
  });
});
