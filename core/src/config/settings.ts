/**
 * Luna settings — one place for all configuration knobs.
 *
 * BEGINNER MAP
 * ------------
 * Hard-coding a model name in ten files is painful to change.
 * Instead, Settings holds defaults, and you can override them with
 * environment variables that start with LUNA_:
 *
 *   export LUNA_MODEL_NAME=nvidia/nemotron-3-ultra-550b-a55b
 *   export LUNA_OPENROUTER_API_KEY=sk-or-...
 *   export LUNA_MEMORY_BACKEND=memory
 *   export LUNA_ENABLE_MCP_TOOLS=false
 *
 * Or put the same keys in a `.env` file in the project root
 * (it is found no matter which directory you run `luna` from).
 * See env.example for a full list.
 *
 * Order, lowest to highest: defaults → `.env` → real environment → the
 * `overrides` passed to loadSettings() (tests use those).
 *
 * Field names stay snake_case (model_name, not modelName): they are also the
 * names the Control Center sends over HTTP (config/schema.ts), and
 * `model_name` ↔ `LUNA_MODEL_NAME` is a plain upper-case.
 *
 * getSettings() is cached: the first call reads env/defaults; later calls
 * reuse the same object. resetSettings() forgets it (after a save).
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readEnv } from "./envfile.ts";

/** The repo root: the folder that holds core/ (found from this file). */
function findProjectRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(path.join(dir, "core", "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return process.cwd();
    dir = parent;
  }
}

export const PROJECT_ROOT = findProjectRoot();
const p = (...parts: string[]) => path.join(PROJECT_ROOT, ...parts);
export const DEFAULT_MCP_CONFIG = p("config", "mcp_servers.json");
// A new file: the Python checkpoints (luna_memory.sqlite) can't be read from
// TypeScript, so old threads stay behind (DECISIONS.md D41).
export const DEFAULT_CHECKPOINT_PATH = p("data", "luna_checkpoints.sqlite");
export const DEFAULT_LONGTERM_PATH = p("data", "luna_longterm.sqlite");
export const DEFAULT_WORKSPACE = p("workspace");
export const DEFAULT_VOICES_DIR = p("data", "voices");
export const DEFAULT_STT_DIR = p("data", "models", "whisper");
export const DEFAULT_PERSONA_PATH = p("config", "persona.md");
export const DEFAULT_GOOGLE_DIR = p("data", "google");
export const DEFAULT_ROUTINES_PATH = p("data", "luna_routines.sqlite");
export const DEFAULT_DASHBOARD_PATH = p("data", "dashboard.json");
export const DEFAULT_ENV_PATH = p(".env");
export const DEFAULT_TELEGRAM_STATE_PATH = p("data", "telegram.json");

/** bool / int / float / path / list / str — drives parsing and the Control Center forms. */
export type FieldKind = "str" | "int" | "float" | "bool" | "path" | "list";

export interface FieldSpec {
  kind: FieldKind;
  /** The value when nothing sets it (a function = a fresh value each time). */
  default: unknown | (() => unknown);
  description?: string;
  /** May be null (Python's `str | None`). */
  optional?: boolean;
  /** list fields: each item is an int (telegram_allowed_users). */
  intItems?: boolean;
  /** Normalise or refuse a parsed value (throw an Error with the reason). */
  validate?: (value: any) => unknown;
}

function oneOf(field: string, choices: string[]) {
  const quoted = choices.map((c) => `'${c}'`);
  const said = quoted.length === 2 ? quoted.join(" or ") : `${quoted.slice(0, -1).join(", ")} or ${quoted.at(-1)}`;
  return (value: string) => {
    const v = value.trim().toLowerCase();
    if (!choices.includes(v)) throw new Error(`${field} must be ${said}`);
    return v;
  };
}

function expandHome(value: string): string {
  return value === "~" || value.startsWith("~/") ? path.join(homedir(), value.slice(1)) : value;
}

/** Every setting, in the same order as the Python Settings class. */
export const FIELDS = {
  // --- LLM (the brain) ---
  // Which API serves the model at startup; the web UI can switch later.
  // All three speak the OpenAI API (see agent/providers.ts).
  provider: { kind: "str", default: "openrouter", description: "'openrouter', 'groq' or 'ollama'", validate: oneOf("provider", ["openrouter", "groq", "ollama"]) },
  model_name: { kind: "str", default: "nvidia/nemotron-3-ultra-550b-a55b", description: "OpenRouter model slug" },
  openrouter_api_key: { kind: "str", default: null, optional: true },
  groq_api_key: { kind: "str", default: null, optional: true },
  groq_model: { kind: "str", default: "openai/gpt-oss-120b", description: "Groq model id (see the model list in the Control Center)" },
  // Ollama (local, no key). Its OpenAI-compatible endpoint ends in /v1.
  ollama_base_url: { kind: "str", default: "http://localhost:11434/v1", description: "Ollama /v1 URL" },
  ollama_model: { kind: "str", default: "qwen3:8b", description: "Ollama model tag (must support tools)" },
  model_max_retries: {
    kind: "int",
    default: 1,
    description: "How often a failed model request (rate limit, network) is retried. Each retry is another API request.",
  },
  model_vision: {
    kind: "bool",
    default: false,
    description: "The model can see images: photos sent over Telegram go to it as images. Off = they are only saved to the workspace",
  },
  system_prompt: {
    kind: "str",
    default:
      "You are Luna, a helpful assistant. " +
      "Use tools when they help you answer accurately, " +
      "and remember prior turns in this conversation. " +
      "Every model call costs an API request, so be economical: answer " +
      "directly from what you know when you can, and when you need several " +
      "independent tools, call them all in the same step. " +
      "Do quick things yourself; hand bigger self-contained jobs to your " +
      "ask_* helper tools, giving them every detail they need in one call. " +
      "Ask the user only when you truly cannot proceed without them.",
    description: "Luna's role. The persona settings below are added to it (see agent/persona.ts)",
  },

  // --- Persona (how Luna talks, who she talks to; see agent/persona.ts) ---
  response_style: { kind: "str", default: "concise", description: "'concise' (one or two spoken sentences) or 'detailed'", validate: oneOf("response_style", ["concise", "detailed"]) },
  user_title: { kind: "str", default: "Sir", description: "How Luna addresses you, e.g. 'Sir', 'Ma'am', 'Boss'. Empty = not used" },
  user_name: { kind: "str", default: null, optional: true, description: "Your name (optional)" },
  user_location: { kind: "str", default: null, optional: true, description: "Default place for weather / local questions, e.g. 'Agra, India'" },
  units: { kind: "str", default: "metric", description: "'metric' or 'imperial'", validate: oneOf("units", ["metric", "imperial"]) },
  timezone: { kind: "str", default: null, optional: true, description: "Your IANA timezone, e.g. 'Asia/Kolkata' (used for the local time)" },
  persona_path: { kind: "path", default: DEFAULT_PERSONA_PATH, optional: true, description: "Optional Markdown file with extra instructions for Luna" },

  // --- Loop limits (stop runaway think → tool → think loops) ---
  // Defaults are kept low on purpose: every model call is one API request,
  // and free LLM tiers run out fast (see DECISIONS.md D25).
  max_model_calls: { kind: "int", default: 10, description: "Max model calls per user message; the run then ends cleanly" },
  max_tool_calls: { kind: "int", default: 20, description: "Max tool calls per user message; extra calls are refused" },
  task_budget: { kind: "int", default: 30, description: "Max model calls for one user message across the main agent AND all subagents together" },

  // --- Memory (the notebook) ---
  memory_backend: { kind: "str", default: "sqlite", description: "'sqlite' (saved to disk) or 'memory' (RAM only)" },
  checkpoint_path: { kind: "path", default: DEFAULT_CHECKPOINT_PATH, description: "Where to store the SQLite memory file" },
  summary_trigger_tokens: {
    kind: "int",
    default: 12000,
    description: "Summarize older messages once a thread's history passes this many tokens (keeps cost and context size bounded). 0 disables.",
  },
  summary_keep_tokens: {
    kind: "int",
    default: 4000,
    description:
      "How many tokens of recent messages to keep word-for-word after summarizing. Kept well below summary_trigger_tokens so one summary buys many turns instead of re-summarizing on every model call.",
  },

  // --- Long-term memory (across threads; see agent/longterm.ts) ---
  enable_longterm_memory: { kind: "bool", default: true, description: "Remember facts about you across threads (you approve every change)" },
  longterm_memory_path: { kind: "path", default: DEFAULT_LONGTERM_PATH, description: "SQLite file for long-term memory (separate from thread checkpoints)" },
  memory_recall_limit: { kind: "int", default: 5, description: "Keyword matches shown to Luna per message, besides pinned memories" },
  memory_prompt_chars: { kind: "int", default: 1500, description: "Max characters of memories added to the system prompt" },
  memory_max_suggestions: { kind: "int", default: 3, description: "Max memory suggestions Luna may make for one message" },

  // --- Tools ---
  // Tavily web search (https://app.tavily.com). Unset = no researcher subagent.
  tavily_api_key: { kind: "str", default: null, optional: true },
  mcp_config_path: { kind: "path", default: DEFAULT_MCP_CONFIG, description: "JSON file listing MCP servers to connect" },
  enable_builtin_tools: { kind: "bool", default: true, description: "Load calculator / time / ask_user tools from this repo" },
  enable_mcp_tools: { kind: "bool", default: true, description: "Connect to MCP servers from mcp_servers.json" },

  // --- Mail (servers/mail.ts, used by ask_assistant; docs/mail.md) ---
  // Read by the mail MCP server itself: stdio servers don't inherit Luna's env.
  // gmail = Gmail API with the Google sign-in (luna-google-auth);
  // imap = IMAP/SMTP with an app password (the LUNA_MAIL_* below).
  mail_backend: { kind: "str", default: "gmail", description: "'gmail' or 'imap'", validate: oneOf("mail_backend", ["gmail", "imap"]) },
  mail_address: { kind: "str", default: null, optional: true, description: "Your email address (sender of Luna's mail)" },
  mail_password: { kind: "str", default: null, optional: true }, // an app password, not your login password
  mail_username: { kind: "str", default: null, optional: true, description: "IMAP/SMTP login if not the address" },
  mail_imap_host: { kind: "str", default: "imap.gmail.com", description: "IMAP server (reading)" },
  mail_imap_port: { kind: "int", default: 993, description: "IMAP over SSL port" },
  mail_smtp_host: { kind: "str", default: "smtp.gmail.com", description: "SMTP server (sending)" },
  mail_smtp_port: { kind: "int", default: 465, description: "465 = SSL, anything else = STARTTLS (e.g. 587)" },
  mail_max_body_chars: { kind: "int", default: 4000, description: "Longer email bodies are cut before they reach the model" },

  // --- Google: Gmail, Calendar, Tasks sync (integrations/google.ts; docs/google.md) ---
  google_credentials_path: { kind: "path", default: path.join(DEFAULT_GOOGLE_DIR, "credentials.json"), description: "OAuth client file (Desktop app) downloaded from Google Cloud" },
  google_token_path: { kind: "path", default: path.join(DEFAULT_GOOGLE_DIR, "token.json"), description: "Saved Google sign-in (created by the auth command)" },
  google_calendar_id: { kind: "str", default: "primary", description: "Calendar the assistant uses" },
  google_tasklist_id: { kind: "str", default: "@default", description: "Google Tasks list the local to-dos sync with" },
  tasks_google_sync: { kind: "bool", default: true, description: "Two-way sync of the local to-dos (LUNA_TASKS_PATH) with Google Tasks when signed in" },

  // --- Files / coding sandbox ---
  workspace_dirs: {
    kind: "list",
    default: () => [DEFAULT_WORKSPACE],
    description: "Comma-separated folders the files and coder helpers may touch. Relative paths in tool calls resolve against the first one.",
    // Relative entries are relative to the project root, like other paths here.
    validate: (dirs: string[]) => dirs.map((d) => path.resolve(PROJECT_ROOT, expandHome(d))),
  },
  auto_approve: {
    kind: "list",
    default: () => [],
    description: "Comma-separated tool names that run WITHOUT asking you first, e.g. 'write_file'. Leave empty to approve every risky action.",
  },

  // --- Web UI (luna-web) ---
  web_host: { kind: "str", default: "127.0.0.1", description: "Address the web server listens on (keep it local: it can run tools)" },
  web_port: { kind: "int", default: 8765, description: "Port for the web server" },
  web_allowed_origins: {
    kind: "list",
    default: () => ["http://localhost:5173", "http://127.0.0.1:5173"],
    description: "Comma-separated browser origins allowed to open the WebSocket, besides the server's own address. Default = the Vite dev server.",
    validate: (origins: string[]) => origins.map((o) => o.replace(/\/+$/, "")),
  },
  // App window (web/window.ts): luna-web opens the UI like a desktop app.
  web_open_window: { kind: "bool", default: true, description: "Open Luna in its own app window when luna-web starts (--no-window skips it once)" },
  web_close_with_window: { kind: "bool", default: true, description: "Stop luna-web when the app window is closed, like quitting an app" },
  web_browser: {
    kind: "str",
    default: null,
    optional: true,
    description: "Chromium-family browser for the app window (command or path). Empty = the first of Chrome, Chromium, Edge, Brave found",
  },

  // --- Voice output (web UI) ---
  tts_engine: { kind: "str", default: "piper", description: "'piper' (local neural voice, core follows the real audio) or 'browser'", validate: oneOf("tts_engine", ["piper", "browser"]) },
  tts_voice: { kind: "str", default: "en_US-lessac-medium", description: "Piper voice name, downloaded once into tts_voices_dir" },
  tts_voices_dir: { kind: "path", default: DEFAULT_VOICES_DIR, description: "Where Piper voices are kept" },
  tts_length_scale: { kind: "float", default: 0.95, description: "Piper speaking pace: < 1 faster, > 1 slower" },

  // --- Voice input (web UI) ---
  stt_engine: {
    kind: "str",
    default: "whisper",
    description: "'whisper' (local, any browser, enables the 'Hey Luna' wake word) or 'browser' (Chrome/Edge recognition, no wake word)",
    validate: oneOf("stt_engine", ["whisper", "browser"]),
  },
  stt_model: { kind: "str", default: "base.en", description: "Whisper model: tiny.en (fastest), base.en, small.en (most accurate)" },
  stt_models_dir: { kind: "path", default: DEFAULT_STT_DIR, description: "Where Whisper models are kept (downloaded once)" },
  stt_threads: { kind: "int", default: 4, description: "CPU threads for Whisper" },

  // --- Routines (routines/; docs/control-center.md) ---
  routines_enabled: { kind: "bool", default: true, description: "Run scheduled routines while luna-web is running" },
  routines_path: { kind: "path", default: DEFAULT_ROUTINES_PATH, description: "SQLite file for routines, their runs and API usage counters" },

  // --- Messaging (channels/; docs/messaging.md) ---
  telegram_bot_token: { kind: "str", default: null, optional: true }, // from @BotFather; unset = off
  telegram_allowed_users: {
    kind: "list",
    intItems: true,
    default: () => [],
    description: "Comma-separated Telegram user ids that may use the bot. Empty = nobody (the bot replies with your id so you can add it)",
  },
  telegram_voice_replies: { kind: "bool", default: true, description: "Answer a voice note with a voice note too (needs Piper, LUNA_TTS_ENGINE=piper)" },
  telegram_routine_alerts: { kind: "bool", default: true, description: "Send routine results (with notifications on) to the allowed Telegram users" },
} satisfies Record<string, FieldSpec>;

export type FieldName = keyof typeof FIELDS;
export const FIELD_NAMES = Object.keys(FIELDS) as FieldName[];

/** All runtime options. Same names as the LUNA_* variables, lower-cased. */
export interface Settings {
  provider: string;
  model_name: string;
  openrouter_api_key: string | null;
  groq_api_key: string | null;
  groq_model: string;
  ollama_base_url: string;
  ollama_model: string;
  model_max_retries: number;
  model_vision: boolean;
  system_prompt: string;
  response_style: string;
  user_title: string;
  user_name: string | null;
  user_location: string | null;
  units: string;
  timezone: string | null;
  persona_path: string | null;
  max_model_calls: number;
  max_tool_calls: number;
  task_budget: number;
  memory_backend: string;
  checkpoint_path: string;
  summary_trigger_tokens: number;
  summary_keep_tokens: number;
  enable_longterm_memory: boolean;
  longterm_memory_path: string;
  memory_recall_limit: number;
  memory_prompt_chars: number;
  memory_max_suggestions: number;
  tavily_api_key: string | null;
  mcp_config_path: string;
  enable_builtin_tools: boolean;
  enable_mcp_tools: boolean;
  mail_backend: string;
  mail_address: string | null;
  mail_password: string | null;
  mail_username: string | null;
  mail_imap_host: string;
  mail_imap_port: number;
  mail_smtp_host: string;
  mail_smtp_port: number;
  mail_max_body_chars: number;
  google_credentials_path: string;
  google_token_path: string;
  google_calendar_id: string;
  google_tasklist_id: string;
  tasks_google_sync: boolean;
  workspace_dirs: string[];
  auto_approve: string[];
  web_host: string;
  web_port: number;
  web_allowed_origins: string[];
  web_open_window: boolean;
  web_close_with_window: boolean;
  web_browser: string | null;
  tts_engine: string;
  tts_voice: string;
  tts_voices_dir: string;
  tts_length_scale: number;
  stt_engine: string;
  stt_model: string;
  stt_models_dir: string;
  stt_threads: number;
  routines_enabled: boolean;
  routines_path: string;
  telegram_bot_token: string | null;
  telegram_allowed_users: number[];
  telegram_voice_replies: boolean;
  telegram_routine_alerts: boolean;
}

/** One refused value: which field, and why. */
export interface SettingsIssue {
  field: FieldName;
  message: string;
}

/** Settings refused a value (like pydantic's ValidationError). */
export class SettingsError extends Error {
  readonly issues: SettingsIssue[];
  constructor(issues: SettingsIssue[]) {
    super(issues.map((i) => `${envName(i.field)}: ${i.message}`).join("; "));
    this.name = "SettingsError";
    this.issues = issues;
  }
}

export const ENV_PREFIX = "LUNA_";

/** Settings field → its environment variable (`units` → `LUNA_UNITS`). */
export function envName(field: string): string {
  return ENV_PREFIX + field.toUpperCase();
}

/** The default of a field (a fresh copy for lists). */
export function fieldDefault(name: FieldName): unknown {
  const spec: FieldSpec = FIELDS[name];
  return typeof spec.default === "function" ? (spec.default as () => unknown)() : spec.default;
}

const TRUE = new Set(["1", "true", "t", "yes", "y", "on"]);
const FALSE = new Set(["0", "false", "f", "no", "n", "off"]);

/** Text (from `.env` or the environment) → a typed value. Throws on bad input. */
function fromText(spec: FieldSpec, text: string): unknown {
  switch (spec.kind) {
    case "bool": {
      const v = text.trim().toLowerCase();
      if (TRUE.has(v)) return true;
      if (FALSE.has(v)) return false;
      throw new Error("Input should be a valid boolean");
    }
    case "int": {
      if (!/^\s*[+-]?\d+\s*$/.test(text)) throw new Error("Input should be a valid integer");
      return Number.parseInt(text, 10);
    }
    case "float": {
      const n = Number(text.trim());
      if (text.trim() === "" || Number.isNaN(n)) throw new Error("Input should be a valid number");
      return n;
    }
    case "list": {
      const parts = text.split(",").map((s) => s.trim()).filter(Boolean);
      if (!spec.intItems) return parts;
      return parts.map((s) => {
        if (!/^[+-]?\d+$/.test(s)) throw new Error("Input should be a valid integer");
        return Number.parseInt(s, 10);
      });
    }
    case "path":
      return expandHome(text);
    default:
      return text;
  }
}

/** A value given in code (overrides) → the field's type. Text goes through fromText. */
function fromValue(spec: FieldSpec, value: unknown): unknown {
  if (value === null || value === undefined) {
    if (spec.optional) return null;
    throw new Error("Input should not be empty");
  }
  if (typeof value === "string") return fromText(spec, value);
  if (spec.kind === "list" && !Array.isArray(value)) throw new Error("Input should be a valid list");
  if ((spec.kind === "int" || spec.kind === "float") && typeof value !== "number") throw new Error("Input should be a valid number");
  if (spec.kind === "int" && !Number.isInteger(value)) throw new Error("Input should be a valid integer");
  if (spec.kind === "bool" && typeof value !== "boolean") throw new Error("Input should be a valid boolean");
  return Array.isArray(value) ? [...value] : value;
}

export interface LoadOptions {
  /** `.env` file to read; null = none. Default: the project's `.env`. */
  envFile?: string | null;
  /** Environment variables (default: process.env). */
  env?: Record<string, string | undefined>;
  /** Values set in code; they win over everything else. */
  overrides?: Partial<Settings>;
}

/** Build Settings from defaults, `.env`, the environment and overrides. */
export function loadSettings(options: LoadOptions = {}): Settings {
  const envFile = options.envFile === undefined ? DEFAULT_ENV_PATH : options.envFile;
  const fileValues = envFile ? readEnv(envFile) : {};
  const env = options.env ?? process.env;
  const overrides = (options.overrides ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const issues: SettingsIssue[] = [];
  for (const name of FIELD_NAMES) {
    const spec: FieldSpec = FIELDS[name];
    const key = envName(name);
    try {
      let value: unknown;
      if (Object.hasOwn(overrides, name)) value = fromValue(spec, overrides[name]);
      else if (env[key] !== undefined) value = fromText(spec, env[key]!);
      else if (fileValues[key] !== undefined) value = fromText(spec, fileValues[key]);
      else value = fieldDefault(name);
      if (spec.validate && value !== null) value = spec.validate(value);
      out[name] = value;
    } catch (error) {
      issues.push({ field: name, message: error instanceof Error ? error.message : String(error) });
    }
  }
  if (issues.length) throw new SettingsError(issues);
  return out as unknown as Settings;
}

let cached: Settings | null = null;

/** The shared Settings (created once). */
export function getSettings(): Settings {
  cached ??= loadSettings();
  return cached;
}

/** Forget the cached Settings so the next getSettings() reads `.env` again. */
export function resetSettings(): void {
  cached = null;
}
