// Web UI backend: event translation, pause answers, origin check, and the
// /ws protocol end to end (fake models, no API key).
import { AIMessage, AIMessageChunk, ToolMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { MemorySaver } from "@langchain/langgraph";
import { createAgent, humanInTheLoopMiddleware } from "langchain";
import { afterEach, describe, expect, test } from "vitest";
import * as z from "zod";

import { longTermMemoryMiddleware, LongTermStore } from "../src/agent/longterm.ts";
import { makeDelegateTool, subagentSpec } from "../src/agent/subagents/index.ts";
import type { LunaAgent } from "../src/agent/types.ts";
import { PARENT_CALL_METADATA } from "../src/agent/subagents/base.ts";
import { loadSettings, type Settings } from "../src/config/settings.ts";
import { askUser, calculator } from "../src/tools/builtin/index.ts";
import type { AnyTool } from "../src/tools/registry.ts";
import { createStt } from "../src/voice/stt.ts";
import { createTts } from "../src/voice/tts.ts";
import { pcmToFloat, pcmToWav, wavToPcm } from "../src/voice/wav.ts";
import { buildAnswer, describePause, EventTranslator, type Pause } from "../src/web/events.ts";
import { originAllowed, type LunaServer } from "../src/web/server.ts";
import { CANCELLED, cancelCleanup, hooks as sessionHooks } from "../src/web/session.ts";
import { type FakeToolModel, fakeModel, tmpDir, toolCall } from "./helpers.ts";
import { connect, serve, SocketClient } from "./ws_client.ts";

const settings = (overrides: Partial<Settings> = {}) =>
  loadSettings({ envFile: null, env: {}, overrides: { openrouter_api_key: "test", task_budget: 50, summary_trigger_tokens: 0, ...overrides } });
const agentOf = (model: FakeToolModel, tools: unknown[] = [], extra: Record<string, unknown> = {}) =>
  createAgent({ model: model as never, tools: tools as never, checkpointer: new MemorySaver(), ...extra } as never) as unknown as LunaAgent;

let running: LunaServer[] = [];
let tabs: SocketClient[] = [];
afterEach(async () => {
  for (const t of tabs) t.close();
  await Promise.all(running.map((s) => s.close()));
  running = [];
  tabs = [];
});
async function start(options: Parameters<typeof serve>[0]) {
  const server = await serve(options);
  running.push(server);
  return server;
}
async function open(server: LunaServer) {
  const c = await connect(server.url);
  tabs.push(c.tab);
  return c;
}

// --- EventTranslator ---------------------------------------------------------

describe("EventTranslator", () => {
  test("tokens come only from the main agent's model", () => {
    const t = new EventTranslator();
    const chunk = new AIMessageChunk({ content: "Hi" });
    expect(t.translate([], "messages", [chunk, { langgraph_node: "model_request" }])).toEqual([{ type: "token", text: "Hi" }]);
    expect(t.translate(["tools:1"], "messages", [chunk, { langgraph_node: "model_request" }])).toEqual([]); // subagent text
    expect(t.translate([], "messages", [chunk, { langgraph_node: "tools" }])).toEqual([]);
  });

  test("updates become tool calls, results and notices", () => {
    const t = new EventTranslator();
    const call = new AIMessage({ content: "", tool_calls: [{ name: "calculator", args: { expression: "1+1" }, id: "c1", type: "tool_call" }] });
    const result = new ToolMessage({ content: "2", tool_call_id: "c1", name: "calculator" });
    const notice = new AIMessage("Model call limits exceeded");
    expect(t.translate(["tools:x"], "updates", { model_request: { messages: [call] } })).toEqual([
      { type: "tool_call", id: "c1", name: "calculator", args: { expression: "1+1" }, depth: 1, parent: null },
    ]);
    expect(t.translate([], "updates", { tools: { messages: [result] } })).toEqual([
      { type: "tool_result", id: "c1", name: "calculator", preview: "2", depth: 0 },
    ]);
    expect(t.translate([], "updates", { limit: { messages: [notice] } })).toEqual([{ type: "notice", text: "Model call limits exceeded", depth: 0 }]);
    expect(t.translate([], "updates", { __interrupt__: [], other: null })).toEqual([]);
  });

  test("messages already seen (middleware echoes, earlier turns) aren't reported twice", () => {
    const t = new EventTranslator();
    const old = new AIMessage({ id: "a1", content: "", tool_calls: [{ name: "calculator", args: {}, id: "c0", type: "tool_call" }] });
    t.prime([old]);
    const call = new AIMessage({ id: "a2", content: "", tool_calls: [{ name: "calculator", args: {}, id: "c1", type: "tool_call" }] });
    expect(t.translate([], "updates", { "Mw.before_model": { messages: [old] } })).toEqual([]);
    expect(t.translate([], "updates", { model_request: { messages: [call] } })).toHaveLength(1);
    expect(t.translate([], "updates", { "Mw.after_model": { messages: [old, call] } })).toEqual([]);
  });

  test("helper events carry their parent call", () => {
    const t = new EventTranslator();
    const call = () => new AIMessage({ content: "", tool_calls: [{ name: "run_command", args: { command: "ls" }, id: "h1", type: "tool_call" }] });
    // Before any metadata the parent is unknown.
    expect(t.translate(["tools:a"], "updates", { model_request: { messages: [call()] } })[0].parent).toBeNull();
    t.translate(["tools:a"], "messages", [new AIMessageChunk({ content: "" }), { [PARENT_CALL_METADATA]: "m1" }]);
    t.translate(["tools:b"], "messages", [new AIMessageChunk({ content: "" }), { [PARENT_CALL_METADATA]: "m2" }]);
    const [event] = t.translate(["tools:a"], "updates", { model_request: { messages: [call()] } });
    expect([event.parent, event.depth]).toEqual(["m1", 1]);
    const result = new ToolMessage({ content: "ok", tool_call_id: "h1", name: "run_command" });
    expect(t.translate(["tools:b"], "updates", { tools: { messages: [result] } })[0].parent).toBe("m2");
    // Main-agent events have no parent field.
    expect(t.translate([], "updates", { model_request: { messages: [call()] } })[0]).not.toHaveProperty("parent");
  });

  test("parallel helpers nest under their own call", async () => {
    const helper = fakeModel(toolCall("calculator", "h1", { expression: "2+2" }), "a done", toolCall("calculator", "h2", { expression: "3+3" }), "b done");
    const delegate = makeDelegateTool(subagentSpec({ name: "ask_coder", description: "Code.", systemPrompt: "p", tools: [calculator as unknown as AnyTool], model: helper as never }), null);
    const main = fakeModel(
      new AIMessage({ content: "", tool_calls: [
        { name: "ask_coder", args: { task: "a" }, id: "m1", type: "tool_call" },
        { name: "ask_coder", args: { task: "b" }, id: "m2", type: "tool_call" },
      ] }),
      "all done",
    );
    const agent = agentOf(main, [delegate]);
    const t = new EventTranslator();
    const events: any[] = [];
    const stream = await agent.stream({ messages: [{ role: "user", content: "go" }] }, { configurable: { thread_id: "t" }, streamMode: ["messages", "updates"], subgraphs: true });
    for await (const [ns, mode, data] of stream) events.push(...t.translate(ns, mode, data));
    const nested = events.filter((e) => ["tool_call", "tool_result"].includes(e.type) && e.depth === 1);
    expect(nested.length).toBeGreaterThan(0);
    expect(nested.every((e) => ["m1", "m2"].includes(e.parent))).toBe(true);
    const parentOf = Object.fromEntries(nested.filter((e) => e.type === "tool_call").map((e) => [e.id, e.parent]));
    expect(nested.filter((e) => e.type === "tool_result").every((e) => parentOf[e.id] === e.parent)).toBe(true);
    // Each helper call and its result reported once.
    expect(nested.filter((e) => e.type === "tool_call")).toHaveLength(2);
  });

  test("long tool results are shortened", () => {
    const long = new ToolMessage({ content: "x ".repeat(500), tool_call_id: "c1", name: "read_file" });
    const [event] = new EventTranslator().translate([], "updates", { tools: { messages: [long] } });
    expect([...event.preview].length).toBeLessThanOrEqual(240);
    expect(event.preview.endsWith("…")).toBe(true);
  });
});

// --- describePause / buildAnswer -------------------------------------------

const approval = () => ({
  id: "p1",
  value: {
    actionRequests: [{ name: "write_file", args: { path: "a.md" }, description: "d" }],
    reviewConfigs: [{ actionName: "write_file", allowedDecisions: ["approve", "reject"] }],
  },
});

describe("pauses", () => {
  test("describePause kinds", () => {
    expect(describePause({ id: "q", value: { type: "ask_user", question: "Which?" } })).toEqual({ id: "q", kind: "question", question: "Which?" });
    const p = describePause(approval());
    expect(p.kind).toBe("approval");
    expect((p as Extract<Pause, { kind: "approval" }>).actions).toEqual([{ name: "write_file", args: { path: "a.md" }, description: "d", allowed: ["approve", "reject"] }]);
    expect(describePause({ id: "o", value: 42 }).kind).toBe("other");
  });

  test("buildAnswer matches the CLI formats", () => {
    const pause = describePause(approval());
    expect(buildAnswer(pause, { decisions: [{ type: "approve" }] })).toEqual({ decisions: [{ type: "approve" }] });
    expect(buildAnswer(pause, { decisions: [{ type: "reject", message: "no" }] })).toEqual({ decisions: [{ type: "reject", message: "no" }] });
    expect(buildAnswer(pause, { decisions: [{ type: "reject", message: " " }] })).toEqual({ decisions: [{ type: "reject" }] });
    const question: Pause = { id: "q", kind: "question", question: "?" };
    expect(buildAnswer(question, { answer: "blue" })).toBe("blue");
    expect(buildAnswer(question, "red")).toBe("red");
  });

  test("buildAnswer: edit, and one decision for many actions", () => {
    const pause: Pause = {
      id: "p",
      kind: "approval",
      actions: [
        { name: "write_file", args: {}, description: null, allowed: ["approve", "edit", "reject"] },
        { name: "edit_file", args: {}, description: null, allowed: ["approve", "edit", "reject"] },
      ],
    };
    expect(buildAnswer(pause, { decisions: [{ type: "approve" }] })).toEqual({ decisions: [{ type: "approve" }, { type: "approve" }] });
    const single: Pause = { ...pause, actions: pause.actions.slice(0, 1) };
    expect(buildAnswer(single, { decisions: [{ type: "edit", args: { path: "b" } }] })).toEqual({
      decisions: [{ type: "edit", editedAction: { name: "write_file", args: { path: "b" } } }],
    });
  });

  test.each([{}, { decisions: [] }, { decisions: [{ type: "edit" }] }, { decisions: [{ type: "approve" }, { type: "approve" }] }])(
    "buildAnswer rejects bad approvals: %j",
    (reply) => expect(() => buildAnswer(describePause(approval()), reply)).toThrow(),
  );
});

// --- origin check --------------------------------------------------------------

test("originAllowed", () => {
  const allowed = ["http://localhost:5173"];
  expect(originAllowed(null, "127.0.0.1:8765", allowed)).toBe(true); // not a browser
  expect(originAllowed("http://127.0.0.1:8765", "127.0.0.1:8765", allowed)).toBe(true); // served by us
  expect(originAllowed("http://localhost:5173/", "127.0.0.1:8765", allowed)).toBe(true); // dev server
  expect(originAllowed("https://evil.example", "127.0.0.1:8765", allowed)).toBe(false);
  expect(settings({ web_allowed_origins: "http://a:1/, http://b:2" as never }).web_allowed_origins).toEqual(["http://a:1", "http://b:2"]);
});

// --- /ws end to end ------------------------------------------------------------

describe("/ws", () => {
  test("streams a reply", async () => {
    const server = await start({ agent: agentOf(fakeModel(toolCall("calculator", "c1", { expression: "6*7" }), "The answer is 42"), [calculator]), settings: settings() });
    const { tab, hello, thread } = await open(server);
    expect(hello.type).toBe("hello");
    expect(hello.tools).toContain("calculator");
    expect([thread.type, thread.history, thread.id.length]).toEqual(["thread", [], 36]); // a new uuid
    tab.send({ type: "message", text: "what is 6*7?" });
    const events = await tab.until("done", "error");
    expect(events[0].type).toBe("state");
    expect(events.at(-1).type).toBe("done");
    expect(events).toContainEqual({ type: "tool_call", id: "c1", name: "calculator", args: { expression: "6*7" }, depth: 0 });
    expect(events.some((e) => e.type === "tool_result" && e.preview === "42")).toBe(true);
    expect(events.filter((e) => e.type === "token").map((e) => e.text).join("")).toBe("The answer is 42");
    expect(events.filter((e) => e.type === "tool_call")).toHaveLength(1); // no echoes
  });

  test("reports context use before done", async () => {
    const server = await start({ agent: agentOf(fakeModel("A fairly short reply.")), settings: settings({ summary_trigger_tokens: 5000 }) });
    const { tab } = await open(server);
    tab.send({ type: "message", text: "hello there" });
    const events = await tab.until("done", "error");
    expect(events.slice(-2).map((e) => e.type)).toEqual(["context", "done"]);
    const context = events.at(-2);
    expect(context.max).toBe(5000);
    expect(context.used).toBeGreaterThan(0);
    expect(context.used).toBeLessThan(5000);
  });

  test("a question pause and resume", async () => {
    const server = await start({ agent: agentOf(fakeModel(toolCall("ask_user", "c1", { question: "Which colour?" }), "Blue it is"), [askUser]), settings: settings() });
    const { tab } = await open(server);
    tab.send({ type: "message", text: "pick a colour" });
    const [p] = (await tab.until("pause")).at(-1).pauses;
    expect([p.kind, p.question]).toEqual(["question", "Which colour?"]);
    // A new message while paused is refused; the pause stays.
    tab.send({ type: "message", text: "hello?" });
    expect((await tab.next()).type).toBe("error");
    tab.send({ type: "resume", answers: { [p.id]: { answer: "blue" } } });
    const events = await tab.until("done", "error");
    expect(events.at(-1).type).toBe("done");
    expect(events.some((e) => e.type === "tool_result" && e.preview === "blue")).toBe(true);
  });

  test("an approval reject skips the action", async () => {
    const written: string[] = [];
    const writeFile = tool(async ({ path }) => {
      written.push(path);
      return "ok";
    }, { name: "write_file", description: "Write a file.", schema: z.object({ path: z.string(), content: z.string() }) });
    const agent = agentOf(fakeModel(toolCall("write_file", "c1", { path: "a.md", content: "x" }), "fine, skipped"), [writeFile], {
      middleware: [humanInTheLoopMiddleware({ interruptOn: { write_file: true } })],
    });
    const server = await start({ agent, settings: settings() });
    const { tab } = await open(server);
    tab.send({ type: "message", text: "save" });
    const [p] = (await tab.until("pause")).at(-1).pauses;
    expect([p.kind, p.actions[0].name]).toEqual(["approval", "write_file"]);
    tab.send({ type: "resume", answers: { [p.id]: { decisions: [{ type: "reject" }] } } });
    expect((await tab.until("done", "error")).at(-1).type).toBe("done");
    expect(written).toEqual([]);
  });

  test("a pause survives a reconnect", async () => {
    const server = await start({ agent: agentOf(fakeModel(toolCall("ask_user", "c1", { question: "Name?" }), "Hi Ada"), [askUser]), settings: settings() });
    let { tab } = await open(server);
    tab.send({ type: "message", text: "greet me" });
    const [p] = (await tab.until("pause")).at(-1).pauses;
    tab.close();

    let thread;
    ({ tab, thread } = await open(server)); // e.g. the page was reloaded
    expect(thread.history).toEqual([]); // a reload opens a new session…
    tab.send({ type: "sessions" });
    const [saved] = (await tab.next()).items;
    tab.send({ type: "thread", id: saved.id }); // …and the old one can be resumed
    expect((await tab.next()).history).toEqual([{ role: "user", text: "greet me" }]);
    expect((await tab.next()).type).toBe("context");
    const [again] = (await tab.next()).pauses;
    expect(again.id).toBe(p.id);
    tab.send({ type: "resume", answers: { [p.id]: "Ada" } });
    expect((await tab.until("done", "error")).at(-1).type).toBe("done");
  });

  test("threads and bad input", async () => {
    const server = await start({ agent: agentOf(fakeModel("hi")), settings: settings() });
    const { tab, thread } = await open(server);
    tab.send("not json");
    expect((await tab.next()).type).toBe("error");
    tab.send({ type: "resume", answers: {} });
    expect((await tab.next()).type).toBe("error"); // nothing paused
    tab.send({ type: "bogus" });
    expect((await tab.next()).type).toBe("error");
    tab.send({ type: "new_thread" });
    const fresh = await tab.next();
    expect([fresh.type, fresh.id !== thread.id, fresh.history]).toEqual(["thread", true, []]);
    const context = await tab.next();
    expect([context.type, context.used]).toEqual(["context", 0]);
    expect(context.max).toBeGreaterThan(0);
    tab.send({ type: "thread", id: "work" });
    expect((await tab.next()).id).toBe("work");
  });

  test("refuses foreign origins", async () => {
    const server = await start({ agent: agentOf(fakeModel("hi")), settings: settings() });
    await expect(SocketClient.open(server.url, { origin: "https://evil.example" })).rejects.toThrow(/403/);
  });

  test("health and the no-build page", async () => {
    const server = await start({ agent: agentOf(fakeModel("hi")), settings: settings(), distDir: tmpDir() }); // no index.html → hint page
    expect(((await (await fetch(`${server.url}/api/health`)).json()) as any).status).toBe("ok");
    expect(await (await fetch(`${server.url}/`)).text()).toContain("pnpm build");
  });

  test("the built frontend is served, with an index.html fallback", async () => {
    const dist = tmpDir();
    const { writeFileSync, mkdirSync } = await import("node:fs");
    writeFileSync(`${dist}/index.html`, "<html>luna app</html>");
    mkdirSync(`${dist}/assets`);
    writeFileSync(`${dist}/assets/app.js`, "console.log(1)");
    const server = await start({ agent: agentOf(fakeModel("hi")), settings: settings(), distDir: dist });
    const js = await fetch(`${server.url}/assets/app.js`);
    expect(js.headers.get("content-type")).toContain("javascript");
    expect(await (await fetch(`${server.url}/some/route`)).text()).toContain("luna app");
    expect((await fetch(`${server.url}/..%2f..%2fetc/passwd`)).status).not.toBe(500);
  });
});

// --- model switching -----------------------------------------------------------

describe("model switching", () => {
  afterEach(() => {
    sessionHooks.listModels = (async () => []) as never;
  });

  test("switches the model for every tab", async () => {
    const built: [string, string][] = [];
    const rebuild = async (provider: string, model: string) => {
      built.push([provider, model]);
      return agentOf(fakeModel("from the new model"));
    };
    const s = settings({ groq_api_key: "gq" });
    const server = await start({ agent: agentOf(fakeModel("old")), settings: s, rebuild });
    const { tab: tab1, hello } = await open(server);
    const { tab: tab2 } = await open(server);
    expect([hello.provider, hello.can_switch]).toEqual(["openrouter", true]);
    expect(new Set(hello.providers.map((p: { id: string }) => p.id))).toEqual(new Set(["openrouter", "groq", "ollama"]));
    tab1.send({ type: "set_model", provider: "groq", model: "" });
    const expected = { type: "model", provider: "groq", model: s.groq_model };
    expect(await tab1.next()).toEqual(expected);
    expect(await tab2.next()).toEqual(expected); // the other tab hears about it too
    expect(built).toEqual([["groq", s.groq_model]]);
    tab2.send({ type: "message", text: "hi" });
    const events = await tab2.until("done", "error");
    expect(events.filter((e) => e.type === "token").map((e) => e.text).join("")).toBe("from the new model");
    expect(((await (await fetch(`${server.url}/api/health`)).json()) as any).provider).toBe("groq");
  });

  test("switch errors and the model list", async () => {
    const rebuild = async () => {
      throw new Error("Set LUNA_GROQ_API_KEY in your .env file to use Groq.");
    };
    sessionHooks.listModels = (async (_s: unknown, provider: string) => {
      if (provider === "ollama") throw new Error("connection refused");
      return ["m1", "m2"];
    }) as never;
    const server = await start({ agent: agentOf(fakeModel("hi")), settings: settings(), rebuild });
    const { tab } = await open(server);
    tab.send({ type: "set_model", provider: "groq", model: "x" });
    expect((await tab.next()).message).toContain("LUNA_GROQ_API_KEY");
    tab.send({ type: "models", provider: "openrouter" });
    expect(await tab.next()).toEqual({ type: "models", provider: "openrouter", models: ["m1", "m2"] });
    tab.send({ type: "models", provider: "ollama" });
    const reply = await tab.next();
    expect(reply.models).toEqual([]);
    expect(reply.error).toContain("refused");
  });

  test("switching needs a rebuild function", async () => {
    const server = await start({ agent: agentOf(fakeModel("hi")), settings: settings() });
    const { tab, hello } = await open(server);
    expect(hello.can_switch).toBe(false);
    tab.send({ type: "set_model", provider: "ollama", model: "m" });
    expect((await tab.next()).type).toBe("error");
  });
});

// --- voice ----------------------------------------------------------------------

class FakeTTS {
  said: string[] = [];
  async synthesize(text: string) {
    this.said.push(text);
    return Buffer.from("RIFF....WAVEfake");
  }
  async warmUp() {}
}

const wav = (seconds = 0.5, rate = 16000, channels = 1) => {
  const frames = Math.floor(seconds * rate) * channels;
  const out = pcmToWav(Buffer.alloc(frames * 2), rate, channels);
  return out;
};

class FakeSTT {
  heard: number[] = [];
  text: string;
  constructor(text = "Hey Luna. What time is it?") {
    this.text = text;
  }
  async transcribe(_pcm: Buffer, samples: number) {
    this.heard.push(samples);
    return this.text;
  }
  async warmUp() {}
}

const post = (url: string, body: string | Uint8Array, headers: Record<string, string> = {}) => fetch(url, { method: "POST", body: body as never, headers });

describe("voice", () => {
  test("/api/tts returns audio", async () => {
    const engine = new FakeTTS();
    const server = await start({ agent: agentOf(fakeModel("hi")), settings: settings(), ttsEngine: engine });
    const { hello } = await open(server);
    expect(hello.tts).toBe("piper");
    const json = { "content-type": "application/json" };
    const response = await post(`${server.url}/api/tts`, JSON.stringify({ text: "Hello there." }), json);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("audio/wav");
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe("RIFF....WAVEfake");
    expect(engine.said).toEqual(["Hello there."]);
    expect((await post(`${server.url}/api/tts`, JSON.stringify({ text: "  " }), json)).status).toBe(400);
    expect((await post(`${server.url}/api/tts`, JSON.stringify({ text: "x".repeat(5000) }), json)).status).toBe(400);
    expect((await post(`${server.url}/api/tts`, "not json")).status).toBe(400);
    expect((await post(`${server.url}/api/tts`, JSON.stringify({ text: "hi" }), { ...json, origin: "https://evil.example" })).status).toBe(403);
  });

  test("tts off means browser speech", async () => {
    const server = await start({ agent: agentOf(fakeModel("hi")), settings: settings() });
    const { hello } = await open(server);
    expect(hello.tts).toBe("browser");
    expect((await post(`${server.url}/api/tts`, JSON.stringify({ text: "hi" }))).status).toBe(404);
  });

  test("tts engine errors become 500", async () => {
    const broken = { async synthesize(): Promise<Buffer> { throw new Error("voice model missing"); }, async warmUp() {} };
    const server = await start({ agent: agentOf(fakeModel("hi")), settings: settings(), ttsEngine: broken });
    const response = await post(`${server.url}/api/tts`, JSON.stringify({ text: "hi" }));
    expect(response.status).toBe(500);
    expect(((await response.json()) as any).error).toContain("voice model missing");
  });

  test("tts settings", () => {
    expect(createTts(settings({ tts_engine: "browser" }))).toBeNull();
    const engine = createTts(settings({ tts_engine: "PIPER", tts_voice: "en_GB-alba-medium" }))!;
    expect(engine.modelPath.endsWith("en_GB-alba-medium.onnx")).toBe(true);
    expect(() => settings({ tts_engine: "espeak" })).toThrow();
  });

  test("/api/stt transcribes a WAV", async () => {
    const engine = new FakeSTT();
    const server = await start({ agent: agentOf(fakeModel("hi")), settings: settings(), sttEngine: engine });
    const { hello } = await open(server);
    expect(hello.stt).toBe("whisper");
    const response = await post(`${server.url}/api/stt`, new Uint8Array(wav(0.5)), { "content-type": "audio/wav" });
    expect(await response.json()).toEqual({ text: "Hey Luna. What time is it?" });
    expect(engine.heard).toEqual([8000]); // 0.5 s at 16 kHz
    expect((await post(`${server.url}/api/stt`, "nope")).status).toBe(400);
    expect((await post(`${server.url}/api/stt`, new Uint8Array(wav(0.5, 44100)))).status).toBe(400); // must be 16 kHz
    expect((await post(`${server.url}/api/stt`, new Uint8Array(wav(0.5, 16000, 2)))).status).toBe(400);
    expect((await post(`${server.url}/api/stt`, new Uint8Array(wav(31)))).status).toBe(400);
    expect((await post(`${server.url}/api/stt`, new Uint8Array(wav()), { origin: "https://evil.example" })).status).toBe(403);
  });

  test("stt off means browser recognition", async () => {
    const server = await start({ agent: agentOf(fakeModel("hi")), settings: settings() });
    const { hello } = await open(server);
    expect(hello.stt).toBe("browser");
    expect((await post(`${server.url}/api/stt`, new Uint8Array(wav()))).status).toBe(404);
  });

  test("WAV samples scale to float", () => {
    const pcm = Buffer.alloc(4);
    pcm.writeInt16LE(16384, 0);
    pcm.writeInt16LE(-32768, 2);
    const { pcm: back, samples } = wavToPcm(pcmToWav(pcm, 16000));
    expect(samples).toBe(2);
    expect([...pcmToFloat(back)]).toEqual([0.5, -1]);
  });

  test("stt settings", () => {
    expect(createStt(settings({ stt_engine: "browser" }))).toBeNull();
    const engine = createStt(settings({ stt_engine: "Whisper", stt_model: "small.en" }))!;
    expect(engine.modelName).toBe("small.en");
    expect(engine.model).toBe("onnx-community/whisper-small.en");
    expect(() => settings({ stt_engine: "vosk" })).toThrow();
  });
});

// --- cancelling ------------------------------------------------------------------

function slowAgent(started: string[], cancelled: string[]) {
  const longJob = tool(
    async ({ title }, config) => {
      started.push(title);
      const signal = (config as { signal?: AbortSignal })?.signal;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 30_000);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          cancelled.push(title);
          reject(new Error("Aborted"));
        }, { once: true });
      });
      return "finished";
    },
    { name: "long_job", description: "A slow job.", schema: z.object({ title: z.string() }) },
  );
  return agentOf(fakeModel(toolCall("long_job", "c1", { title: "report" }), "ready for the next thing"), [longJob]);
}

describe("cancel", () => {
  test("stops a running task and repairs the thread", async () => {
    const started: string[] = [];
    const cancelled: string[] = [];
    const server = await start({ agent: slowAgent(started, cancelled), settings: settings() });
    const { tab } = await open(server);
    tab.send({ type: "message", text: "run the report" });
    await tab.until("tool_call");
    // While it runs, the socket still answers — and refuses conflicting requests.
    tab.send({ type: "message", text: "and another" });
    expect((await tab.next()).message).toContain("Still working");
    tab.send({ type: "new_thread" });
    expect((await tab.next()).message).toContain("cancel");
    tab.send({ type: "cancel" });
    const events = await tab.until("cancelled");
    expect(events.at(-1)).toEqual({ type: "cancelled", tools: ["long_job"] });
    expect(events.map((e) => e.type)).toEqual(["context", "cancelled"]); // meter first
    expect(cancelled).toEqual(["report"]);
    // The thread is usable again: the next message runs normally.
    tab.send({ type: "message", text: "hello" });
    const next = await tab.until("done", "error");
    expect(next.at(-1).type).toBe("done");
    expect(next.filter((e) => e.type === "token").map((e) => e.text).join("")).toBe("ready for the next thing");
  });

  test("abandons an open approval", async () => {
    const written: string[] = [];
    const writeFile = tool(async ({ path }) => {
      written.push(path);
      return "ok";
    }, { name: "write_file", description: "Write a file.", schema: z.object({ path: z.string(), content: z.string() }) });
    const agent = agentOf(fakeModel(toolCall("write_file", "c1", { path: "a.md", content: "x" }), "what next?"), [writeFile], {
      middleware: [humanInTheLoopMiddleware({ interruptOn: { write_file: true } })],
    });
    const server = await start({ agent, settings: settings() });
    const { tab } = await open(server);
    tab.send({ type: "message", text: "save" });
    await tab.until("pause");
    tab.send({ type: "cancel" });
    expect(await tab.next()).toEqual({ type: "cancelled", tools: ["write_file"] });
    tab.send({ type: "message", text: "hi" }); // no longer "waiting for your answer"
    expect((await tab.until("done", "error")).at(-1).type).toBe("done");
    expect(written).toEqual([]);
  });

  test("with nothing running", async () => {
    const server = await start({ agent: agentOf(fakeModel("hi")), settings: settings() });
    const { tab } = await open(server);
    tab.send({ type: "cancel" });
    expect(await tab.next()).toEqual({ type: "cancelled", tools: [] });
  });

  test("cancelCleanup clears a helper's approval", async () => {
    const written: string[] = [];
    const writeFile = tool(async ({ path }) => {
      written.push(path);
      return "ok";
    }, { name: "write_file", description: "Write a file.", schema: z.object({ path: z.string(), content: z.string() }) });
    const delegate = makeDelegateTool(
      subagentSpec({
        name: "ask_files", description: "Files.", systemPrompt: "p", tools: [writeFile as unknown as AnyTool],
        model: fakeModel(toolCall("write_file", "w1", { path: "a.md", content: "x" }), "files done") as never, interruptOn: { write_file: true },
      }),
      null,
    );
    const agent = agentOf(fakeModel(toolCall("ask_files", "c1", { task: "save" }), "ok"), [delegate]);
    const config = { configurable: { thread_id: "t" } };
    await agent.invoke({ messages: [{ role: "user", content: "save" }] }, config);
    const { snapshotInterrupts } = await import("../src/agent/types.ts");
    expect(snapshotInterrupts(await agent.getState(config))).toHaveLength(1);
    expect(await cancelCleanup(agent, config)).toEqual(["ask_files"]);
    const state = await agent.getState(config);
    expect(snapshotInterrupts(state)).toEqual([]);
    expect(state.values.messages.at(-1).text).toBe(CANCELLED);
    const out = await agent.invoke({ messages: [{ role: "user", content: "hi" }] }, config);
    expect(out.messages.at(-1).text).toBe("ok");
    expect(written).toEqual([]);
  });
});

// --- long-term memory panel ---------------------------------------------------------

async function openWithMemory(server: LunaServer) {
  const c = await open(server);
  expect(await c.tab.next()).toEqual({ type: "memory_inbox", count: 0 }); // after "context"
  return c;
}

describe("memory panel", () => {
  test("edits and undo", async () => {
    const store = new LongTermStore();
    const server = await start({ agent: agentOf(fakeModel("hi")), settings: settings(), memoryStore: store });
    const { tab, hello } = await openWithMemory(server);
    expect(hello.memory).toBe(true);
    tab.send({ type: "memory_save", text: "Prefers tea", kind: "preference", pinned: false });
    const listed = await tab.next();
    expect([listed.type, listed.suggestions]).toEqual(["memories", []]);
    const [m] = listed.items;
    expect([m.text, m.kind]).toEqual(["Prefers tea", "preference"]);
    tab.send({ type: "memory_save", id: m.id, text: "Prefers green tea", kind: "preference", pinned: true });
    expect({ ...(await tab.next()).items[0], updated_at: null }).toEqual({ ...m, text: "Prefers green tea", pinned: true, updated_at: null });
    tab.send({ type: "memory_history", id: m.id });
    const history = await tab.next();
    expect([history.type, history.entries.map((e: { action: string }) => e.action)]).toEqual(["memory_history", ["edit", "add"]]);
    tab.send({ type: "memory_delete", id: m.id });
    expect((await tab.next()).items).toEqual([]);
    tab.send({ type: "memory_undo", id: m.id });
    expect((await tab.next()).items[0].text).toBe("Prefers green tea");
    // Bad requests are memory_error, which doesn't end a run in the browser.
    tab.send({ type: "memory_delete", id: 999 });
    expect((await tab.next()).type).toBe("memory_error");
    tab.send({ type: "memory_save", text: "", kind: "fact", pinned: false });
    expect((await tab.next()).type).toBe("memory_error");
  });

  test("suggestions from a run reach the inbox", async () => {
    const store = new LongTermStore();
    const agent = agentOf(fakeModel(toolCall("remember", "c1", { text: "Has a dog named Bruno", kind: "person" }), "Noted, Sir."), [], {
      middleware: [longTermMemoryMiddleware(store)],
    });
    const server = await start({ agent, settings: settings(), memoryStore: store });
    const { tab } = await openWithMemory(server);
    tab.send({ type: "message", text: "my dog Bruno says hi" });
    const events = await tab.until("done", "error");
    expect(events.slice(-3).map((e) => e.type)).toEqual(["memory_inbox", "context", "done"]);
    expect(events.at(-3).count).toBe(1);
    expect(store.list()).toEqual([]); // only a suggestion so far
    tab.send({ type: "memories" });
    const [s] = (await tab.next()).suggestions;
    expect([s.action, s.thread_id.length]).toEqual(["add", 36]);
    tab.send({ type: "suggestion_accept", id: s.id, text: "Has a beagle named Bruno" });
    const listed = await tab.next();
    expect(listed.items.map((m: { text: string }) => m.text)).toEqual(["Has a beagle named Bruno"]);
    expect(listed.suggestions).toEqual([]);
    expect(await tab.next()).toEqual({ type: "memory_inbox", count: 0 }); // told to every tab
  });

  test("memory off", async () => {
    const server = await start({ agent: agentOf(fakeModel("hi")), settings: settings() });
    const { tab, hello } = await open(server);
    expect(hello.memory).toBe(false);
    tab.send({ type: "memories" });
    expect((await tab.next()).type).toBe("memory_error");
  });

  test("lists, resumes and deletes sessions", async () => {
    const server = await start({ agent: agentOf(fakeModel("Hello!", "Bye!")), settings: settings() });
    const { tab, thread: first } = await open(server);
    tab.send({ type: "sessions" });
    expect(await tab.next()).toEqual({ type: "sessions", items: [] }); // nothing said yet
    tab.send({ type: "message", text: "plan my trip to Goa" });
    await tab.until("done", "error");
    tab.send({ type: "new_thread" });
    const second = await tab.next();
    await tab.next(); // context
    tab.send({ type: "message", text: "what is 2+2" });
    await tab.until("done", "error");
    tab.send({ type: "sessions" });
    const items = (await tab.next()).items;
    expect(items.map((i: { title: string }) => i.title)).toEqual(["what is 2+2", "plan my trip to Goa"]); // most recent first
    expect(items.map((i: { id: string }) => i.id)).toEqual([second.id, first.id]);
    expect(items[0].turns).toBe(1);
    // Delete the open session: this tab moves to a new, empty one.
    tab.send({ type: "delete_session", id: second.id });
    const moved = await tab.next();
    expect(moved.type).toBe("thread");
    expect([first.id, second.id]).not.toContain(moved.id);
    await tab.next(); // context
    expect((await tab.next()).items.map((i: { id: string }) => i.id)).toEqual([first.id]);
  });
});
