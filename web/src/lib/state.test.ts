import { describe, expect, it } from "vitest";
import type { ServerEvent } from "./protocol";
import { helperOf, initialState, type LunaState, reducer } from "./state";

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

describe("helperOf", () => {
  it("maps delegate tools to helper names", () => {
    expect(helperOf("ask_researcher")).toBe("researcher");
    expect(helperOf("ask_user")).toBeNull();
    expect(helperOf("calculator")).toBeNull();
  });
});
