import { describe, expect, it } from "vitest";
import { asset } from "./asset";
import { commandsOnly, copyText } from "./clipboard";

describe("copy", () => {
  it("copies with the clipboard API", async () => {
    const written: string[] = [];
    expect(await copyText("uv sync", { writeText: async (t) => void written.push(t) })).toBe(true);
    expect(written).toEqual(["uv sync"]);
  });

  it("reports failure without a document to fall back to", async () => {
    const denied = { writeText: async () => Promise.reject(new Error("denied")) };
    expect(await copyText("x", denied)).toBe(false);
  });

  it("drops comment lines", () => {
    expect(commandsOnly("cp .env.example .env\n# edit .env\n  # indented\nuv sync")).toBe("cp .env.example .env\nuv sync");
  });
});

describe("asset", () => {
  it("joins the base path", () => {
    expect(asset("screens/hud.png", "/Luna/")).toBe("/Luna/screens/hud.png");
    expect(asset("/luna.svg", "/")).toBe("/luna.svg");
  });
});
