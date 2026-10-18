import { describe, expect, it } from "vitest";
import { isEcho, isStopCommand, parseApproval, parseDecision, parseVoiceCommand, parseWake } from "./intent";

describe("parseDecision", () => {
  it.each([
    ["approve", "approve"],
    ["Yes, go ahead", "approve"],
    ["authorize it", "approve"],
    ["no", "reject"],
    ["deny that", "reject"],
    ["don't do it", "reject"],
    ["no, do it in notes.md instead", "reject"],
    ["what does it do", null],
    ["yes no", null],
  ])("%s → %s", (text, want) => {
    expect(parseDecision(text)).toBe(want);
  });
});

describe("parseApproval", () => {
  it("keeps the reason of a spoken denial", () => {
    expect(parseApproval("No, call it notes.md instead")).toEqual({ decision: "reject", reason: "call it notes.md instead" });
    expect(parseApproval("deny, because it's risky")).toEqual({ decision: "reject", reason: "it's risky" });
    expect(parseApproval("Deny.")).toEqual({ decision: "reject" });
    expect(parseApproval("Approved.")).toEqual({ decision: "approve" });
    expect(parseApproval("hmm")).toBeNull();
  });
});

describe("parseWake", () => {
  it.each([
    // Real Whisper outputs from our tests, including its misspellings.
    ["Hey Luna, what's the weather in Delhi today?", "What's the weather in Delhi today?"],
    ["Lunar switched to Grog.", "Switched to Grog."],
    ["Heilunar approved that.", "Approved that."],
    ["Hey, Lunar!", ""],
    ["Okay, lunar, open my notes.", "Open my notes."],
    ["luna stop.", "Stop."],
  ])("%s", (text, rest) => {
    expect(parseWake(text)).toEqual({ woke: true, rest });
  });

  it.each(["The Luna Eclipse is tonight.", "I'll have lunch at noon.", "What time is it?", "Lunatic fringe"])(
    "does not wake on %s",
    (text) => {
      expect(parseWake(text).woke).toBe(false);
    },
  );
});

describe("parseVoiceCommand", () => {
  it.each([
    ["Stop.", { kind: "hush" }],
    ["be quiet", { kind: "hush" }],
    ["Cancel that.", { kind: "cancel" }],
    ["never mind", { kind: "cancel" }],
    ["Switch to Grog.", { kind: "model", provider: "groq" }],
    ["use ollama", { kind: "model", provider: "ollama" }],
    ["change the model to OpenRouter", { kind: "model", provider: "openrouter" }],
    ["Start a new conversation.", { kind: "new_thread" }],
    ["start over", { kind: "new_thread" }],
    ["Go to sleep.", { kind: "sleep" }],
    ["show the transcript", { kind: "transcript", open: true }],
    ["close log", { kind: "transcript", open: false }],
  ])("%s", (text, want) => {
    expect(parseVoiceCommand(text)).toEqual(want);
  });

  it.each(["use the calculator to add 2 and 2", "cancel my 3pm meeting", "stop the server on port 80", "what's new"])(
    "leaves %s for the model",
    (text) => {
      expect(parseVoiceCommand(text)).toBeNull();
    },
  );
});

describe("isStopCommand", () => {
  it("matches short hush commands only", () => {
    expect(isStopCommand("stop")).toBe(true);
    expect(isStopCommand("Luna, be quiet.")).toBe(true);
    expect(isStopCommand("stop the server on port 80")).toBe(false);
  });
});

describe("isEcho", () => {
  const said = ["The answer is 42.", "I computed that with the calculator."];
  it("spots Luna's own words coming back through the mic", () => {
    expect(isEcho("I computed that with the calculator", said)).toBe(true);
    expect(isEcho("the answer is 42", said)).toBe(true);
  });
  it("lets real speech and short barge-ins through", () => {
    expect(isEcho("Luna, stop", said)).toBe(false);
    expect(isEcho("now save the answer to a file", said)).toBe(false);
  });
});
