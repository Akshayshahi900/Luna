import { describe, expect, it } from "vitest";
import { ago } from "./time";

describe("ago", () => {
  const now = Date.parse("2026-10-18T12:00:00Z");
  it("reads like a person", () => {
    expect(ago("2026-10-18T11:59:40Z", now)).toBe("just now");
    expect(ago("2026-10-18T11:55:00Z", now)).toBe("5 min ago");
    expect(ago("2026-10-18T09:00:00Z", now)).toBe("3 h ago");
    expect(ago("nonsense", now)).toBe("");
  });
});
