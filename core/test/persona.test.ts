// Persona and providers: the system prompt is built from the persona
// settings; one ChatOpenAI client talks to three OpenAI-compatible APIs.
import { writeFileSync } from "node:fs";
import path from "node:path";

import { MemorySaver } from "@langchain/langgraph";
import { afterEach, expect, test, vi } from "vitest";

import { assembleAgent } from "../src/agent/builder.ts";
import { CONCISE_STYLE, DETAILED_STYLE, buildSystemPrompt } from "../src/agent/persona.ts";
import { describeProviders, listModels, makeModel } from "../src/agent/providers.ts";
import { RESEARCHER_PROMPT } from "../src/agent/subagents/researcher.ts";
import { loadSettings, type Settings } from "../src/config/settings.ts";
import { fakeModel, tmpDir } from "./helpers.ts";

function settings(dir: string, overrides: Partial<Settings> = {}) {
  return loadSettings({
    envFile: null,
    env: {},
    overrides: { openrouter_api_key: "test", workspace_dirs: [dir], persona_path: path.join(dir, "persona.md"), ...overrides },
  });
}

test("defaults are concise and say Sir", () => {
  const prompt = buildSystemPrompt(settings(tmpDir()));
  expect(prompt.startsWith("You are Luna")).toBe(true);
  expect(prompt).toContain(CONCISE_STYLE);
  expect(prompt).not.toContain(DETAILED_STYLE);
  expect(prompt).toContain('Address the user as "Sir"');
  expect(prompt).toContain("Units: metric");
});

test("profile facts are included", () => {
  const prompt = buildSystemPrompt(settings(tmpDir(), { user_name: "Akshay", user_location: "Agra, India", timezone: "Asia/Kolkata", units: "IMPERIAL" }));
  expect(prompt).toContain("Name: Akshay");
  expect(prompt).toContain("Location: Agra, India");
  expect(prompt).toContain("Timezone: Asia/Kolkata");
  expect(prompt).toContain("Units: imperial (Fahrenheit");
});

test("detailed style and no title", () => {
  const dir = tmpDir();
  const prompt = buildSystemPrompt(settings(dir, { response_style: "detailed", user_title: "" }));
  expect(prompt).toContain(DETAILED_STYLE);
  expect(prompt).not.toContain(CONCISE_STYLE);
  expect(prompt).not.toContain("Address the user");
  expect(buildSystemPrompt(settings(dir, { user_title: "", user_name: "Akshay" }))).toContain("Address the user by name (Akshay)");
});

test("the persona file is appended", () => {
  const dir = tmpDir();
  writeFileSync(path.join(dir, "persona.md"), "Use 24-hour time.\n");
  expect(buildSystemPrompt(settings(dir)).endsWith("Extra instructions from the user (follow them):\nUse 24-hour time.")).toBe(true);
});

test("a missing or disabled persona file is fine", () => {
  const dir = tmpDir();
  expect(buildSystemPrompt(settings(dir))).not.toContain("Extra instructions");
  expect(buildSystemPrompt(settings(dir, { persona_path: null }))).not.toContain("Extra instructions");
});

test("bad values are rejected", () => {
  expect(() => settings(tmpDir(), { response_style: "chatty" })).toThrow(/response_style/);
  expect(() => settings(tmpDir(), { units: "furlongs" })).toThrow(/units/);
});

test("the main agent sees the persona", async () => {
  const s = settings(tmpDir(), { user_location: "Agra, India", enable_mcp_tools: false, summary_trigger_tokens: 0 });
  const model = fakeModel("It's 33 degrees, Sir.");
  const { agent } = await assembleAgent(s, model as never, new MemorySaver(), new Map());
  await agent.invoke({ messages: [{ role: "user", content: "weather?" }] }, { configurable: { thread_id: "t" } });
  expect(model.systemPrompts[0]).toContain('Address the user as "Sir"');
  expect(model.systemPrompts[0]).toContain("Location: Agra, India");
});

test("the researcher returns short facts", () => {
  expect(RESEARCHER_PROMPT).toContain("at most 60 words");
  expect(RESEARCHER_PROMPT).toContain("at most two URLs");
});

// --- providers ----------------------------------------------------------------------

const prov = (overrides: Partial<Settings> = {}) => loadSettings({ envFile: null, env: {}, overrides: { openrouter_api_key: "or-key", ...overrides } });
const baseURL = (m: unknown) => (m as { clientConfig: { baseURL: string } }).clientConfig.baseURL;

test("makeModel per provider", () => {
  const s = prov({ groq_api_key: "gq-key", ollama_base_url: "http://box:11434/v1/" });
  const openrouter = makeModel(s);
  expect(baseURL(openrouter)).toBe("https://openrouter.ai/api/v1");
  expect(openrouter.model).toBe(s.model_name);
  const groq = makeModel(s, "groq");
  expect(baseURL(groq)).toBe("https://api.groq.com/openai/v1");
  expect(groq.model).toBe(s.groq_model);
  expect(groq.apiKey).toBe("gq-key");
  const ollama = makeModel(s, "ollama", "llama3.2");
  expect(baseURL(ollama)).toBe("http://box:11434/v1");
  expect(ollama.model).toBe("llama3.2");
});

test("the startup provider comes from settings", () => {
  const s = prov({ provider: "OLLAMA" });
  expect(s.provider).toBe("ollama");
  expect(makeModel(s).model).toBe(s.ollama_model);
});

test("missing key and unknown provider", () => {
  expect(() => makeModel(prov(), "groq")).toThrow(/LUNA_GROQ_API_KEY/);
  expect(() => makeModel(prov(), "acme")).toThrow(/Unknown provider/);
  expect(() => prov({ provider: "acme" })).toThrow();
});

test("describeProviders marks configured", () => {
  const info = Object.fromEntries(describeProviders(prov()).map((p) => [p.id, p]));
  expect(info.openrouter.configured).toBe(true);
  expect(info.groq.configured).toBe(false);
  expect(info.ollama.configured).toBe(true); // local, no key
  expect(info.groq.default_model).toBe("openai/gpt-oss-120b");
});

afterEach(() => vi.unstubAllGlobals());

test("listModels reads the models endpoint", async () => {
  const seen: Record<string, string> = {};
  vi.stubGlobal("fetch", async (url: string, init: { headers: Record<string, string> }) => {
    seen.url = url;
    seen.auth = init.headers.Authorization;
    return new Response(JSON.stringify({ data: [{ id: "b" }, { id: "a" }, {}] }), { status: 200 });
  });
  expect(await listModels(prov({ groq_api_key: "gq" }), "groq")).toEqual(["a", "b"]);
  expect(seen).toEqual({ url: "https://api.groq.com/openai/v1/models", auth: "Bearer gq" });
});

test("makeModel uses few retries", () => {
  // Each retry is another API request, so Luna retries once by default.
  const retries = (m: unknown) => (m as { caller: { maxRetries: number } }).caller.maxRetries;
  expect(retries(makeModel(prov()))).toBe(1);
  expect(retries(makeModel(prov({ model_max_retries: 0 })))).toBe(0);
});
