/**
 * luna-web — serve the browser UI and bridge it to the agent over a WebSocket.
 *
 * BEGINNER MAP
 * ------------
 * One Node HTTP server does everything:
 *
 *   /ws            the chat socket (ws library): one tab = one Session (session.ts)
 *   /api/health    liveness plus the current provider and model
 *   /api/tts       {"text"} → WAV from Piper (voice/tts.ts), so the browser can
 *                  analyse the real audio and the core moves with Luna's voice
 *   /api/stt       16 kHz WAV of one utterance → {"text"} from Whisper
 *                  (voice/stt.ts); the browser does voice activity detection
 *                  and the "Hey Luna" wake word
 *   /api/control/* the Control Center (control.ts)
 *   /              the built frontend from web/dist (`pnpm build` in web/)
 *
 * HTTP routes are a Hono app; the socket is upgraded next to it. The JSON
 * on the socket is the same as the Python version's, so web/ didn't change
 * (protocol: docs/web-ui.md, types: web/src/lib/protocol.ts).
 *
 * Routines (routines/) run in the background while the server runs; each
 * result goes to every tab as {"type": "routine_result"}, and saved settings
 * as {"type": "settings_changed"}.
 *
 * Telegram (channels/): with LUNA_TELEGRAM_BOT_TOKEN set, a bot runs
 * alongside the tabs on the same AgentHost, so you can message Luna (text,
 * voice notes, photos, files) and approve her actions from your phone.
 *
 * SECURITY: the agent can write files and (after approval) run commands, and
 * any web page you visit could try to open ws://127.0.0.1:8765. So the socket
 * only accepts browsers whose Origin is this server itself or one listed in
 * LUNA_WEB_ALLOWED_ORIGINS, and the server listens on 127.0.0.1 by default.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { parseArgs } from "node:util";

import { getRequestListener } from "@hono/node-server";
import { type Context, Hono } from "hono";
import { WebSocketServer, type WebSocket } from "ws";

import { assembleAgent, loadMcpGroups } from "../agent/builder.ts";
import { type LongTermStore, openLongtermStore } from "../agent/longterm.ts";
import { closeCheckpointers, createCheckpointer } from "../agent/memory.ts";
import { defaultModel, describeProviders, getProvider, makeModel } from "../agent/providers.ts";
import { agentToolNames, type LunaAgent } from "../agent/types.ts";
import { startTelegram } from "../channels/index.ts";
import { DEFAULT_DASHBOARD_PATH, DEFAULT_ENV_PATH, DEFAULT_TELEGRAM_STATE_PATH, getSettings, PROJECT_ROOT, type Settings } from "../config/settings.ts";
import { closeMcpClients } from "../mcp/loader.ts";
import { type Result } from "../routines/builtin.ts";
import { runAgentRoutine } from "../routines/agent.ts";
import { makeExecutor, RoutineScheduler } from "../routines/scheduler.ts";
import { type Routine, RoutineStore } from "../routines/store.ts";
import type { AnyTool } from "../tools/registry.ts";
import { localZone, validZone } from "../util/zoned.ts";
import { createStt, type SpeechToText, wavToPcm } from "../voice/stt.ts";
import { createTts, MAX_TEXT_CHARS, type TextToSpeech } from "../voice/tts.ts";
import { controlRoutes, type ControlState, loadedServers, ProcessSampler } from "./control.ts";
import { isModelUpdate } from "./events.ts";
import { AgentHost, type Rebuild, Session } from "./session.ts";
import * as window from "./window.ts";

// `pnpm build` in web/ writes the frontend here.
export const DIST_DIR = path.join(PROJECT_ROOT, "web", "dist");

const NO_BUILD_PAGE = `<!doctype html><meta charset="utf-8"><title>Luna</title>
<body style="background:#02060c;color:#7fe9ff;font-family:monospace;padding:3rem">
<h1>LUNA backend online</h1>
<p>The frontend isn't built yet. Either:</p>
<pre>pnpm install &amp;&amp; cd web &amp;&amp; pnpm dev     # then open http://localhost:5173
cd web &amp;&amp; pnpm build                    # then reload this page</pre>
</body>`;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
  ".jpg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon", ".woff2": "font/woff2", ".woff": "font/woff",
  ".wasm": "application/wasm", ".webmanifest": "application/manifest+json", ".txt": "text/plain; charset=utf-8",
  ".map": "application/json", ".onnx": "application/octet-stream", ".bin": "application/octet-stream",
};

/**
 * May a request from `origin` talk to this server (reached as `host`)?
 * Browsers always send Origin on a WebSocket; a missing one means a
 * non-browser client (a script on this machine), which is allowed.
 */
export function originAllowed(origin: string | null | undefined, host: string | null | undefined, allowed: string[]): boolean {
  if (!origin) return true;
  const clean = origin.replace(/\/+$/, "");
  if (allowed.includes(clean)) return true;
  try {
    return Boolean(host) && new URL(clean).host === host;
  } catch {
    return false;
  }
}

export interface AppOptions {
  /** Skip building the real agent (tests pass a fake one). */
  agent?: LunaAgent;
  settings?: Settings;
  rebuild?: Rebuild | null;
  ttsEngine?: TextToSpeech | null;
  sttEngine?: SpeechToText | null;
  memoryStore?: LongTermStore | null;
  routineStore?: RoutineStore | null;
  mcpGroups?: Map<string, AnyTool[]>;
  /** Where the Control Center saves (default: the project's .env and data/dashboard.json). */
  envPath?: string;
  dashboardPath?: string;
  /** The Telegram bot's state file (default data/telegram.json). */
  telegramStatePath?: string;
  /** The built frontend (default web/dist). */
  distDir?: string;
}

export interface LunaServer {
  host: AgentHost;
  server: Server;
  /** http://127.0.0.1:<port> once listening. */
  url: string;
  close(): Promise<void>;
}

/** buildAgent, but keeping the parts so the model can be swapped later. */
async function buildHost(settings: Settings): Promise<AgentHost> {
  const model = makeModel(settings); // fails fast if the startup provider has no key
  const checkpointer = await createCheckpointer(settings.memory_backend, settings.checkpoint_path);
  const mcpErrors = new Map<string, string>();
  const mcpGroups = await loadMcpGroups(settings, mcpErrors);
  const memory = openLongtermStore(settings);
  const rebuild: Rebuild = async (provider, modelName) => {
    // host.settings, not settings: the Control Center may have saved new ones.
    const current = host.settings;
    return (await assembleAgent(current, makeModel(current, provider, modelName), checkpointer, mcpGroups, memory)).agent;
  };
  const { agent } = await assembleAgent(settings, model, checkpointer, mcpGroups, memory);
  const host = new AgentHost(agent, settings, settings.provider, defaultModel(getProvider(settings.provider), settings), rebuild);
  host.memory = memory;
  host.mcpGroups = mcpGroups;
  host.mcpErrors = mcpErrors;
  return host;
}

/** LUNA_TIMEZONE, else the machine's local timezone. */
function timezone(settings: Settings): string {
  if (!settings.timezone) return localZone();
  if (validZone(settings.timezone)) return settings.timezone;
  console.error(`Warning: unknown LUNA_TIMEZONE '${settings.timezone}'; using local time.`);
  return localZone();
}

/** Attach the routines store and start the scheduler (if routines are on). */
function startRoutines(host: AgentHost, store: RoutineStore | null): void {
  host.routines = store;
  if (!store) return;
  store.seedBuiltins();
  const tools = () => Object.fromEntries([...host.mcpGroups.values()].flat().map((t) => [t.name, t]));
  const runAgent = async (routine: Routine, signal: AbortSignal): Promise<Result> => {
    const counts = { model_calls: 0, tool_calls: 0 };
    const count = (_ns: string[], mode: string, payload: any) => {
      if (mode !== "updates" || !payload || typeof payload !== "object") return;
      if (isModelUpdate(mode, payload)) {
        counts.model_calls += 1;
        for (const m of payload.model_request?.messages ?? []) counts.tool_calls += m.tool_calls?.length ?? 0;
      }
    };
    try {
      const result = await runAgentRoutine(host.agent, routine, host.settings, count, signal);
      host.recordUsage({ runs: 1, errors: result[0] === "error" ? 1 : 0, ...counts });
      return result;
    } catch (error) {
      host.recordUsage({ runs: 1, errors: 1, ...counts });
      throw error;
    }
  };
  host.scheduler = new RoutineScheduler(store, makeExecutor(tools, runAgent, store), (e) => host.broadcast(e as never));
  host.scheduler.start();
}

function hello(host: AgentHost): Record<string, unknown> {
  const tools = agentToolNames(host.agent);
  return {
    type: "hello",
    provider: host.provider,
    model: host.model,
    providers: describeProviders(host.settings),
    can_switch: host.canSwitch,
    tools,
    helpers: tools.filter((t) => t.startsWith("ask_") && t !== "ask_user").map((t) => t.slice(4)),
    budget: host.settings.task_budget,
    // "piper": fetch audio from /api/tts; "browser": use speechSynthesis
    tts: host.tts ? "piper" : "browser",
    // "whisper": send utterances to /api/stt (enables the wake word); "browser": Chrome/Edge recognition
    stt: host.stt ? "whisper" : "browser",
    // Long-term memory panel available
    memory: host.memory !== null,
  };
}

function staticFile(dist: string, urlPath: string): { body: Buffer; type: string } | null {
  let rel = decodeURIComponent(urlPath.split("?")[0]);
  if (rel.endsWith("/")) rel += "index.html";
  const file = path.resolve(dist, "." + rel);
  if (file !== dist && !file.startsWith(dist + path.sep)) return null; // no ../ escapes
  try {
    if (!statSync(file).isFile()) return null;
  } catch {
    return null;
  }
  return { body: readFileSync(file), type: MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream" };
}

/** Build the app, start its background parts and listen. */
export async function startServer(options: AppOptions = {}, port = 0, hostname = "127.0.0.1"): Promise<LunaServer> {
  const settings = options.settings ?? getSettings();
  const owned = options.agent === undefined; // we built (and must close) the real parts
  let host: AgentHost;
  let routines: RoutineStore | null;
  if (!owned) {
    host = new AgentHost(options.agent!, settings, settings.provider, defaultModel(getProvider(settings.provider), settings), options.rebuild ?? null);
    host.tts = options.ttsEngine ?? null;
    host.stt = options.sttEngine ?? null;
    host.memory = options.memoryStore ?? null;
    host.mcpGroups = options.mcpGroups ?? new Map();
    routines = options.routineStore ?? null;
  } else {
    host = await buildHost(settings);
    host.tts = createTts(settings);
    host.stt = createStt(settings);
    routines = settings.routines_enabled ? new RoutineStore(settings.routines_path, timezone(settings)) : null;
  }

  const allowed = (origin: string | null | undefined, hostHeader: string | null | undefined) =>
    originAllowed(origin, hostHeader, host.settings.web_allowed_origins);
  const state: ControlState = {
    host,
    envPath: options.envPath ?? DEFAULT_ENV_PATH,
    dashboardPath: options.dashboardPath ?? DEFAULT_DASHBOARD_PATH,
    pendingRestart: new Set(),
    googleSigningIn: false,
    sampler: new ProcessSampler(),
    slowStats: null,
    mcpLoaded: loadedServers(host),
    originAllowed: (c: Context) => allowed(c.req.header("origin"), c.req.header("host")),
  };

  // --- HTTP routes ----------------------------------------------------------------
  const app = new Hono();
  app.get("/api/health", (c) => c.json({ status: "ok", provider: host.provider, model: host.model }));

  app.post("/api/tts", async (c) => {
    if (!state.originAllowed(c)) return c.json({ error: "origin not allowed" }, 403);
    if (!host.tts) return c.json({ error: "server speech is off (LUNA_TTS_ENGINE=browser)" }, 404);
    let text = "";
    try {
      const body = await c.req.json();
      text = body && typeof body === "object" ? String(body.text ?? "").trim() : "";
    } catch {
      text = "";
    }
    if (!text || [...text].length > MAX_TEXT_CHARS) return c.json({ error: `text must be 1-${MAX_TEXT_CHARS} characters` }, 400);
    try {
      const audio = await host.tts.synthesize(text);
      return c.body(new Uint8Array(audio), 200, { "Content-Type": "audio/wav", "Cache-Control": "no-store" });
    } catch (error) {
      // the browser falls back to its own voice
      return c.json({ error: (error as Error).message }, 500);
    }
  });

  app.post("/api/stt", async (c) => {
    if (!state.originAllowed(c)) return c.json({ error: "origin not allowed" }, 403);
    if (!host.stt) return c.json({ error: "server speech recognition is off (LUNA_STT_ENGINE=browser)" }, 404);
    let audio: { pcm: Buffer; samples: number };
    try {
      audio = wavToPcm(Buffer.from(await c.req.arrayBuffer()));
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
    try {
      return c.json({ text: await host.stt.transcribe(audio.pcm, audio.samples) });
    } catch (error) {
      return c.json({ error: (error as Error).message }, 500);
    }
  });

  controlRoutes(app, state);

  const dist = path.resolve(options.distDir ?? DIST_DIR);
  const built = existsSync(path.join(dist, "index.html"));
  app.get("*", (c) => {
    if (!built) return c.html(NO_BUILD_PAGE);
    const file = staticFile(dist, new URL(c.req.url).pathname) ?? staticFile(dist, "/index.html");
    return file ? c.body(new Uint8Array(file.body), 200, { "Content-Type": file.type }) : c.notFound();
  });

  // --- the chat socket ------------------------------------------------------------
  const server = createServer(getRequestListener(app.fetch));
  const sockets = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req: IncomingMessage, socket, head) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (pathname !== "/ws" || !allowed(req.headers.origin, req.headers.host)) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); // policy violation
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(req, socket, head, (ws) => connect(ws));
  });

  const connect = (ws: WebSocket) => {
    const send = (event: Record<string, unknown>) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event));
    };
    const session = new Session(host, send);
    send(hello(host));
    host.listeners.add(send);
    // One message at a time, in order (a run itself continues in the background).
    let chain: Promise<void> = session.sync().catch((error) => send({ type: "error", message: (error as Error).message }));
    ws.on("message", (data) => {
      chain = chain.then(async () => {
        let msg: unknown;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          return send({ type: "error", message: "Messages must be JSON." });
        }
        try {
          await session.handle(msg);
        } catch (error) {
          send({ type: "error", message: (error as Error).message || String(error) });
        }
      });
    });
    ws.on("close", () => host.listeners.delete(send));
  };

  // --- background parts -------------------------------------------------------------
  startRoutines(host, routines);
  host.telegram = await startTelegram(host, options.telegramStatePath ?? DEFAULT_TELEGRAM_STATE_PATH);
  // Load the voice models in the background so startup stays fast.
  for (const engine of [host.tts, host.stt]) if (engine) void engine.warmUp();

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, hostname, () => resolve());
  });
  const address = server.address() as AddressInfo;
  const url = window.baseUrl(hostname, address.port);

  let closing: Promise<void> | null = null;
  const close = () => {
    closing ??= (async () => {
      await host.telegram?.stop();
      await host.scheduler?.stop();
      for (const client of sockets.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections?.();
      if (owned) {
        host.routines?.close();
        await closeCheckpointers();
        host.memory?.close();
        await closeMcpClients();
      }
    })();
    return closing;
  };
  return { host, server, url, close };
}

/** Replaceable in tests (like monkeypatching window / uvicorn in Python). */
export const mainHooks = {
  window,
  startServer,
  getSettings,
  exit: (code: number) => process.exit(code),
};

/**
 * Entry point for `luna-web`: serve the app and open it in its own window
 * (web/window.ts). If Luna already runs, just open a window.
 */
export async function main(argv: string[] = process.argv.slice(2)): Promise<LunaServer | null> {
  const { values: args } = parseArgs({
    args: argv,
    options: { "no-window": { type: "boolean", default: false }, "install-desktop": { type: "boolean", default: false }, help: { type: "boolean", short: "h" } },
  });
  const w = mainHooks.window;
  if (args.help) {
    console.log("usage: luna-web [--no-window] [--install-desktop]\n\nLuna's web UI and voice assistant.\n\n  --no-window        only run the server; don't open the app window\n  --install-desktop  add Luna to your applications menu (Linux .desktop entry) and exit");
    return null;
  }
  if (args["install-desktop"]) {
    console.log(`Added Luna to the applications menu: ${w.installDesktopEntry()}`);
    return null;
  }

  const settings = mainHooks.getSettings();
  const base = w.baseUrl(settings.web_host, settings.web_port);
  const url = w.appUrl(settings.web_host, settings.web_port);
  const openIt = settings.web_open_window && !args["no-window"];
  const browser = openIt ? w.findBrowser(settings.web_browser) : null;

  if (await w.serverRunning(base)) {
    // Started from the launcher while already running: act like an app icon.
    if (openIt) w.openWindow(url, browser);
    console.log(`Luna is already running → ${base}`);
    return null;
  }

  console.log(`LUNA web UI → ${base}` + (openIt ? " (opening the app window when ready)" : ""));
  const running = await mainHooks.startServer({ settings }, settings.web_port, settings.web_host);
  const stop = async () => {
    await running.close();
    mainHooks.exit(0);
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
  if (openIt) {
    void (async () => {
      if (!(await w.waitForServer(base))) return;
      const proc = w.openWindow(url, browser);
      if (proc && settings.web_close_with_window) {
        await w.watchWindow(proc, () => {
          console.log("Luna window closed: stopping.");
          void stop();
        });
      }
    })();
  }
  return running;
}
