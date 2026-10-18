import { describe, expect, it } from "vitest";
import type { ServerEvent } from "./protocol";
import { helperOf, initialState, type LunaState, nestActivity, reducer } from "./state";

const run = (events: ServerEvent[], start: LunaState = initialState) =>
  events.reduce((s, event) => reducer(s, { kind: "server", event }), start);

describe("reducer", () => {
  it("streams tokens into one Luna message and finishes on done", () => {
    const s0 = reducer(initialState, { kind: "user", text: "hi" });
    const s = run([{ type: "state", value: "thinking" }, { type: "token", text: "Hel" }, { type: "token", text: "lo" }], s0);
    expect(s.busy).toBe(true);
    expect(s.messages.map((m) => [m.role, m.text])).toEqual([["user", "hi"], ["luna", "Hello"]]);
    const done = run([{ type: "done" }], s);
    expect(done.busy).toBe(false);
    expect(done.replyId).toBeUndefined();
  });

  it("starts a new paragraph when text resumes after a tool call", () => {
    const s = run([
      { type: "token", text: "Let me check." },
      { type: "tool_call", id: "c1", name: "calculator", args: {}, depth: 0 },
      { type: "token", text: "It is 4." },
    ]);
    expect(s.messages.at(-1)?.text).toBe("Let me check.\n\nIt is 4.");
  });

  it("tracks helpers and marks tool calls done by id", () => {
    let s = run([{ type: "tool_call", id: "k1", name: "ask_coder", args: { task: "x" }, depth: 0 }]);
    expect(s.activeHelpers).toEqual(["coder"]);
    s = run([{ type: "tool_call", id: "r1", name: "run_command", args: {}, depth: 1 }], s);
    expect(s.ops).toBe(2);
    s = run([{ type: "tool_result", id: "k1", name: "ask_coder", preview: "ok", depth: 0 }], s);
    expect(s.activeHelpers).toEqual([]);
    expect(s.activity.find((a) => a.id === "k1")).toMatchObject({ status: "done", preview: "ok" });
    expect(s.activity.find((a) => a.id === "r1")?.status).toBe("running");
  });

  it("does not duplicate a tool call re-sent after an approval", () => {
    const call: ServerEvent = { type: "tool_call", id: "w1", name: "write_file", args: { path: "a" }, depth: 0 };
    const s = run([call, { ...call, args: { path: "b" } }]);
    expect(s.activity).toHaveLength(1);
    expect(s.activity[0].args).toEqual({ path: "b" });
    expect(s.ops).toBe(1);
  });

  it("handles pauses, answers, errors and thread switches", () => {
    const pause: ServerEvent = { type: "pause", pauses: [{ id: "p", kind: "question", question: "?" }] };
    let s = run([{ type: "state", value: "thinking" }, pause]);
    expect(s.busy).toBe(false);
    expect(s.pauses).toHaveLength(1);
    s = reducer(s, { kind: "answered" });
    expect(s.pauses).toEqual([]);
    expect(s.busy).toBe(true);
    s = run([{ type: "error", message: "boom" }], s);
    expect(s).toMatchObject({ busy: false, error: "boom" });
    s = run([{ type: "thread", id: "t2", history: [{ role: "user", text: "old" }] }], s);
    expect(s.threadId).toBe("t2");
    expect(s.messages.map((m) => m.text)).toEqual(["old"]);
  });

  it("drops pauses when the socket disconnects", () => {
    const s = run([{ type: "pause", pauses: [{ id: "p", kind: "other", text: "?" }] }]);
    expect(reducer(s, { kind: "disconnected" })).toMatchObject({ connected: false, pauses: [] });
  });
});

describe("activity nesting", () => {
  const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("nests each helper's steps under its own delegation, oldest first", async () => {
    let s = run([
      { type: "tool_call", id: "d1", name: "ask_coder", args: { task: "deploy" }, depth: 0 },
      { type: "tool_call", id: "d2", name: "ask_files", args: { task: "notes" }, depth: 0 },
    ]);
    await tick(2);
    s = run([{ type: "tool_call", id: "r1", name: "run_command", args: {}, depth: 1, parent: "d1" }], s);
    await tick(2);
    s = run([{ type: "tool_call", id: "f1", name: "read_file", args: {}, depth: 1, parent: "d2" }], s);
    await tick(2);
    s = run([{ type: "tool_call", id: "w1", name: "write_file", args: {}, depth: 1, parent: "d1" }], s);
    const groups = nestActivity(s.activity);
    expect(groups.map((g) => g.item.id)).toEqual(["d2", "d1"]); // newest first, as before
    expect(groups[1].children.map((c) => c.id)).toEqual(["r1", "w1"]); // chronological
    expect(groups[0].children.map((c) => c.id)).toEqual(["f1"]);
  });

  it("falls back to the running delegation when the server sends no parent", () => {
    const s = run([
      { type: "tool_call", id: "d1", name: "ask_coder", args: {}, depth: 0 },
      { type: "tool_call", id: "r1", name: "run_command", args: {}, depth: 1 },
    ]);
    expect(s.activity.find((a) => a.id === "r1")?.parent).toBe("d1");
  });

  it("shows a step on its own once its delegation has scrolled out", () => {
    const groups = nestActivity([
      { id: "r1", name: "run_command", args: {}, depth: 1, status: "running", at: 1, parent: "gone" },
    ]);
    expect(groups).toEqual([{ item: expect.objectContaining({ id: "r1" }), children: [] }]);
  });
});

describe("stop and context", () => {
  it("logs Interrupted when a running task is cancelled", () => {
    let s = reducer(initialState, { kind: "user", text: "deploy" });
    s = run([{ type: "tool_call", id: "d1", name: "ask_coder", args: {}, depth: 0 }], s);
    s = run([{ type: "cancelled", tools: ["ask_coder"] }], s);
    expect(s.busy).toBe(false);
    expect(s.activeHelpers).toEqual([]);
    expect(s.activity[0]).toMatchObject({ name: "interrupted", status: "interrupted" });
    expect(s.activity.find((a) => a.id === "d1")).toMatchObject({ status: "done", preview: "cancelled" });
  });

  it("logs nothing when there was nothing to stop", () => {
    expect(run([{ type: "cancelled", tools: [] }]).activity).toEqual([]);
  });

  it("keeps the latest context reading", () => {
    const s = run([
      { type: "context", used: 100, max: 12000 },
      { type: "context", used: 9000, max: 12000 },
    ]);
    expect(s.context).toEqual({ used: 9000, max: 12000 });
  });
});

describe("helperOf", () => {
  it("maps delegate tools to helper names", () => {
    expect(helperOf("ask_researcher")).toBe("researcher");
    expect(helperOf("ask_user")).toBeNull();
    expect(helperOf("calculator")).toBeNull();
  });
});

describe("long-term memory", () => {
  const memory = { id: 1, text: "Prefers tea", kind: "preference" as const, pinned: false, created_at: "t", updated_at: "t" };
  const suggestion = {
    id: 4, action: "add" as const, target_id: null, target_text: null, text: "Has a dog",
    kind: "person" as const, reason: "", thread_id: "default", created_at: "t",
  };

  it("lists memories and suggestions and keeps the inbox count", () => {
    let s = run([{ type: "memory_inbox", count: 2 }]);
    expect(s.inbox).toBe(2);
    s = run([{ type: "memories", items: [memory], suggestions: [suggestion] }], s);
    expect(s.memories).toEqual([memory]);
    expect(s.inbox).toBe(1);
  });

  it("a memory error doesn't end a running task, and the next list clears it", () => {
    const busy = reducer(initialState, { kind: "user", text: "hi" });
    let s = run([{ type: "memory_error", message: "No memory m9." }], busy);
    expect(s.busy).toBe(true);
    expect(s.memoryError).toBe("No memory m9.");
    s = run([{ type: "memories", items: [], suggestions: [] }], s);
    expect(s.memoryError).toBeUndefined();
  });

  it("shows history until the list changes", () => {
    let s = run([{ type: "memory_history", id: 1, entries: [] }]);
    expect(s.memoryHistory?.id).toBe(1);
    s = run([{ type: "memories", items: [memory], suggestions: [] }], s);
    expect(s.memoryHistory).toBeUndefined();
  });
});

describe("sessions", () => {
  it("stores the saved session list", () => {
    const item = { id: "s1", title: "plan my trip", updated_at: "2026-10-18T12:00:00+00:00", turns: 2 };
    const s = run([{ type: "sessions", items: [item] }]);
    expect(s.sessions).toEqual([item]);
  });
});
