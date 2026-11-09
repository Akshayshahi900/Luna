// MCP: config loading, routing by "agent" tag, risky names, a real stdio server.
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";

import { tool } from "@langchain/core/tools";
import { afterAll, expect, test, vi } from "vitest";
import * as z from "zod";

import { buildMiddleware, buildToolRegistry, loadMcpGroups } from "../src/agent/builder.ts";
import { getSubagentSpecs } from "../src/agent/subagents/index.ts";
import { loadSettings, PROJECT_ROOT, type Settings } from "../src/config/settings.ts";
import { closeMcpClients, isRiskyToolName, loadMcpConfig, loadMcpTools, splitByAgent } from "../src/mcp/loader.ts";
import type { AnyTool } from "../src/tools/registry.ts";
import { tmpDir } from "./helpers.ts";

afterAll(() => closeMcpClients());

const DEMO = path.join(PROJECT_ROOT, "core", "servers", "demo.ts");
const settings = (overrides: Partial<Settings> = {}) =>
  loadSettings({ envFile: null, env: {}, overrides: { openrouter_api_key: "test", workspace_dirs: [path.join(tmpDir(), "ws")], ...overrides } });
const fake = (name: string) => tool(async () => "ok", { name, description: "Fake MCP tool.", schema: z.object({}) }) as unknown as AnyTool;
const names = (tools: { name: string }[]) => new Set(tools.map((t) => t.name));

test("a stdio server's tools load and run", async () => {
  const tools = await loadMcpTools({ mcpServers: { demo: { command: process.execPath, args: [DEMO] } } });
  expect(names(tools)).toEqual(new Set(["reverse_text", "word_count"]));
  const reverse = tools.find((t) => t.name === "reverse_text")!;
  expect(String(await reverse.invoke({ text: "hi" }))).toContain("ih");
});

test("a missing config returns no tools", async () => {
  expect(await loadMcpTools(path.join(tmpDir(), "nope.json"))).toEqual([]);
});

test("a broken server does not block startup", async () => {
  const config = path.join(tmpDir(), "mcp.json");
  writeFileSync(config, JSON.stringify({ mcpServers: { bad: { command: "definitely-not-a-real-binary" } } }));
  const warn = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const registry = await buildToolRegistry(settings({ mcp_config_path: config }));
  expect(registry.names()).toContain("calculator");
  expect(warn.mock.calls.flat().join(" ")).toContain("could not load MCP tools");
  warn.mockRestore();
});

test("stdio servers default to the project root; disabled entries are skipped", () => {
  const config = path.join(tmpDir(), "mcp.json");
  writeFileSync(config, JSON.stringify({ mcpServers: {
    a: { command: "x" },
    b: { command: "x", cwd: "/elsewhere" },
    c: { url: "https://example.com/mcp" },
    d: { command: "x", disabled: true },
  } }));
  const servers = loadMcpConfig(config)!.mcpServers;
  expect(servers.a.cwd).toBe(PROJECT_ROOT);
  expect(servers.b.cwd).toBe("/elsewhere");
  expect(servers.c).not.toHaveProperty("cwd");
  expect(servers).not.toHaveProperty("d");
});

test("splitByAgent removes the tag", () => {
  const groups = splitByAgent({ mcpServers: { cal: { url: "u", agent: "assistant" }, docs: { url: "d" } } });
  expect(Object.fromEntries(groups)).toEqual({ assistant: { mcpServers: { cal: { url: "u" } } }, "": { mcpServers: { docs: { url: "d" } } } });
});

test("risky names", () => {
  for (const n of ["send_email", "createEvent", "calendar.delete", "add-task", "update_event"]) expect(isRiskyToolName(n)).toBe(true);
  for (const n of ["list_events", "get_settings", "search", "read_inbox", "reset"]) expect(isRiskyToolName(n)).toBe(false);
});

test("the assistant only exists with tagged tools", () => {
  const s = settings();
  expect(names(getSubagentSpecs(s, new Map()))).not.toContain("ask_assistant");
  const specs = Object.fromEntries(getSubagentSpecs(s, new Map([["assistant", [fake("list_events"), fake("create_event")]]])).map((x) => [x.name, x]));
  expect(names(specs.ask_assistant.tools)).toEqual(new Set(["list_events", "create_event", "get_current_time"]));
  expect(specs.ask_assistant.interruptOn).toEqual({ create_event: true });
});

test("auto-approve applies to MCP tools", () => {
  const specs = getSubagentSpecs(settings({ auto_approve: ["create_event"] }), new Map([["assistant", [fake("create_event")]]]));
  expect(specs.find((x) => x.name === "ask_assistant")!.interruptOn).toEqual({});
});

test("other tags extend that subagent", () => {
  const warn = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const groups = new Map([["researcher", [fake("docs_search"), fake("docs_delete")]], ["nobody", [fake("orphan")]]]);
  const specs = Object.fromEntries(getSubagentSpecs(settings({ tavily_api_key: "tvly-test" }), groups).map((x) => [x.name, x]));
  expect(names(specs.ask_researcher.tools)).toContain("docs_search");
  expect(specs.ask_researcher.interruptOn).toEqual({ docs_delete: true });
  expect(warn.mock.calls.flat().join(" ")).toContain("agent='nobody'");
  warn.mockRestore();
});

test("the main agent gets approval middleware for risky tools", () => {
  const s = settings({ summary_trigger_tokens: 0 }); // no summarizer model needed
  expect(buildMiddleware(s, null).map((m) => m.name)).not.toContain("HumanInTheLoopMiddleware");
  expect(buildMiddleware(s, null, { send_email: true }).map((m) => m.name)).toContain("HumanInTheLoopMiddleware");
});

test("tagged server tools skip the main agent", async () => {
  expect(existsSync(DEMO)).toBe(true);
  const config = path.join(tmpDir(), "mcp.json");
  writeFileSync(config, JSON.stringify({ mcpServers: { demo: { command: process.execPath, args: [DEMO], agent: "assistant" } } }));
  const s = settings({ mcp_config_path: config });
  const groups = await loadMcpGroups(s);
  const registry = await buildToolRegistry(s, groups);
  expect(names(groups.get("assistant")!)).toEqual(new Set(["reverse_text", "word_count"]));
  expect(registry.names()).not.toContain("reverse_text");
  const specs = Object.fromEntries(getSubagentSpecs(s, groups).map((x) => [x.name, x]));
  expect(names(specs.ask_assistant.tools)).toContain("reverse_text");
});

test("duplicate tool names in one group get the server's name", async () => {
  const tools = await loadMcpTools({ mcpServers: {
    one: { command: process.execPath, args: [DEMO] },
    two: { command: process.execPath, args: [DEMO] },
  } });
  expect(names(tools)).toEqual(new Set(["reverse_text", "word_count", "two_reverse_text", "two_word_count"]));
});
