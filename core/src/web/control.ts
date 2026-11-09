/**
 * Control Center API — settings, connectors, sign-ins, permissions, stats and
 * routines for the browser's Control Center (web/src/components/control/).
 *
 * BEGINNER MAP
 * ------------
 * Plain JSON over HTTP under /api/control/ (the chat itself stays on /ws):
 *
 *   GET   settings                    every setting, grouped (secrets masked)
 *   PATCH settings                    {"values": {field: value}, "remove_unknown": [KEY]} → .env
 *   GET   mcp                         servers in mcp_servers.json + load status
 *   PUT   mcp/{name}                  add / replace one server
 *   DELETE mcp/{name}                 remove one server
 *   GET   connections                 Google sign-in, mail, API keys
 *   POST  connections/google          start the Google consent flow (opens a browser tab)
 *   DELETE connections/google         sign out (delete the token)
 *   GET   providers                   providers, current and default model
 *   GET   providers/{id}/models       models the provider offers
 *   POST  providers/default           {"provider", "model", "apply"} → .env (+ switch now)
 *   GET   permissions                 every tool, who owns it, ask / auto / free
 *   GET   stats                       live numbers for the Overview
 *   GET   insights                    latest mail / agenda / to-do results (HUD widgets)
 *   GET   dashboard  · PUT dashboard  HUD widget preferences (data/dashboard.json)
 *   GET   routines   · POST routines  list / create
 *   PATCH routines/{id} · DELETE routines/{id}
 *   POST  routines/{id}/run           run now
 *   GET   routines/{id}/runs          run history
 *   GET   cron?expr=...               check a schedule: English + next runs
 *
 * What happens after a settings save depends on the field (config/schema.ts):
 * "live" fields are read fresh by the MCP servers, "rebuild" fields rebuild
 * the agent at once (AgentHost.reconfigure), "restart" fields are listed in
 * "restart_required" until luna-web restarts. Every tab gets
 * {"type": "settings_changed"} so open Control Centers refresh.
 *
 * SECURITY: same Origin check as /ws and /api/tts (these routes can change
 * API keys and what runs without approval). Secrets are never sent back.
 *
 * Read next: config/schema.ts, routines/scheduler.ts
 */

import { cpus, freemem, loadavg, totalmem } from "node:os";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { Context, Hono } from "hono";

import { defaultModel, describeProviders, getProvider, PROVIDERS } from "../agent/providers.ts";
import { listSessions } from "../agent/sessions.ts";
import { getSubagentSpecs } from "../agent/subagents/index.ts";
import { agentToolNames } from "../agent/types.ts";
import { envName, saveSettings, SettingsRejected, settingsSchema, type Applies } from "../config/schema.ts";
import { resetSettings, type Settings } from "../config/settings.ts";
import * as googleAuth from "../integrations/google.ts";
import { isRiskyToolName } from "../mcp/loader.ts";
import { BUILTINS } from "../routines/builtin.ts";
import { CronError, describe, nextRun, parse } from "../routines/cron.ts";
import { RoutineRefused, type RoutineStore } from "../routines/store.ts";
import { isoInZone } from "../util/zoned.ts";
import { hooks as sessionHooks, type AgentHost } from "./session.ts";

const SERVER_NAME = /^[A-Za-z0-9_-]{1,40}$/;
export const HELPER_TAGS = ["assistant", "researcher", "files", "coder"];
// Expensive numbers (scanning every checkpoint) are reused for this long.
const SLOW_STATS_MS = 30_000;

export const DEFAULT_DASHBOARD = {
  // Which HUD insight widgets show (they need their routine enabled).
  widgets: { mail: true, agenda: true, todos: true, stats: false } as Record<string, boolean>,
  position: "bottom-left", // bottom-left | bottom-right
  style: "compact", // compact (title + detail) | minimal (one line)
  opacity: 0.75, // 0.3 – 1
  show_hints: true, // the keyboard hint line under the dock
};
const POSITIONS = new Set(["bottom-left", "bottom-right"]);
const STYLES = new Set(["compact", "minimal"]);

/** What the routes share (the Python app.state). */
export interface ControlState {
  host: AgentHost;
  envPath: string;
  dashboardPath: string;
  pendingRestart: Set<string>;
  googleSigningIn: boolean;
  sampler: ProcessSampler;
  slowStats: [number, Record<string, unknown>] | null;
  mcpLoaded: Set<string>;
  originAllowed(c: Context): boolean;
}

// --- helpers -----------------------------------------------------------------

const error = (c: Context, message: string, status = 400) => c.json({ error: message }, status as never);

async function body(c: Context): Promise<Record<string, any>> {
  try {
    const parsed = await c.req.json();
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** JSON with 2-space indent, but lists of plain values on one line, like the
 * hand-written mcp_servers.json. */
export function jsonText(value: unknown, indent = 0): string {
  const pad = "  ".repeat(indent + 1);
  if (value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length) {
    const items = Object.entries(value).map(([k, v]) => `${pad}${JSON.stringify(k)}: ${jsonText(v, indent + 1)}`);
    return "{\n" + items.join(",\n") + "\n" + "  ".repeat(indent) + "}";
  }
  if (Array.isArray(value) && value.some((v) => v && typeof v === "object")) {
    return "[\n" + value.map((v) => pad + jsonText(v, indent + 1)).join(",\n") + "\n" + "  ".repeat(indent) + "]";
  }
  if (Array.isArray(value)) return "[" + value.map((v) => JSON.stringify(v)).join(", ") + "]";
  return JSON.stringify(value ?? null);
}

/** Write JSON via a temp file + rename (never half a file). */
function atomicJson(file: string, data: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, jsonText(data) + "\n", "utf8");
  renameSync(tmp, file);
}

/** `current` with only `fields` taken from the freshly saved settings. The
 * rest stays as luna-web started with it (e.g. values passed in code or by a
 * test), instead of everything being re-read from .env. */
function merged(current: Settings, saved: Settings, fields: Iterable<string>): Settings {
  const out = { ...current } as Record<string, unknown>;
  for (const f of fields) out[f] = (saved as unknown as Record<string, unknown>)[f];
  return out as unknown as Settings;
}

const restartList = (s: ControlState) => [...s.pendingRestart].sort();

// --- MCP config file ------------------------------------------------------------

function readMcp(file: string): { mcpServers: Record<string, Record<string, any>>; [k: string]: unknown } {
  if (!existsSync(file)) return { mcpServers: {} };
  const data = JSON.parse(readFileSync(file, "utf8"));
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("mcp_servers.json must hold an object");
  data.mcpServers ??= {};
  return data;
}

/** Validate one server entry from the browser; keep fields it doesn't edit. */
function cleanServer(input: Record<string, any>, old: Record<string, any>): Record<string, any> {
  const server: Record<string, any> = Object.fromEntries(Object.entries(old).filter(([k]) => !["command", "args", "url", "agent", "disabled"].includes(k)));
  const command = String(input.command ?? "").trim();
  const url = String(input.url ?? "").trim();
  if (Boolean(command) === Boolean(url)) throw new Error("Give either a command (stdio server) or a url (HTTP server).");
  if (command) {
    let args = input.args ?? [];
    if (typeof args === "string") args = args.split(/\s+/).filter(Boolean);
    if (!Array.isArray(args) || !args.every((a) => typeof a === "string")) throw new Error("args must be a list of strings");
    Object.assign(server, { command, args });
    delete server.url;
    delete server.transport;
  } else {
    if (!/^https?:\/\//.test(url)) throw new Error("url must start with http:// or https://");
    server.url = url;
    delete server.cwd;
  }
  if (input.agent) {
    if (!HELPER_TAGS.includes(input.agent)) throw new Error(`agent must be one of ${HELPER_TAGS.join(", ")} (or empty for the main agent)`);
    server.agent = input.agent;
  }
  if (input.disabled) server.disabled = true;
  if (input.env && typeof input.env === "object" && !Array.isArray(input.env)) {
    // only the keys sent are changed; null removes one
    const env: Record<string, string> = { ...(server.env ?? {}) };
    for (const [key, value] of Object.entries(input.env)) {
      if (value === null) delete env[key];
      else env[key] = String(value);
    }
    if (Object.keys(env).length) server.env = env;
    else delete server.env;
  }
  return server;
}

// --- stats -------------------------------------------------------------------

/** CPU % of this process between two calls (100 = one full core). */
export class ProcessSampler {
  #last = { wall: performance.now(), cpu: process.cpuUsage() };

  cpuPercent(): number {
    const wall = performance.now();
    const cpu = process.cpuUsage();
    const elapsed = wall - this.#last.wall;
    const used = (cpu.user - this.#last.cpu.user + cpu.system - this.#last.cpu.system) / 1000;
    this.#last = { wall, cpu };
    return elapsed > 0 ? Math.round((1000 * used) / elapsed) / 10 : 0;
  }
}

function size(file: string | null | undefined): number | null {
  try {
    return file ? statSync(file).size : null;
  } catch {
    return null;
  }
}

function system() {
  let available: number | null = null;
  try {
    const meminfo = readFileSync("/proc/meminfo", "utf8");
    const m = /MemAvailable:\s+(\d+)/.exec(meminfo);
    available = m ? Number(m[1]) * 1024 : null;
  } catch {
    available = freemem();
  }
  return { cpus: cpus().length || 1, load: loadavg().map((x) => Math.round(x * 100) / 100), mem_total: totalmem(), mem_available: available };
}

// --- dashboard -------------------------------------------------------------------

function cleanDashboard(data: Record<string, any>) {
  const out = structuredClone(DEFAULT_DASHBOARD);
  if (data.widgets && typeof data.widgets === "object") {
    for (const key of Object.keys(out.widgets)) if (key in data.widgets) out.widgets[key] = Boolean(data.widgets[key]);
  }
  if (POSITIONS.has(data.position)) out.position = data.position;
  if (STYLES.has(data.style)) out.style = data.style;
  if (typeof data.opacity === "number") out.opacity = Math.min(1, Math.max(0.3, data.opacity));
  if ("show_hints" in data) out.show_hints = Boolean(data.show_hints);
  return out;
}

function readDashboard(file: string) {
  try {
    const saved = JSON.parse(readFileSync(file, "utf8"));
    return cleanDashboard(saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {});
  } catch {
    return cleanDashboard({});
  }
}

// --- routes ------------------------------------------------------------------

/** Register every /api/control route on `app`. */
export function controlRoutes(app: Hono, state: ControlState): void {
  const p = "/api/control";
  const host = () => state.host;
  // Refuse requests from browser origins that may not use this server.
  app.use(`${p}/*`, async (c, next) => {
    if (!state.originAllowed(c)) return error(c, "origin not allowed", 403);
    await next();
  });

  // --- settings ----------------------------------------------------------------

  const schemaPayload = () => settingsSchema(host().settings, state.envPath);

  app.get(`${p}/settings`, (c) => c.json({ ...schemaPayload(), restart_required: restartList(state) }));

  /** Save to .env, then rebuild / flag a restart as each field needs. */
  const apply = async (c: Context, values: Record<string, unknown>, removeUnknown: string[] = []) => {
    let saved: Settings;
    let effects: Record<string, Applies>;
    try {
      ({ settings: saved, effects } = saveSettings(state.envPath, values, removeUnknown));
    } catch (e) {
      if (e instanceof SettingsRejected) return error(c, e.message);
      throw e;
    }
    resetSettings();
    const newSettings = merged(host().settings, saved, Object.keys(effects));
    let rebuilt = false;
    if (Object.values(effects).includes("rebuild")) {
      try {
        rebuilt = await host().reconfigure(newSettings);
      } catch (e) {
        // e.g. the current provider lost its key
        host().settings = newSettings;
        return c.json({ error: `Saved, but the agent couldn't be rebuilt: ${(e as Error).message}`, saved: true }, 409);
      }
    } else {
      host().settings = newSettings;
    }
    for (const [name, when] of Object.entries(effects)) if (when === "restart") state.pendingRestart.add(name);
    host().broadcast({ type: "settings_changed", keys: Object.keys(effects).sort(), restart_required: restartList(state) });
    return c.json({ ok: true, effects, rebuilt, restart_required: restartList(state), ...schemaPayload() });
  };

  app.patch(`${p}/settings`, async (c) => {
    const b = await body(c);
    const values = b.values ?? {};
    const remove = b.remove_unknown ?? [];
    if (typeof values !== "object" || Array.isArray(values) || !Array.isArray(remove)) {
      return error(c, 'Expected {"values": {...}, "remove_unknown": [...]}');
    }
    if (!Object.keys(values).length && !remove.length) return error(c, "Nothing to save.");
    return apply(c, values, remove.map(String));
  });

  // --- MCP connectors ----------------------------------------------------------

  const mcpPath = () => host().settings.mcp_config_path;

  const getMcp = (c: Context) => {
    const file = mcpPath();
    let data;
    try {
      data = readMcp(file);
    } catch (e) {
      return c.json({ path: file, servers: [], error: `Invalid JSON: ${(e as Error).message}` });
    }
    const servers = Object.entries(data.mcpServers).map(([name, server]) => {
      const tag: string | undefined = server.agent;
      const key = tag ?? "";
      let status: string;
      if (server.disabled) status = "off";
      else if (host().mcpErrors.has(key)) status = "error";
      else if (state.mcpLoaded.has(name)) status = "ok";
      else status = "restart"; // added or re-enabled since startup
      return {
        name,
        agent: tag ?? null,
        command: server.command ?? null,
        args: server.args ?? [],
        url: server.url ?? null,
        transport: server.transport ?? null,
        env_keys: Object.keys(server.env ?? {}).sort(), // values may be secrets
        disabled: Boolean(server.disabled),
        status,
        error: status === "error" ? (host().mcpErrors.get(key) ?? null) : null,
        tools: (host().mcpGroups.get(key) ?? []).length,
      };
    });
    return c.json({ path: file, enabled: host().settings.enable_mcp_tools, servers, helpers: HELPER_TAGS });
  };

  const mcpChanged = () => {
    state.pendingRestart.add("mcp_servers");
    host().broadcast({ type: "settings_changed", keys: ["mcp_servers"], restart_required: restartList(state) });
  };

  app.get(`${p}/mcp`, getMcp);

  app.put(`${p}/mcp/:name`, async (c) => {
    const name = c.req.param("name");
    if (!SERVER_NAME.test(name)) return error(c, "Server names may use letters, digits, - and _ (max 40).");
    const file = mcpPath();
    let data;
    try {
      data = readMcp(file);
      data.mcpServers[name] = cleanServer(await body(c), data.mcpServers[name] ?? {});
    } catch (e) {
      return error(c, (e as Error).message);
    }
    atomicJson(file, data);
    mcpChanged();
    return getMcp(c);
  });

  app.delete(`${p}/mcp/:name`, (c) => {
    const name = c.req.param("name");
    const file = mcpPath();
    let data;
    try {
      data = readMcp(file);
    } catch (e) {
      return error(c, (e as Error).message);
    }
    if (!(name in data.mcpServers)) return error(c, `No server named ${name}.`, 404);
    delete data.mcpServers[name];
    atomicJson(file, data);
    mcpChanged();
    return getMcp(c);
  });

  // --- connections (sign-ins and keys) ------------------------------------------

  const googleStatus = async (settings: Settings) => {
    const status: Record<string, unknown> = {
      client_file: existsSync(settings.google_credentials_path),
      client_path: settings.google_credentials_path,
      token: googleAuth.isConnected(settings),
      ok: false,
      error: null,
      scopes: googleAuth.SCOPES,
    };
    if (status.token) {
      try {
        await googleAuth.credentials(settings); // refreshes if expired, checks scopes
        status.ok = true;
      } catch (e) {
        status.error = (e as Error).message; // shown in the UI
      }
    }
    return status;
  };

  const getConnections = async (c: Context) => {
    const settings = host().settings;
    let google: Record<string, unknown>;
    try {
      google = await Promise.race([
        googleStatus(settings),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 15_000)),
      ]);
    } catch {
      google = { token: googleAuth.isConnected(settings), ok: false, error: "Google didn't answer in time." };
    }
    google.signing_in = state.googleSigningIn;
    const imapReady = Boolean(settings.mail_address && settings.mail_password);
    const mail = {
      backend: settings.mail_backend,
      address: settings.mail_address,
      password_set: Boolean(settings.mail_password),
      imap_host: settings.mail_imap_host,
      smtp_host: settings.mail_smtp_host,
      ready: settings.mail_backend === "gmail" ? Boolean(google.ok) : imapReady,
    };
    const keys = { openrouter: Boolean(settings.openrouter_api_key), groq: Boolean(settings.groq_api_key), tavily: Boolean(settings.tavily_api_key) };
    return c.json({ google, mail, keys });
  };

  app.get(`${p}/connections`, getConnections);

  /** Run the Google consent flow (luna-google-auth) on this machine. A
   * browser tab opens on the computer running luna-web; this request
   * finishes when you approve there (or after 5 minutes). */
  app.post(`${p}/connections/google`, async (c) => {
    if (state.googleSigningIn) return error(c, "A Google sign-in is already waiting in another browser tab.", 409);
    const settings = host().settings;
    if (!existsSync(settings.google_credentials_path)) {
      return error(
        c,
        `No OAuth client file at ${settings.google_credentials_path}. Download a 'Desktop app' ` +
          "OAuth client from Google Cloud Console there (see docs/google.md).",
      );
    }
    state.googleSigningIn = true;
    try {
      await Promise.race([
        googleAuth.authorize(settings),
        new Promise<never>((_, reject) => setTimeout(() => reject(Object.assign(new Error("timeout"), { timeout: true })), 300_000)),
      ]);
    } catch (e) {
      if ((e as { timeout?: boolean }).timeout) return error(c, "Sign-in timed out. Try again.", 504);
      return error(c, `Sign-in failed: ${(e as Error).message}`);
    } finally {
      state.googleSigningIn = false;
    }
    return getConnections(c);
  });

  app.delete(`${p}/connections/google`, (c) => {
    rmSync(host().settings.google_token_path, { force: true });
    return getConnections(c);
  });

  // --- model providers ---------------------------------------------------------

  const getProviders = (c: Context) => {
    const settings = host().settings;
    return c.json({
      providers: describeProviders(settings).map((info) => {
        const p = PROVIDERS[info.id];
        return { ...info, model_env: envName(p.modelField), key_env: p.keyField ? envName(p.keyField) : null };
      }),
      current: { provider: host().provider, model: host().model },
      default: { provider: settings.provider, model: defaultModel(getProvider(settings.provider), settings) },
      can_switch: host().canSwitch,
    });
  };

  app.get(`${p}/providers`, getProviders);

  app.get(`${p}/providers/:provider/models`, async (c) => {
    const provider = c.req.param("provider");
    try {
      return c.json({ provider, models: await sessionHooks.listModels(host().settings, provider) });
    } catch (e) {
      // offline, bad key, Ollama not running…
      return c.json({ provider, models: [], error: (e as Error).message });
    }
  });

  app.post(`${p}/providers/default`, async (c) => {
    const b = await body(c);
    const provider = String(b.provider ?? "").trim().toLowerCase();
    if (!(provider in PROVIDERS)) return error(c, `provider must be one of ${Object.keys(PROVIDERS).join(", ")}`);
    const model = String(b.model ?? "").trim();
    const values: Record<string, unknown> = { provider };
    if (model) values[PROVIDERS[provider].modelField] = model;
    let saved: Settings;
    try {
      ({ settings: saved } = saveSettings(state.envPath, values));
    } catch (e) {
      if (e instanceof SettingsRejected) return error(c, e.message);
      throw e;
    }
    resetSettings();
    host().settings = merged(host().settings, saved, Object.keys(values));
    if (b.apply) {
      try {
        await host().switch(provider, model);
      } catch (e) {
        // e.g. missing API key
        return error(c, `Saved as default, but couldn't switch now: ${(e as Error).message}`, 409);
      }
    }
    return getProviders(c);
  });

  // --- permissions -------------------------------------------------------------

  const toolRow = (name: string, owner: string, asks: boolean, auto: Set<string>) => {
    const risky = isRiskyToolName(name);
    const mode = auto.has(name) ? "auto" : asks ? "ask" : "free";
    return { name, owner, risky, mode, can_toggle: asks || risky || auto.has(name) };
  };

  /** Every tool of the main agent and each helper: does it ask first? mode
   * "ask" = pauses for your approval, "auto" = listed in LUNA_AUTO_APPROVE
   * (runs without asking), "free" = never changes anything. */
  app.get(`${p}/permissions`, (c) => {
    const settings = host().settings;
    const auto = new Set(settings.auto_approve);
    const mainMcp = new Set((host().mcpGroups.get("") ?? []).map((t) => t.name));
    const tools = agentToolNames(host().agent)
      .filter((name) => !name.startsWith("ask_") || name === "ask_user")
      .map((name) => toolRow(name, "main", mainMcp.has(name) && isRiskyToolName(name), auto));
    let specs: ReturnType<typeof getSubagentSpecs> = [];
    try {
      specs = getSubagentSpecs(settings, host().mcpGroups);
    } catch {
      // permissions view must still load
    }
    const helpers = specs.map((spec) => {
      const helper = spec.name.replace(/^ask_/, "");
      tools.push(...spec.tools.map((t) => toolRow(t.name, helper, Object.hasOwn(spec.interruptOn, t.name), auto)));
      return { name: helper, tools: spec.tools.length };
    });
    return c.json({ tools, helpers, auto_approve: settings.auto_approve, workspace_dirs: settings.workspace_dirs });
  });

  // --- stats -------------------------------------------------------------------

  /** Session count (scans every checkpoint), cached for SLOW_STATS_MS. */
  const slowStats = async () => {
    if (state.slowStats && performance.now() - state.slowStats[0] < SLOW_STATS_MS) return state.slowStats[1];
    const checkpointer = host().agent.checkpointer;
    let sessions: Record<string, unknown> | null = null;
    if (checkpointer) {
      try {
        const items = await listSessions(checkpointer as never);
        sessions = {
          count: items.filter((s) => !s.id.startsWith("routine-")).length,
          routine_threads: items.filter((s) => s.id.startsWith("routine-")).length,
          turns: items.reduce((n, s) => n + s.turns, 0),
          last: items[0]?.updated_at ?? null,
        };
      } catch {
        sessions = null; // stats are cosmetic
      }
    }
    let helperTools: Record<string, number> = {};
    try {
      helperTools = Object.fromEntries(getSubagentSpecs(host().settings, host().mcpGroups).map((s) => [s.name.replace(/^ask_/, ""), s.tools.length]));
    } catch {
      helperTools = {};
    }
    const data = { sessions, helper_tools: helperTools };
    state.slowStats = [performance.now(), data];
    return data;
  };

  /** Live numbers for the Overview (cheap; polled every few seconds). */
  app.get(`${p}/stats`, async (c) => {
    const h = host();
    const settings = h.settings;
    const store = h.routines;
    const routines = store?.list() ?? [];
    const memory = process.memoryUsage();
    return c.json({
      now: Date.now() / 1000,
      uptime: Math.round((Date.now() - h.startedAt) / 1000),
      pid: process.pid,
      process: { cpu_percent: state.sampler.cpuPercent(), rss: memory.rss, heap: memory.heapUsed, threads: null },
      system: system(),
      model: { provider: h.provider, model: h.model },
      tabs: h.listeners.size,
      memory: h.memory?.stats() ?? null,
      storage: {
        checkpoints: settings.memory_backend === "sqlite" ? size(settings.checkpoint_path) : null,
        longterm: h.memory ? size(settings.longterm_memory_path) : null,
        routines: store ? size(settings.routines_path) : null,
      },
      ...(await slowStats()),
      tools: {
        main: agentToolNames(h.agent).length,
        mcp_tools: [...h.mcpGroups.values()].reduce((n, g) => n + g.length, 0),
        mcp_errors: Object.fromEntries([...h.mcpErrors].map(([k, v]) => [k || "main", v])),
      },
      usage: { since_start: h.usage, ...(store ? store.usage(14) : { days: [], models: [] }) },
      routines: {
        total: routines.length,
        enabled: routines.filter((r) => r.enabled).length,
        running: h.scheduler ? [...h.scheduler.running].sort((a, b) => a - b) : [],
        scheduler: Boolean(h.scheduler?.active),
        recent: store?.recentRuns(8) ?? [],
      },
      restart_required: restartList(state),
    });
  });

  app.get(`${p}/insights`, (c) => c.json({ insights: host().routines?.insights() ?? {}, dashboard: readDashboard(state.dashboardPath) }));

  // --- dashboard preferences ---------------------------------------------------

  app.get(`${p}/dashboard`, (c) => c.json(readDashboard(state.dashboardPath)));

  app.put(`${p}/dashboard`, async (c) => {
    const prefs = cleanDashboard({ ...readDashboard(state.dashboardPath), ...(await body(c)) });
    atomicJson(state.dashboardPath, prefs);
    host().broadcast({ type: "dashboard", prefs });
    return c.json(prefs);
  });

  // --- routines ----------------------------------------------------------------

  const store = (): RoutineStore => {
    const s = host().routines;
    if (!s) throw new RoutineRefused("Routines are off (LUNA_ROUTINES_ENABLED=false).");
    return s;
  };

  const routinesPayload = () => {
    const h = host();
    const s = store();
    const running = h.scheduler?.running ?? new Set<number>();
    return {
      routines: s.list().map((r) => ({ ...r, running: running.has(r.id) })),
      builtins: Object.fromEntries(Object.entries(BUILTINS).map(([k, b]) => [k, { name: b.name, tool: b.tool, description: b.description, cron: b.cron }])),
      scheduler: Boolean(h.scheduler?.active),
      timezone: s.zone,
    };
  };

  const routineRoute = (handler: (c: Context) => Promise<Response> | Response) => async (c: Context) => {
    try {
      return await handler(c);
    } catch (e) {
      if (e instanceof RoutineRefused) return error(c, e.message, e.message.startsWith("No routine") ? 404 : 400);
      throw e;
    }
  };
  const routineId = (c: Context) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) throw new RoutineRefused(`No routine ${c.req.param("id")}.`);
    return id;
  };

  app.get(`${p}/routines`, routineRoute((c) => c.json(routinesPayload())));

  app.post(
    `${p}/routines`,
    routineRoute(async (c) => {
      const b = await body(c);
      store().add(String(b.name ?? ""), "agent", String(b.cron ?? ""), {
        prompt: String(b.prompt ?? ""),
        enabled: b.enabled === undefined ? true : Boolean(b.enabled),
        notify: b.notify === undefined ? true : Boolean(b.notify),
      });
      return c.json(routinesPayload(), 201);
    }),
  );

  app.patch(
    `${p}/routines/:id`,
    routineRoute(async (c) => {
      const b = await body(c);
      const changes = Object.fromEntries(["name", "prompt", "cron", "enabled", "notify"].filter((k) => k in b).map((k) => [k, b[k]]));
      store().update(routineId(c), changes);
      return c.json(routinesPayload());
    }),
  );

  app.delete(
    `${p}/routines/:id`,
    routineRoute((c) => {
      store().delete(routineId(c));
      return c.json(routinesPayload());
    }),
  );

  app.post(
    `${p}/routines/:id/run`,
    routineRoute(async (c) => {
      store();
      const scheduler = host().scheduler;
      if (!scheduler) return error(c, "The routine scheduler isn't running.", 409);
      try {
        const run = await scheduler.runNow(routineId(c));
        return c.json({ run, ...routinesPayload() });
      } catch (e) {
        if (e instanceof RoutineRefused) throw e;
        return error(c, (e as Error).message, 409);
      }
    }),
  );

  app.get(
    `${p}/routines/:id/runs`,
    routineRoute((c) => {
      const s = store();
      const id = routineId(c);
      s.get(id);
      return c.json({ runs: s.runs(id, 30) });
    }),
  );

  /** Explain a schedule: {"valid", "text", "next": [3 upcoming local times]}. */
  app.get(`${p}/cron`, (c) => {
    const expr = c.req.query("expr") ?? "";
    let cron;
    try {
      cron = parse(expr);
    } catch (e) {
      if (e instanceof CronError) return c.json({ valid: false, error: e.message });
      throw e;
    }
    const zone = host().routines?.zone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    let when = Date.now();
    const upcoming: string[] = [];
    for (let i = 0; i < 3; i++) {
      when = nextRun(cron, when, zone);
      upcoming.push(isoInZone(when, zone, "minutes"));
    }
    return c.json({ valid: true, expr: cron.expr, text: describe(cron.expr), next: upcoming });
  });
}

/** Server names that loaded at startup (for the connector status lights). */
export function loadedServers(host: AgentHost): Set<string> {
  const loaded = new Set<string>();
  try {
    const data = readMcp(host.settings.mcp_config_path);
    for (const [name, server] of Object.entries(data.mcpServers)) {
      if (!server.disabled && !host.mcpErrors.has(server.agent ?? "") && host.settings.enable_mcp_tools) loaded.add(name);
    }
  } catch {
    // unreadable config: nothing loaded
  }
  return loaded;
}

