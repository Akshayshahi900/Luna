// The Control Center API (/api/control/*): settings saved to a temp .env,
// MCP connectors in a temp JSON, permissions, stats, dashboard and routines.
// Fake model and fake tools; nothing touches the real .env or config.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { tool } from "@langchain/core/tools";
import { MemorySaver } from "@langchain/langgraph";
import { createAgent } from "langchain";
import { afterEach, beforeEach, expect, test } from "vitest";
import * as z from "zod";

import { LongTermStore } from "../src/agent/longterm.ts";
import type { LunaAgent } from "../src/agent/types.ts";
import { loadSettings } from "../src/config/settings.ts";
import { loadMcpConfig } from "../src/mcp/loader.ts";
import { RoutineStore } from "../src/routines/store.ts";
import type { AnyTool } from "../src/tools/registry.ts";
import type { LunaServer } from "../src/web/server.ts";
import { fakeModel, tmpDir } from "./helpers.ts";
import { serve, SocketClient } from "./ws_client.ts";

const listTasks = tool(async () => JSON.stringify([{ title: "Pay rent", due: null, done: false }]), {
  name: "list_tasks", description: "Fake to-dos.", schema: z.object({ include_done: z.boolean().default(false) }),
});
const deleteTask = tool(async () => "deleted", { name: "delete_task", description: "Fake risky tool.", schema: z.object({ task_id: z.number() }) });

let dir: string;
let paths: { env: string; mcp: string; dashboard: string };
let server: LunaServer;
let rebuilt: [string, string][];
let tabs: SocketClient[];

beforeEach(async () => {
  dir = tmpDir();
  paths = { env: path.join(dir, ".env"), mcp: path.join(dir, "mcp.json"), dashboard: path.join(dir, "dashboard.json") };
  writeFileSync(paths.env, "# my settings\nLUNA_UNITS=metric\nLUNA_DEFAULT_THREAD_ID=old\n");
  writeFileSync(paths.mcp, JSON.stringify({ mcpServers: {
    demo: { command: "uv", args: ["run", "demo.py"] },
    tasks: { command: "uv", args: ["run", "tasks.py"], agent: "assistant", env: { TOKEN: "s3cret" } },
  } }));
  const settings = loadSettings({
    envFile: paths.env,
    env: {},
    overrides: {
      openrouter_api_key: "test",
      summary_trigger_tokens: 0,
      mcp_config_path: paths.mcp,
      google_token_path: path.join(dir, "token.json"),
      google_credentials_path: path.join(dir, "credentials.json"),
      workspace_dirs: [dir],
    },
  });
  const agent = createAgent({ model: fakeModel(...Array(10).fill("Done.")) as never, tools: [], checkpointer: new MemorySaver() }) as unknown as LunaAgent;
  rebuilt = [];
  server = await serve({
    agent,
    settings,
    rebuild: async (provider, model) => {
      rebuilt.push([provider, model]);
      return agent;
    },
    memoryStore: new LongTermStore(),
    routineStore: new RoutineStore(":memory:", "UTC"),
    mcpGroups: new Map([["assistant", [listTasks, deleteTask] as unknown as AnyTool[]]]),
    envPath: paths.env,
    dashboardPath: paths.dashboard,
  });
  tabs = [];
});
afterEach(async () => {
  for (const t of tabs) t.close();
  await server.close();
});

const api = (route: string, init: RequestInit & { json?: unknown } = {}) => {
  const { json, ...rest } = init;
  return fetch(`${server.url}/api/control/${route}`, {
    ...rest,
    ...(json !== undefined ? { body: JSON.stringify(json), headers: { "content-type": "application/json", ...(rest.headers ?? {}) } } : {}),
  });
};
const get = async (route: string) => (await (await api(route)).json()) as any;
const tab = async () => {
  const t = await SocketClient.open(server.url);
  tabs.push(t);
  return t;
};
const nextOfType = async (t: SocketClient, type: string) => {
  for (;;) {
    const m = await t.next();
    if (m.type === type) return m;
  }
};

test("other origins are refused", async () => {
  for (const [method, route] of [["GET", "settings"], ["PATCH", "settings"], ["GET", "stats"], ["PUT", "mcp/x"]]) {
    expect((await api(route, { method, headers: { origin: "http://evil.example" } })).status).toBe(403);
  }
});

test("the settings schema masks secrets", async () => {
  const data = await get("settings");
  const fields = Object.fromEntries(data.groups.flatMap((g: any) => g.fields).map((f: any) => [f.name, f]));
  expect(fields.openrouter_api_key.value).toBeNull();
  expect(fields.openrouter_api_key.is_set).toBe(true);
  expect(JSON.stringify(fields.openrouter_api_key)).not.toContain('"test"');
  expect(data.unknown).toEqual(["LUNA_DEFAULT_THREAD_ID"]);
  expect(data.restart_required).toEqual([]);
});

test("saving settings writes .env, rebuilds and flags restarts", async () => {
  const t = await tab();
  await t.next(); // hello
  const r = await api("settings", { method: "PATCH", json: { values: { units: "imperial", web_port: 9001 } } });
  expect(r.status).toBe(200);
  const body = (await r.json()) as any;
  expect(body.effects).toEqual({ units: "rebuild", web_port: "restart" });
  expect([body.rebuilt, body.restart_required]).toEqual([true, ["web_port"]]);
  expect((await nextOfType(t, "settings_changed")).keys).toEqual(["units", "web_port"]);
  expect(rebuilt.length).toBeGreaterThan(0); // agent rebuilt with the same provider / model
  expect(readFileSync(paths.env, "utf8")).toBe("# my settings\nLUNA_UNITS=imperial\nLUNA_DEFAULT_THREAD_ID=old\nLUNA_WEB_PORT=9001\n");
  // Values that weren't saved stay as the server started with them.
  expect(server.host.settings.mcp_config_path).toBe(paths.mcp);
  expect(server.host.settings.units).toBe("imperial");
});

test("invalid settings are refused and the file kept", async () => {
  const before = readFileSync(paths.env, "utf8");
  const r = await api("settings", { method: "PATCH", json: { values: { units: "cubits" } } });
  expect(r.status).toBe(400);
  expect(((await r.json()) as any).error).toContain("LUNA_UNITS");
  expect((await api("settings", { method: "PATCH", json: { values: {} } })).status).toBe(400);
  expect(readFileSync(paths.env, "utf8")).toBe(before);
});

test("unknown keys can be removed", async () => {
  const r = await api("settings", { method: "PATCH", json: { values: {}, remove_unknown: ["LUNA_DEFAULT_THREAD_ID"] } });
  expect(r.status).toBe(200);
  expect(((await r.json()) as any).unknown).toEqual([]);
  expect(readFileSync(paths.env, "utf8")).not.toContain("DEFAULT_THREAD_ID");
});

test("MCP: list, add, disable and remove", async () => {
  const data = await get("mcp");
  const servers = Object.fromEntries(data.servers.map((s: any) => [s.name, s]));
  expect([servers.tasks.agent, servers.tasks.status]).toEqual(["assistant", "ok"]);
  expect(servers.tasks.env_keys).toEqual(["TOKEN"]);
  expect(JSON.stringify(data)).not.toContain("s3cret");

  let r = await api("mcp/docs", { method: "PUT", json: { url: "https://example.com/mcp", agent: "researcher" } });
  expect(r.status).toBe(200);
  expect(Object.fromEntries(((await r.json()) as any).servers.map((s: any) => [s.name, s.status])).docs).toBe("restart");

  r = await api("mcp/tasks", { method: "PUT", json: { command: "uv", args: ["run", "tasks.py"], agent: "assistant", disabled: true } });
  const saved = JSON.parse(readFileSync(paths.mcp, "utf8")).mcpServers;
  expect(saved.tasks.disabled).toBe(true);
  expect(saved.tasks.env).toEqual({ TOKEN: "s3cret" }); // env kept
  expect(Object.fromEntries(((await r.json()) as any).servers.map((s: any) => [s.name, s.status])).tasks).toBe("off");
  expect(readFileSync(paths.mcp, "utf8")).toContain('"args": ["run", "tasks.py"]'); // compact like the hand-written file

  expect((await api("mcp/docs", { method: "DELETE" })).status).toBe(200);
  expect(JSON.parse(readFileSync(paths.mcp, "utf8")).mcpServers).not.toHaveProperty("docs");
  expect((await api("mcp/docs", { method: "DELETE" })).status).toBe(404);
  expect((await get("settings")).restart_required).toContain("mcp_servers");
});

test("MCP validation", async () => {
  expect((await api("mcp/bad name", { method: "PUT", json: { url: "https://x" } })).status).toBe(400);
  expect((await api("mcp/x", { method: "PUT", json: {} })).status).toBe(400);
  expect((await api("mcp/x", { method: "PUT", json: { url: "ftp://x" } })).status).toBe(400);
  expect((await api("mcp/x", { method: "PUT", json: { url: "https://x", agent: "boss" } })).status).toBe(400);
});

test("disabled servers are not loaded", () => {
  const config = path.join(dir, "m.json");
  writeFileSync(config, JSON.stringify({ mcpServers: { a: { command: "x" }, b: { command: "y", disabled: true } } }));
  const servers = loadMcpConfig(config)!.mcpServers;
  expect(Object.keys(servers)).toEqual(["a"]);
  expect(servers.a).not.toHaveProperty("disabled");
  writeFileSync(config, JSON.stringify({ mcpServers: { b: { command: "y", disabled: true } } }));
  expect(loadMcpConfig(config)).toBeNull();
});

test("connections without Google", async () => {
  const data = await get("connections");
  expect([data.google.token, data.google.client_file]).toEqual([false, false]);
  expect(data.keys.openrouter).toBe(true);
  const r = await api("connections/google", { method: "POST" });
  expect(r.status).toBe(400);
  expect(((await r.json()) as any).error).toContain("OAuth client file");
});

test("providers and saving the default", async () => {
  const data = await get("providers");
  expect(data.current.provider).toBe("openrouter");
  expect(new Set(data.providers.map((p: any) => p.id))).toEqual(new Set(["openrouter", "groq", "ollama"]));
  const r = await api("providers/default", { method: "POST", json: { provider: "ollama", model: "qwen3:8b", apply: true } });
  expect(r.status).toBe(200);
  const body = (await r.json()) as any;
  expect(body.default).toEqual({ provider: "ollama", model: "qwen3:8b" });
  expect(body.current).toEqual({ provider: "ollama", model: "qwen3:8b" });
  expect(readFileSync(paths.env, "utf8")).toContain("LUNA_PROVIDER=ollama");
  expect(readFileSync(paths.env, "utf8")).toContain("LUNA_OLLAMA_MODEL=qwen3:8b");
  expect((await api("providers/default", { method: "POST", json: { provider: "nope" } })).status).toBe(400);
});

test("permissions list helper tools", async () => {
  let data = await get("permissions");
  let tools = Object.fromEntries(data.tools.map((t: any) => [`${t.owner}/${t.name}`, t]));
  expect(tools["assistant/delete_task"].mode).toBe("ask");
  expect(tools["assistant/list_tasks"].mode).toBe("free");
  expect((await api("settings", { method: "PATCH", json: { values: { auto_approve: ["delete_task"] } } })).status).toBe(200);
  data = await get("permissions");
  tools = Object.fromEntries(data.tools.map((t: any) => [`${t.owner}/${t.name}`, t]));
  expect(tools["assistant/delete_task"].mode).toBe("auto");
  expect(data.auto_approve).toEqual(["delete_task"]);
});

test("stats count usage from chat", async () => {
  const t = await tab();
  t.send({ type: "message", text: "hi" });
  await nextOfType(t, "done");
  const stats = await get("stats");
  expect(stats.usage.since_start.runs).toBe(1);
  expect(stats.usage.since_start.model_calls).toBe(1);
  expect(stats.usage.days.at(-1).model_calls).toBe(1);
  expect(stats.memory.total).toBe(0);
  expect(stats.sessions.count).toBe(1);
  expect(stats.routines.total).toBe(3); // the seeded built-ins
  expect(stats.process.rss).toBeGreaterThan(0);
});

test("dashboard preferences are cleaned", async () => {
  expect((await get("dashboard")).position).toBe("bottom-left");
  const r = await api("dashboard", { method: "PUT", json: { position: "bottom-right", opacity: 5, style: "fancy", evil: 1 } });
  const body = (await r.json()) as any;
  expect([body.position, body.opacity, body.style]).toEqual(["bottom-right", 1, "compact"]);
  const saved = JSON.parse(readFileSync(paths.dashboard, "utf8"));
  expect(saved).not.toHaveProperty("evil");
  expect(saved.position).toBe("bottom-right");
});

test("routines: CRUD, run and insights", async () => {
  let data = await get("routines");
  const todos = data.routines.find((r: any) => r.builtin === "todos");
  expect(data.scheduler).toBe(true);
  await api(`routines/${todos.id}`, { method: "PATCH", json: { enabled: true } });
  const t = await tab();
  await t.next();
  let run = (((await (await api(`routines/${todos.id}/run`, { method: "POST" })).json()) as any)).run;
  expect([run.status, run.summary]).toEqual(["ok", "1 open"]);
  expect((await nextOfType(t, "routine_result")).routine.builtin).toBe("todos");
  expect((await get("insights")).insights.todos.data.open).toBe(1);

  const r = await api("routines", { method: "POST", json: { name: "Brief", prompt: "Say hi", cron: "0 8 * * 1-5" } });
  expect(r.status).toBe(201);
  const brief = ((await r.json()) as any).routines.find((x: any) => x.kind === "agent");
  expect([brief.schedule, brief.enabled]).toEqual(["weekdays at 08:00", true]);
  run = (((await (await api(`routines/${brief.id}/run`, { method: "POST" })).json()) as any)).run;
  expect(run.summary).toBe("Done.");
  expect((await get(`routines/${brief.id}/runs`)).runs).toHaveLength(1);

  expect((await api("routines", { method: "POST", json: { name: "x", prompt: "y", cron: "bad" } })).status).toBe(400);
  expect((await api(`routines/${todos.id}`, { method: "DELETE" })).status).toBe(400); // built-in
  expect((await api(`routines/${brief.id}`, { method: "DELETE" })).status).toBe(200);
  expect((await api(`routines/${brief.id}/run`, { method: "POST" })).status).toBe(404);
  data = await get("routines");
  expect(data.routines.some((x: any) => x.id === brief.id)).toBe(false);
});

test("the cron check", async () => {
  const ok = await get(`cron?expr=${encodeURIComponent("*/10 * * * *")}`);
  expect([ok.valid, ok.text, ok.next.length]).toEqual([true, "every 10 minutes", 3]);
  expect((await get("cron?expr=nope")).valid).toBe(false);
});
