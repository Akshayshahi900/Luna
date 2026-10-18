import { describe, expect, it } from "vitest";
import { isStopCommand, parseDecision } from "./intent";

describe("parseDecision", () => {
  it.each([
    ["approve", "approve"],
    ["Yes, go ahead", "approve"],
    ["authorize it", "approve"],
    ["no", "reject"],
    ["deny that", "reject"],
    ["don't do it", null],
    ["what does it do", null],
    ["yes no", null],
  ])("%s → %s", (text, want) => {
    expect(parseDecision(text)).toBe(want);
  });
});

describe("isStopCommand", () => {
  it("matches short hush commands only", () => {
    expect(isStopCommand("stop")).toBe(true);
    expect(isStopCommand("Luna, be quiet.")).toBe(true);
    expect(isStopCommand("stop the server on port 80")).toBe(false);
  });
});
