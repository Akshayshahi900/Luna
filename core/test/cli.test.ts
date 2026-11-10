import { AIMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { MemorySaver } from "@langchain/langgraph";
import { createAgent, humanInTheLoopMiddleware } from "langchain";
import { afterEach, beforeEach, expect, test } from "vitest";
import * as z from "zod";

import { buildMiddleware, recursionLimit } from "../src/agent/builder.ts";
import { LongTermStore } from "../src/agent/longterm.ts";
import { makeDelegateTool, subagentSpec } from "../src/agent/subagents/index.ts";
import { coderSpec } from "../src/agent/subagents/coder.ts";
import { filesSpec } from "../src/agent/subagents/files.ts";
import type { LunaAgent } from "../src/agent/types.ts";
import { answerInterrupt, io, memoryCommand, runTurn, sessionCommand, streamReply } from "../src/cli/chat.ts";
import { loadSettings, type Settings } from "../src/config/settings.ts";
import { askUser, calculator } from "../src/tools/builtin/index.ts";
import type { AnyTool } from "../src/tools/registry.ts";
import { type FakeToolModel, fakeModel, loopingModel, tmpDir, toolCall } from "./helpers.ts";

let out = "";
const real = { ...io };
beforeEach(() => {
  out = "";
  io.write = (t) => void (out += t);
});
afterEach(() => Object.assign(io, real));
const take = () => {
  const text = out;
  out = "";
  return text;
};

const settings = (overrides: Partial<Settings> = {}) =>
  loadSettings({ envFile: null, env: {}, overrides: { openrouter_api_key: "test", task_budget: 50, summary_trigger_tokens: 0, ...overrides } });
const agentOf = (model: FakeToolModel, tools: unknown[] = [], extra: Record<string, unknown> = {}) =>
  createAgent({ model: model as never, tools: tools as never, checkpointer: new MemorySaver(), ...extra } as never) as unknown as LunaAgent;
const scripted = (...answers: string[]) => () => {
  if (!answers.length) throw new Error("no more answers");
  return answers.shift()!;
};

test("streamReply shows tool calls and text", async () => {
  const agent = agentOf(fakeModel(toolCall("calculator", "c1", { expression: "6*7" }), "The answer is 42"), [calculator]);
  await streamReply(agent, "what is 6*7?", "t");
  expect(out).toContain('→ calculator({"expression": "6*7"})');
  expect(out).toContain("← 42");
  expect(out).toContain("Luna: The answer is 42");
});

test("the CLI shows the limit notice", async () => {
  const s = settings({ max_model_calls: 2 });
  const model = loopingModel();
  const agent = agentOf(model, [calculator], { middleware: buildMiddleware(s, model as never) });
  await streamReply(agent, "loop", "t", recursionLimit(s));
  expect(out).toContain("⚠ Model call limits exceeded");
});

test("the CLI indents subagent steps", async () => {
  const helper = fakeModel(toolCall("calculator", "c1", { expression: "2+2" }), "helper says 4");
  const delegate = makeDelegateTool(subagentSpec({ name: "ask_helper", description: "d", systemPrompt: "p", tools: [calculator as unknown as AnyTool], model: helper as never }), null);
  await streamReply(agentOf(fakeModel(toolCall("ask_helper", "c1", { task: "2+2" }), "It is 4."), [delegate]), "2+2?", "t");
  const lines = out.split("\n");
  expect(lines).toContain('  → ask_helper({"task": "2+2"})');
  expect(lines).toContain('    → calculator({"expression": "2+2"})');
  expect(lines).toContain("    ← 4");
  expect(lines).toContain("  ← helper says 4");
  expect(lines).toContain("Luna: It is 4.");
});

test("/memory edits, inbox and undo", () => {
  const store = new LongTermStore();
  expect(memoryCommand(store, "")).toBe("(no memories yet)");
  expect(memoryCommand(store, " add preference: tea, not coffee")).toBe("Saved m1.");
  expect(memoryCommand(store, " add Lives in Agra")).toBe("Saved m2.");
  expect(memoryCommand(store, " list")).toContain("(preference) tea, not coffee");
  expect(memoryCommand(store, " search agra")).toContain("Lives in Agra");
  expect(memoryCommand(store, " edit m2 Lives in Delhi")).toBe("Updated m2.");
  expect(memoryCommand(store, " pin 2")).toBe("Pinned m2.");
  expect(memoryCommand(store, " undo 2")).toBe("Undone. m2 is now: Lives in Delhi");
  expect(memoryCommand(store, " rm 2")).toMatch(/^Deleted m2/);
  expect(memoryCommand(store, " undo m2")).toBe("Undone. m2 is now: Lives in Delhi");
  expect(memoryCommand(store, " history 2")).toContain("edit");
  const s = store.suggest({ action: "add", text: "Has a dog named Bruno", kind: "person", reason: "said so" });
  expect(memoryCommand(store, " inbox")).toContain("add (person): Has a dog named Bruno  — said so");
  expect(memoryCommand(store, ` accept s${s.id} Has a beagle`)).toBe(`Accepted s${s.id} → m3: Has a beagle`);
  const s2 = store.suggest({ action: "forget", targetId: 1 });
  expect(memoryCommand(store, ` reject ${s2.id}`)).toBe(`Declined s${s2.id}.`);
  expect(memoryCommand(store, " inbox")).toBe("(inbox empty)");
  expect(memoryCommand(store, " rm 99")).toBe("No memory m99.");
  expect(memoryCommand(store, " rm abc")).toMatch(/^Give a number/);
  expect(memoryCommand(store, " bogus")).toMatch(/^Unknown \/memory command/);
  expect(memoryCommand(null, " list")).toMatch(/^Long-term memory is off/);
});

test("session commands: list, resume, delete", async () => {
  const s = settings();
  const agent = agentOf(fakeModel("Goa it is", "4"));
  await streamReply(agent, "plan my trip to Goa", "s-old");
  await streamReply(agent, "what is 2+2", "s-new");
  take();
  let current = await sessionCommand(agent, "/new", "", "s-new", s);
  expect(["s-old", "s-new"]).not.toContain(current);
  expect(await sessionCommand(agent, "/sessions", "", current, s)).toBe(current);
  let text = take();
  expect(text.indexOf("what is 2+2")).toBeLessThan(text.indexOf("plan my trip to Goa")); // most recent first
  current = await sessionCommand(agent, "/resume", "2", current, s);
  expect(current).toBe("s-old");
  text = take();
  expect(text).toContain("Resumed: plan my trip to Goa");
  expect(text).toContain("Luna: Goa it is");
  // Delete asks first; deleting the open session starts a new one.
  expect(await sessionCommand(agent, "/delete", "1", current, s, () => "n")).toBe(current);
  current = await sessionCommand(agent, "/delete", "s-old", current, s, () => "y");
  expect(current).not.toBe("s-old");
  await sessionCommand(agent, "/sessions", "", current, s);
  text = take();
  expect(text).toContain("Deleted: plan my trip to Goa");
  expect(text.split("New session:").at(-1)).not.toContain("plan my trip");
});

test("resuming a paused session answers the pause first", async () => {
  const agent = agentOf(fakeModel(toolCall("ask_user", "c1", { question: "Which city?" }), "Booked Goa"), [askUser]);
  await streamReply(agent, "book a trip", "paused");
  const current = await sessionCommand(agent, "/resume", "paused", "other", settings(), () => "Goa");
  expect(current).toBe("paused");
  expect(out).toContain("waiting for you");
  expect(out).toContain("Which city?");
  expect(out).toContain("Luna: Booked Goa");
});

// --- approvals at the terminal --------------------------------------------------

function filesSetup() {
  const written: [string, string][] = [];
  const writeFile = tool(async ({ path, content }) => {
    written.push([path, content]);
    return `wrote ${path}`;
  }, { name: "write_file", description: "Write a file.", schema: z.object({ path: z.string(), content: z.string() }) });
  const delegate = makeDelegateTool(
    subagentSpec({
      name: "ask_files", description: "Files.", systemPrompt: "p", tools: [writeFile as unknown as AnyTool],
      model: fakeModel(toolCall("write_file", "w1", { path: "notes.md", content: "hello" }), "files done") as never, interruptOn: { write_file: true },
    }),
    null,
  );
  return { agent: agentOf(fakeModel(toolCall("ask_files", "c1", { task: "save notes" }), "all done"), [delegate]), written };
}

test("approve runs the action", async () => {
  const { agent, written } = filesSetup();
  await runTurn(agent, "save", "t", settings(), scripted("a"));
  expect(written).toEqual([["notes.md", "hello"]]);
});

test("reject skips the action and the helper carries on", async () => {
  const { agent, written } = filesSetup();
  await runTurn(agent, "save", "t", settings(), scripted("r", "not now"));
  expect(written).toEqual([]);
  const state = await agent.getState({ configurable: { thread_id: "t" } });
  expect(state.values.messages.filter((m: { type: string }) => m.type === "tool").map((m: { text: string }) => m.text)).toEqual(["files done"]);
});

test("edit runs the edited arguments", async () => {
  const { agent, written } = filesSetup();
  await runTurn(agent, "save", "t", settings(), scripted("e", JSON.stringify({ path: "other.md", content: "edited" })));
  expect(written).toEqual([["other.md", "edited"]]);
});

test("an invalid choice is asked again", async () => {
  const { agent, written } = filesSetup();
  await runTurn(agent, "save", "t", settings(), scripted("x", "", "a"));
  expect(written).toEqual([["notes.md", "hello"]]);
});

test("parallel pauses all resume", async () => {
  const written: string[] = [];
  const writeFile = tool(async ({ path }) => {
    written.push(path);
    return `wrote ${path}`;
  }, { name: "write_file", description: "Write a file.", schema: z.object({ path: z.string() }) });
  const delegate = (name: string, p: string) =>
    makeDelegateTool(subagentSpec({
      name, description: "d", systemPrompt: "p", tools: [writeFile as unknown as AnyTool],
      model: fakeModel(toolCall("write_file", `w-${name}`, { path: p }), `${name} done`) as never, interruptOn: { write_file: true },
    }), null);
  const both = new AIMessage({ content: "", tool_calls: [
    { name: "ask_a", args: { task: "x" }, id: "o1", type: "tool_call" },
    { name: "ask_b", args: { task: "y" }, id: "o2", type: "tool_call" },
  ] });
  await runTurn(agentOf(fakeModel(both, "done"), [delegate("ask_a", "a.txt"), delegate("ask_b", "b.txt")]), "go", "t", settings(), scripted("a", "a"));
  expect(written.sort()).toEqual(["a.txt", "b.txt"]);
});

test("answerInterrupt formats", async () => {
  expect(await answerInterrupt({ type: "ask_user", question: "Q?" }, scripted("A"))).toBe("A");
  const hitl = {
    actionRequests: [{ name: "run_command", args: { cmd: "ls" } }],
    reviewConfigs: [{ actionName: "run_command", allowedDecisions: ["approve", "reject"] }],
  };
  // "e" isn't allowed for this tool, so it's ignored and asked again.
  expect(await answerInterrupt(hitl, scripted("e", "a"))).toEqual({ decisions: [{ type: "approve" }] });
  expect(await answerInterrupt(hitl, scripted("r", ""))).toEqual({ decisions: [{ type: "reject" }] });
});

// --- the real helpers, end to end ------------------------------------------------

test("the files helper writes only after approval", async () => {
  for (const [answers, expected] of [[["a"], "# Notes"], [["r", ""], null]] as const) {
    const dir = tmpDir();
    const s = settings({ workspace_dirs: [dir] });
    const spec = { ...filesSpec(s), model: fakeModel(toolCall("write_file", "w1", { path: "notes.md", content: "# Notes" }), "Saved notes.md") as never };
    const agent = agentOf(fakeModel(toolCall("ask_files", "c1", { task: "save my notes" }), "Done."), [makeDelegateTool(spec, null)]);
    await runTurn(agent, "save notes", "t", s, scripted(...answers));
    const { existsSync, readFileSync } = await import("node:fs");
    const file = `${dir}/notes.md`;
    expect(existsSync(file) ? readFileSync(file, "utf8") : null).toBe(expected);
  }
});

test("a coder command runs only after approval", async () => {
  const dir = tmpDir();
  const s = settings({ workspace_dirs: [dir] });
  const spec = { ...coderSpec(s), model: fakeModel(toolCall("run_command", "r1", { command: "touch ran.txt" }), "Ran it.") as never };
  const agent = agentOf(fakeModel(toolCall("ask_coder", "c1", { task: "touch a file" }), "Done."), [makeDelegateTool(spec, null)]);
  const { existsSync } = await import("node:fs");
  const asked: string[] = [];
  await runTurn(agent, "go", "t", s, (prompt) => {
    asked.push(prompt);
    expect(existsSync(`${dir}/ran.txt`)).toBe(false); // nothing ran before the answer
    return "a";
  });
  expect(asked.length).toBeGreaterThan(0);
  expect(existsSync(`${dir}/ran.txt`)).toBe(true);
});
