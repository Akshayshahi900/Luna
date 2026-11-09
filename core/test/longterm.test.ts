import path from "node:path";

import { MemorySaver } from "@langchain/langgraph";
import { createAgent } from "langchain";
import { afterEach, beforeEach, expect, test } from "vitest";

import { currentBudget, TaskBudget } from "../src/agent/budget.ts";
import { buildMiddleware } from "../src/agent/builder.ts";
import {
  ftsQuery, longTermMemoryMiddleware, LongTermStore, looksSecret, MemoryRefused, relevantMemories, renderMemories,
} from "../src/agent/longterm.ts";
import type { LunaAgent } from "../src/agent/types.ts";
import { loadSettings } from "../src/config/settings.ts";
import { type FakeToolModel, fakeModel, tmpDir, toolCall } from "./helpers.ts";

let store: LongTermStore;
beforeEach(() => {
  store = new LongTermStore();
});
afterEach(() => store.close());

const agentWith = (model: FakeToolModel, options = {}) =>
  createAgent({ model: model as never, tools: [], checkpointer: new MemorySaver(), middleware: [longTermMemoryMiddleware(store, options)] }) as unknown as LunaAgent;
const ask = (text: string) => ({ messages: [{ role: "user", content: text }] });
const cfg = (thread = "t") => ({ configurable: { thread_id: thread } });

// --- store: the user's side --------------------------------------------------------

test("add, edit, pin, delete and list order", () => {
  const tea = store.add("Prefers tea over coffee", "preference");
  const sis = store.add("Sister is called Asha", "person");
  store.edit(sis.id, { pinned: true });
  expect(store.list().map((m) => m.id)).toEqual([sis.id, tea.id]); // pinned first
  store.edit(tea.id, { text: "Prefers green tea" });
  expect(store.get(tea.id).text).toBe("Prefers green tea");
  store.delete(tea.id);
  expect(store.list().map((m) => m.id)).toEqual([sis.id]);
  expect(() => store.get(tea.id)).toThrow(MemoryRefused);
});

test("stats count kinds, pins, deletes and the inbox", () => {
  const a = store.add("Likes tea", "preference", true);
  store.add("Lives in Agra");
  const gone = store.add("Old fact");
  store.delete(gone.id);
  store.suggest({ action: "add", text: "Has a cat", kind: "fact" });
  const stats = store.stats();
  expect(stats.total).toBe(2);
  expect(stats.by_kind).toEqual({ fact: 1, preference: 1, person: 0, project: 0 });
  expect([stats.pinned, stats.deleted, stats.pending]).toEqual([1, 1, 1]);
  expect(stats.changes).toBeGreaterThanOrEqual(4);
  expect(a.pinned).toBe(true);
});

test("add validates text and kind", () => {
  expect(() => store.add("   ")).toThrow(MemoryRefused);
  expect(() => store.add("x".repeat(301))).toThrow(MemoryRefused);
  expect(() => store.add("Likes jazz", "mood")).toThrow(MemoryRefused);
});

test("history and undo walk back every change", () => {
  const m = store.add("Lives in Agra");
  store.edit(m.id, { text: "Lives in Delhi" });
  store.delete(m.id);
  expect(store.history(m.id).map((h) => h.action)).toEqual(["delete", "edit", "add"]);
  expect(store.undo(m.id)?.text).toBe("Lives in Delhi"); // back from the delete
  expect(store.undo(m.id)?.text).toBe("Lives in Agra"); // back from the edit
  expect(store.undo(m.id)).toBeNull(); // undoing the add hides it
  expect(store.list()).toEqual([]);
  expect(() => store.undo(m.id)).toThrow(MemoryRefused); // nothing left
  expect(store.history(m.id).every((h) => h.undone)).toBe(true);
});

test("search uses keywords and skips deleted", () => {
  const tea = store.add("Prefers tea over coffee", "preference");
  const robots = store.add("Works on a robotics project", "project");
  const gone = store.add("Drinks coffee at night");
  store.delete(gone.id);
  expect(store.search("Do I like coffee?").map((m) => m.id)).toEqual([tea.id]);
  expect(store.search("any robot news").map((m) => m.id)).toEqual([robots.id]); // prefix match
  expect(store.search("the and of")).toEqual([]); // only stopwords
  expect(store.search('"); DROP TABLE memories; --')).toEqual([]); // safe, no error
});

test("ftsQuery quotes every word", () => {
  expect(ftsQuery('what\'s my "coffee" OR tea*?')).toBe('"coffee"* OR "tea"');
  expect(ftsQuery("")).toBe("");
});

test("the store survives reopening", () => {
  const file = path.join(tmpDir(), "lt.sqlite");
  const first = new LongTermStore(file);
  first.add("Allergic to peanuts");
  first.close();
  const second = new LongTermStore(file);
  expect(second.list().map((m) => m.text)).toEqual(["Allergic to peanuts"]);
  expect(second.search("peanuts")).not.toEqual([]);
  second.close();
});

// --- suggestions: the agent's side --------------------------------------------------

test("accept add, update and forget", () => {
  const s = store.suggest({ action: "add", text: "Has a dog named Bruno", kind: "person", reason: "mentioned it" });
  expect(store.pendingCount()).toBe(1);
  const m = store.accept(s.id)!;
  expect([m.text, m.kind]).toEqual(["Has a dog named Bruno", "person"]);
  expect(store.history(m.id)[0].source).toBe(`suggestion s${s.id}`);

  const up = store.suggest({ action: "update", text: "Has a dog named Max", targetId: m.id });
  expect(up.target_text).toBe("Has a dog named Bruno");
  store.accept(up.id, "Has a beagle named Max"); // the user's own words win
  expect(store.get(m.id).text).toBe("Has a beagle named Max");

  const bye = store.suggest({ action: "forget", targetId: m.id });
  expect(store.accept(bye.id)).toBeNull();
  expect(store.list()).toEqual([]);
  expect(store.undo(m.id)?.text).toBe("Has a beagle named Max"); // even accepted changes undo
  expect(store.pendingCount()).toBe(0);
});

test("suggestion guards", () => {
  const m = store.add("Prefers tea over coffee");
  expect(() => store.suggest({ action: "add", text: "prefers tea over coffee." })).toThrow(/Already in/);
  expect(() => store.suggest({ action: "add", text: "My bank password is hunter2" })).toThrow(/private/);
  expect(() => store.suggest({ action: "add", text: "Card 4111 1111 1111 1111" })).toThrow(/private/);
  expect(() => store.suggest({ action: "add", text: "x".repeat(400) })).toThrow(MemoryRefused);
  expect(() => store.suggest({ action: "update", text: "whatever", targetId: 999 })).toThrow(/No memory/);
  expect(() => store.suggest({ action: "update", text: "Prefers tea over coffee", targetId: m.id })).toThrow(/already says/);
  const s = store.suggest({ action: "add", text: "Likes jazz" });
  expect(() => store.suggest({ action: "add", text: "likes jazz" })).toThrow(/waiting/);
  store.reject(s.id);
  expect(() => store.suggest({ action: "add", text: "Likes jazz" })).toThrow(/declined/);
  expect(() => store.accept(s.id)).toThrow(MemoryRefused); // no longer pending
});

// --- prompt -------------------------------------------------------------------------

test("pinned first, then matches, within the cap", () => {
  const pin = store.add("Name is Akshay", "fact", true);
  const tea = store.add("Prefers tea over coffee");
  store.add("Works on a robotics project");
  const chosen = relevantMemories(store, "coffee please", 5);
  expect(chosen.map((m) => m.id)).toEqual([pin.id, tea.id]);
  expect(renderMemories(chosen, 1000)).toContain(`[m${pin.id}] (fact) Name is Akshay`);
  expect(renderMemories(chosen, 40).split("\n")).toHaveLength(1); // second line cut
});

test("memories reach the model and edits apply on the next call", async () => {
  const m = store.add("Prefers tea over coffee", "preference");
  const model = fakeModel("Tea, Sir.", "Green tea, Sir.");
  const agent = agentWith(model);
  await agent.invoke(ask("what do I drink, coffee?"), cfg());
  expect(model.systemPrompts[0]).toContain("Prefers tea over coffee");
  store.edit(m.id, { text: "Prefers green tea over coffee" }); // edited in the panel
  await agent.invoke(ask("and now, coffee?"), cfg());
  expect(model.systemPrompts[1]).toContain("Prefers green tea over coffee");
  expect(model.systemPrompts[1]).not.toContain("Prefers tea over coffee");
});

test("agent tools only suggest, never change memories", async () => {
  const m = store.add("Lives in Agra");
  const before = store.list();
  const model = fakeModel(
    toolCall("remember", "c1", { text: "Has a cat named Miso", kind: "person" }),
    toolCall("suggest_update", "c2", { memory_id: m.id, text: "Lives in Delhi", reason: "moved" }),
    toolCall("suggest_forget", "c3", { memory_id: m.id }),
    toolCall("recall", "c4", { query: "Agra" }),
    "Noted, Sir.",
  );
  await agentWith(model).invoke(ask("I moved to Delhi and got a cat"), cfg("t1"));
  expect(store.list()).toEqual(before); // untouched until the user accepts
  const pending = store.suggestions();
  expect(pending.map((s) => s.action)).toEqual(["add", "update", "forget"]);
  expect(pending.every((s) => s.thread_id === "t1")).toBe(true);
  expect(model.inputs.at(-1)!.some((t) => t.includes("Lives in Agra"))).toBe(true); // recall result
});

test("suggestions per message are capped", async () => {
  const model = fakeModel(
    toolCall("remember", "c1", { text: "Fact one" }),
    toolCall("remember", "c2", { text: "Fact two" }),
    toolCall("remember", "c3", { text: "Fact three" }),
    "ok",
  );
  await currentBudget.run(new TaskBudget(10), () => agentWith(model, { maxSuggestions: 2 }).invoke(ask("lots of facts"), cfg()));
  expect(store.suggestions().map((s) => s.text)).toEqual(["Fact one", "Fact two"]);
  expect(model.inputs.at(-1)!.some((t) => t.includes("at most 2"))).toBe(true);
});

test("a refused suggestion is explained to the model", async () => {
  const model = fakeModel(toolCall("remember", "c1", { text: "api key: sk-abcdefghijklmnop1234" }), "ok");
  await agentWith(model).invoke(ask("save my key"), cfg());
  expect(store.suggestions()).toEqual([]);
  expect(model.inputs.at(-1)!.some((t) => t.startsWith("Not suggested"))).toBe(true);
});

test("looksSecret", () => {
  expect(looksSecret("the wifi password: abc")).toBe(true);
  expect(looksSecret("ghp_abcdefghijklmnopqrstuvwxyz")).toBe(true);
  expect(looksSecret("Prefers tea over coffee")).toBe(false);
});

test("main agent middleware includes memory only with a store", () => {
  const s = loadSettings({ envFile: null, env: {}, overrides: { openrouter_api_key: "test", summary_trigger_tokens: 0 } });
  const model = fakeModel("x") as never;
  expect(buildMiddleware(s, model).map((m) => m.name)).not.toContain("LongTermMemoryMiddleware");
  expect(buildMiddleware(s, model, {}, store).map((m) => m.name)).toContain("LongTermMemoryMiddleware");
});
