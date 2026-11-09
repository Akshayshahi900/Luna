// Agent core: scratchpad, subagents, task budget, loop limits, approval pauses.
// All with the fake model (test/helpers.ts): no LLM calls.
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { Command, MemorySaver } from "@langchain/langgraph";
import { createAgent, summarizationMiddleware } from "langchain";
import { describe, expect, test } from "vitest";
import * as z from "zod";

import { TaskBudget, taskBudgetMiddleware } from "../src/agent/budget.ts";
import { buildMiddleware, recursionLimit, summaryKeepTokens } from "../src/agent/builder.ts";
import { runTask } from "../src/agent/runner.ts";
import { mergeNotes, renderScratchpad, scratchpadMiddleware } from "../src/agent/scratchpad.ts";
import { makeDelegateTool, type SubagentSpec, subagentSpec } from "../src/agent/subagents/index.ts";
import type { Interrupt, LunaAgent } from "../src/agent/types.ts";
import { loadSettings, type Settings } from "../src/config/settings.ts";
import { askUser, calculator } from "../src/tools/builtin/index.ts";
import type { AnyTool } from "../src/tools/registry.ts";
import { type FakeToolModel, fakeModel, loopingModel, toolCall } from "./helpers.ts";

const cfg = (thread = "t") => ({ configurable: { thread_id: thread }, recursionLimit: 500 });
const user = (content: string) => ({ messages: [{ role: "user", content }] });
const texts = (messages: BaseMessage[]) => messages.map((m) => [m.type, m.text]);
const settings = (overrides: Partial<Settings> = {}) =>
  loadSettings({ envFile: null, env: {}, overrides: { openrouter_api_key: "test", summary_trigger_tokens: 0, ...overrides } });

function agentOf(model: FakeToolModel, tools: unknown[], extra: Record<string, unknown> = {}): LunaAgent {
  return createAgent({ model: model as never, tools: tools as never, ...extra } as never) as unknown as LunaAgent;
}

const helper = (model: FakeToolModel | null, overrides: Partial<SubagentSpec> = {}) =>
  subagentSpec({
    name: "ask_helper",
    description: "Hand a maths task to the helper.",
    systemPrompt: "You are a helper.",
    tools: [calculator as unknown as AnyTool],
    model: model as never,
    ...overrides,
  });

describe("scratchpad", () => {
  test("mergeNotes adds, updates and deletes", () => {
    let notes = mergeNotes(null, { a: "1", b: "2" });
    notes = mergeNotes(notes, { a: "one", b: null, c: "" });
    expect(notes).toEqual({ a: "one" });
  });

  test("render includes todos and notes", () => {
    const text = renderScratchpad({ todos: [{ content: "find flights", status: "in_progress" }], notes: { budget: "under $500" } });
    expect(text).toContain("[in_progress] find flights");
    expect(text).toContain("budget: under $500");
    expect(renderScratchpad({})).toBe("");
  });

  test("notes are shown to the model", async () => {
    const model = fakeModel(toolCall("write_note", "c1", { key: "city", content: "Paris" }), "noted");
    const agent = agentOf(model, [], { checkpointer: new MemorySaver(), middleware: [scratchpadMiddleware()] });
    await agent.invoke(user("I live in Paris"), cfg());
    expect((await agent.getState(cfg())).values.notes).toEqual({ city: "Paris" });
    expect(model.systemPrompts[0]).not.toContain("city: Paris"); // not written yet
    expect(model.systemPrompts[1]).toContain("city: Paris");
  });

  test("parallel notes in one step are both kept", async () => {
    const both = new AIMessage({
      content: "",
      tool_calls: [
        { name: "write_note", args: { key: "a", content: "1" }, id: "n1", type: "tool_call" },
        { name: "write_note", args: { key: "b", content: "2" }, id: "n2", type: "tool_call" },
      ],
    });
    const agent = agentOf(fakeModel(both, "ok"), [], { checkpointer: new MemorySaver(), middleware: [scratchpadMiddleware()] });
    await agent.invoke(user("x"), cfg());
    expect((await agent.getState(cfg())).values.notes).toEqual({ a: "1", b: "2" });
  });

  test("notes survive summarization", async () => {
    const model = fakeModel(toolCall("write_note", "c1", { key: "order_id", content: "A-42" }), "saved", "still know A-42");
    const summarizer = fakeModel("SUMMARY OF EARLIER CHAT");
    const agent = agentOf(model, [], {
      checkpointer: new MemorySaver(),
      middleware: [scratchpadMiddleware(), summarizationMiddleware({ model: summarizer as never, trigger: { messages: 4 }, keep: { messages: 1 } })],
    });
    await agent.invoke(user("order A-42"), cfg());
    await agent.invoke(user("what was it?"), cfg());
    const messages = (await agent.getState(cfg())).values.messages as BaseMessage[];
    expect(summarizer.received).toHaveLength(1); // summarization happened
    expect(messages.some((m) => m.text === "order A-42")).toBe(false); // old message gone
    expect(model.systemPrompts.at(-1)).toContain("order_id: A-42"); // note still shown
  });
});

describe("subagents", () => {
  test("delegate returns its answer and keeps the main history clean", async () => {
    const helperModel = fakeModel(toolCall("calculator", "c1", { expression: "2+2" }), "helper says 4");
    const delegate = makeDelegateTool(helper(helperModel), null);
    const main = fakeModel(toolCall("ask_helper", "c1", { task: "what is 2+2?" }), "It is 4.");
    const result = await agentOf(main, [delegate], { checkpointer: new MemorySaver() }).invoke(user("2+2?"), cfg());
    expect(texts(result.messages)).toEqual([["human", "2+2?"], ["ai", ""], ["tool", "helper says 4"], ["ai", "It is 4."]]);
  });

  test("each delegation starts with a fresh context", async () => {
    const helperModel = fakeModel("first", "second");
    const delegate = makeDelegateTool(helper(helperModel), null);
    expect(await delegate.invoke({ task: "one" })).toBe("first");
    expect(await delegate.invoke({ task: "two" })).toBe("second");
    expect(helperModel.received).toEqual([2, 2]); // [system prompt, task] — nothing carried over
  });

  test("falls back to the main model", async () => {
    const delegate = makeDelegateTool(helper(null), fakeModel("from main model") as never);
    expect(await delegate.invoke({ task: "x" })).toBe("from main model");
  });

  test("subagent limit returns a marked partial result", async () => {
    const delegate = makeDelegateTool(helper(loopingModel(), { maxModelCalls: 2 }), null);
    expect(await delegate.invoke({ task: "loop" })).toMatch(/^\[ask_helper stopped at its limit of 2 steps\]/);
  });

  test("subagent timeout", async () => {
    const slow = tool(async () => {
      await new Promise((r) => setTimeout(r, 5000));
      return "done";
    }, { name: "slow", description: "Takes a while.", schema: z.object({}) });
    const spec = helper(loopingModel("slow"), { tools: [slow as unknown as AnyTool], timeoutSeconds: 0.1 });
    expect(await makeDelegateTool(spec, null).invoke({ task: "x" })).toBe("[ask_helper stopped: timed out after 0.1s]");
  });

  test("subagents cannot nest", () => {
    const inner = makeDelegateTool(helper(fakeModel()), null);
    expect(() => makeDelegateTool(subagentSpec({ name: "outer", description: "d", systemPrompt: "p", tools: [inner] }), null)).toThrow(
      /may not use other subagents/,
    );
  });

  test("fresh context inside a checkpointed main agent", async () => {
    const helperModel = fakeModel("r1", "r2", "r3");
    const delegate = makeDelegateTool(helper(helperModel, { tools: [] }), null);
    const main = fakeModel(
      toolCall("ask_helper", "o1", { task: "a" }), toolCall("ask_helper", "o2", { task: "b" }), "done",
      toolCall("ask_helper", "o3", { task: "c" }), "done again",
    );
    const agent = agentOf(main, [delegate], { checkpointer: new MemorySaver() });
    await agent.invoke(user("one"), cfg());
    await agent.invoke(user("two"), cfg());
    expect(helperModel.received).toEqual([2, 2, 2]);
  });

  test("context is passed to the subagent", async () => {
    const helperModel = fakeModel("ok");
    await makeDelegateTool(helper(helperModel, { tools: [] }), null).invoke({ task: "book a table", context: "user is vegetarian" });
    const taskMessage = helperModel.inputs[0].at(-1)!;
    expect(taskMessage).toContain("book a table");
    expect(taskMessage).toContain("user is vegetarian");
  });
});

describe("task budget", () => {
  test("is shared by the main agent and subagents", async () => {
    const helperModel = loopingModel();
    const delegate = makeDelegateTool(helper(helperModel, { maxModelCalls: 100 }), null);
    const main = loopingModel("ask_helper", { task: "go" });
    const agent = agentOf(main, [delegate], { checkpointer: new MemorySaver(), middleware: [taskBudgetMiddleware()] });
    const budget = new TaskBudget(5);
    await runTask(agent, user("hi"), cfg(), { budget });
    expect(main.received.length + helperModel.received.length).toBe(5);
    expect(budget.used).toBe(5);
    expect(budget.remaining).toBe(0);
  });

  test("an exhausted budget ends with a message", async () => {
    const agent = agentOf(loopingModel(), [], { checkpointer: new MemorySaver(), middleware: [taskBudgetMiddleware()] });
    await runTask(agent, user("hi"), cfg(), { budget: new TaskBudget(0) });
    const messages = (await agent.getState(cfg())).values.messages as BaseMessage[];
    expect(messages.at(-1)!.text).toMatch(/^Task budget exhausted/);
  });

  test("no active budget means no limit", async () => {
    const agent = agentOf(fakeModel("a"), [], { middleware: [taskBudgetMiddleware()] });
    const result = await agent.invoke(user("hi"));
    expect(result.messages.at(-1).text).toBe("a");
  });
});

describe("loop limits", () => {
  const limited = (model: FakeToolModel, s: Settings) =>
    agentOf(model, [calculator], { checkpointer: new MemorySaver(), middleware: buildMiddleware(s, model as never) });
  const run = (agent: LunaAgent, s: Settings) => agent.invoke(user("loop"), { configurable: { thread_id: "t" }, recursionLimit: recursionLimit(s) });

  test("the model call limit ends cleanly", async () => {
    const s = settings({ max_model_calls: 3 });
    const model = loopingModel();
    const result = await run(limited(model, s), s);
    expect(model.received).toHaveLength(3);
    expect(result.messages.at(-1).text).toMatch(/^Model call limits exceeded/);
  });

  test("the tool call limit refuses extra calls", async () => {
    const s = settings({ max_model_calls: 6, max_tool_calls: 2 });
    const result = await run(limited(loopingModel(), s), s);
    const ran = (result.messages as BaseMessage[]).filter((m) => m.type === "tool" && m.text === "4");
    expect(ran).toHaveLength(2);
  });

  test("the limit is per message, not per thread", async () => {
    const s = settings({ max_model_calls: 2 });
    const model = loopingModel();
    const agent = limited(model, s);
    await run(agent, s);
    await run(agent, s);
    expect(model.received).toHaveLength(4);
  });

  test("summary keeps tokens below the trigger", () => {
    expect(summaryKeepTokens(settings({ summary_trigger_tokens: 12000 }))).toBe(4000);
    expect(summaryKeepTokens(settings({ summary_trigger_tokens: 6000 }))).toBe(3000);
    const names = buildMiddleware(settings({ summary_trigger_tokens: 12000 }), fakeModel("ok") as never).map((m) => m.name);
    expect(names).toContain("SummarizationMiddleware");
  });
});

describe("approval pauses (HITL)", () => {
  function filesSetup(p = "notes.md") {
    const written: [string, string][] = [];
    const writeFile = tool(async ({ path, content }) => {
      written.push([path, content]);
      return `wrote ${path}`;
    }, { name: "write_file", description: "Write a file.", schema: z.object({ path: z.string(), content: z.string() }) });
    const helperModel = fakeModel(toolCall("write_file", "w1", { path: p, content: "hello" }), "files done");
    const delegate = makeDelegateTool(
      subagentSpec({ name: "ask_files", description: "Files.", systemPrompt: "p", tools: [writeFile as unknown as AnyTool], model: helperModel as never, interruptOn: { write_file: true } }),
      null,
    );
    const agent = agentOf(fakeModel(toolCall("ask_files", "c1", { task: "save notes" }), "all done"), [delegate], { checkpointer: new MemorySaver() });
    return { agent, written };
  }

  const resume = (pauses: Interrupt[], answer: unknown) => new Command({ resume: Object.fromEntries(pauses.map((p) => [p.id!, answer])) });

  test("nothing runs before approval; approve runs it", async () => {
    const { agent, written } = filesSetup();
    const budget = new TaskBudget(50);
    const pauses = await runTask(agent, user("save"), cfg(), { budget });
    expect(written).toEqual([]);
    expect(pauses).toHaveLength(1);
    expect((pauses[0].value as any).actionRequests[0].name).toBe("write_file");
    expect(await runTask(agent, resume(pauses, { decisions: [{ type: "approve" }] }), cfg(), { budget })).toEqual([]);
    expect(written).toEqual([["notes.md", "hello"]]);
  });

  test("reject skips the action and the helper carries on", async () => {
    const { agent, written } = filesSetup();
    const pauses = await runTask(agent, user("save"), cfg());
    await runTask(agent, resume(pauses, { decisions: [{ type: "reject", message: "not now" }] }), cfg());
    expect(written).toEqual([]);
    const tools = ((await agent.getState(cfg())).values.messages as BaseMessage[]).filter((m) => m.type === "tool").map((m) => m.text);
    expect(tools).toEqual(["files done"]);
  });

  test("edit runs the edited arguments", async () => {
    const { agent, written } = filesSetup();
    const pauses = await runTask(agent, user("save"), cfg());
    const edited = { type: "edit", editedAction: { name: "write_file", args: { path: "other.md", content: "edited" } } };
    await runTask(agent, resume(pauses, { decisions: [edited] }), cfg());
    expect(written).toEqual([["other.md", "edited"]]);
  });

  test("ask_user returns the answer", async () => {
    const agent = agentOf(fakeModel(toolCall("ask_user", "c1", { question: "Favourite colour?" }), "Blue it is"), [askUser], { checkpointer: new MemorySaver() });
    const pauses = await runTask(agent, user("pick a colour"), cfg());
    expect((pauses[0].value as any).question).toBe("Favourite colour?");
    await runTask(agent, resume(pauses, "blue"), cfg());
    const messages = (await agent.getState(cfg())).values.messages as BaseMessage[];
    expect(messages.filter((m) => m.type === "tool").map((m) => m.text)).toEqual(["blue"]);
    expect(messages.at(-1)!.text).toBe("Blue it is");
  });

  test("parallel pauses all resume", async () => {
    const written: string[] = [];
    const writeFile = tool(async ({ path }) => {
      written.push(path);
      return `wrote ${path}`;
    }, { name: "write_file", description: "Write a file.", schema: z.object({ path: z.string() }) });
    const delegate = (name: string, p: string) =>
      makeDelegateTool(
        subagentSpec({
          name, description: "d", systemPrompt: "p", tools: [writeFile as unknown as AnyTool],
          model: fakeModel(toolCall("write_file", `w-${name}`, { path: p }), `${name} done`) as never,
          interruptOn: { write_file: true },
        }),
        null,
      );
    const both = new AIMessage({
      content: "",
      tool_calls: [
        { name: "ask_a", args: { task: "x" }, id: "o1", type: "tool_call" },
        { name: "ask_b", args: { task: "y" }, id: "o2", type: "tool_call" },
      ],
    });
    const agent = agentOf(fakeModel(both, "done"), [delegate("ask_a", "a.txt"), delegate("ask_b", "b.txt")], { checkpointer: new MemorySaver() });
    let pauses = await runTask(agent, user("go"), cfg());
    expect(pauses).toHaveLength(2);
    pauses = await runTask(agent, resume(pauses, { decisions: [{ type: "approve" }] }), cfg());
    expect(pauses).toEqual([]);
    expect(written.sort()).toEqual(["a.txt", "b.txt"]);
  });

  test("the budget carries over across a resume", async () => {
    const agent = agentOf(fakeModel(toolCall("ask_user", "c1", { question: "?" }), "ok"), [askUser], {
      checkpointer: new MemorySaver(), middleware: [taskBudgetMiddleware()],
    });
    const budget = new TaskBudget(10);
    const pauses = await runTask(agent, user("hi"), cfg(), { budget });
    expect(budget.used).toBe(1);
    await runTask(agent, resume(pauses, "yes"), cfg(), { budget });
    expect(budget.used).toBe(2);
  });
});
