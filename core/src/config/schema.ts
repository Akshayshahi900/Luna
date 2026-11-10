/**
 * Describe every setting for the Control Center, and save changes to `.env`.
 *
 * BEGINNER MAP
 * ------------
 * The browser builds its settings forms from `settingsSchema()`: one entry
 * per Settings field with its env name, type, choices, description, group and
 * when a change takes effect:
 *
 *   "live"     read fresh on every use (the mail / Google MCP servers)
 *   "rebuild"  the agent is rebuilt right away (persona, limits, keys, ...)
 *   "restart"  only after restarting luna-web (storage paths, web server, voice)
 *
 * `saveSettings()` turns the browser's values into `.env` text
 * (envfile.updateEnv), then re-reads the file with loadSettings() to validate.
 * A value Settings rejects puts the old file back, so a typo in the UI can
 * never stop Luna from starting.
 *
 * Secrets (API keys, the mail password) are write-only: the browser only
 * learns whether one is set.
 *
 * Read next: web/control.ts (the HTTP routes that use this).
 */

import { chmodSync, existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";

import { EnvFileError, readEnv, updateEnv } from "./envfile.ts";
import {
  ENV_PREFIX,
  envName,
  FIELD_NAMES,
  FIELDS,
  fieldDefault,
  type FieldKind,
  type FieldName,
  type FieldSpec,
  loadSettings,
  type Settings,
  SettingsError,
} from "./settings.ts";

export { envName };

// (group id, title, fields). Every Settings field belongs to exactly one.
export const GROUPS: [string, string, FieldName[]][] = [
  ["models", "Model providers", [
    "provider", "model_name", "openrouter_api_key", "groq_api_key", "groq_model",
    "ollama_base_url", "ollama_model", "model_max_retries", "model_vision",
  ]],
  ["persona", "Persona", [
    "system_prompt", "response_style", "user_title", "user_name", "user_location",
    "units", "timezone", "persona_path",
  ]],
  ["limits", "Limits", ["max_model_calls", "max_tool_calls", "task_budget"]],
  ["memory", "Memory", [
    "memory_backend", "checkpoint_path", "summary_trigger_tokens", "summary_keep_tokens",
    "enable_longterm_memory", "longterm_memory_path", "memory_recall_limit",
    "memory_prompt_chars", "memory_max_suggestions",
  ]],
  ["tools", "Tools", ["tavily_api_key", "mcp_config_path", "enable_builtin_tools", "enable_mcp_tools"]],
  ["mail", "Mail", [
    "mail_backend", "mail_address", "mail_password", "mail_username", "mail_imap_host",
    "mail_imap_port", "mail_smtp_host", "mail_smtp_port", "mail_max_body_chars",
  ]],
  ["google", "Google", [
    "google_credentials_path", "google_token_path", "google_calendar_id",
    "google_tasklist_id", "tasks_google_sync",
  ]],
  ["permissions", "Permissions", ["workspace_dirs", "auto_approve"]],
  ["network", "Web server & network", [
    "web_host", "web_port", "web_allowed_origins", "web_open_window", "web_close_with_window", "web_browser",
  ]],
  ["voice", "Voice", [
    "tts_engine", "tts_voice", "tts_voices_dir", "tts_length_scale",
    "stt_engine", "stt_model", "stt_models_dir", "stt_threads",
  ]],
  ["routines", "Routines", ["routines_enabled", "routines_path"]],
  ["messaging", "Messaging (Telegram)", [
    "telegram_bot_token", "telegram_allowed_users", "telegram_voice_replies", "telegram_routine_alerts",
  ]],
];

export const SECRETS: ReadonlySet<string> = new Set([
  "openrouter_api_key", "groq_api_key", "tavily_api_key", "mail_password", "telegram_bot_token",
]);

export const CHOICES: Record<string, string[]> = {
  provider: ["openrouter", "groq", "ollama"],
  response_style: ["concise", "detailed"],
  units: ["metric", "imperial"],
  memory_backend: ["sqlite", "memory"],
  mail_backend: ["gmail", "imap"],
  tts_engine: ["piper", "browser"],
  stt_engine: ["whisper", "browser"],
};

// Read fresh by the MCP servers on every tool call (servers/*.ts),
// and by the Telegram bot on every message (channels/telegram.ts).
const LIVE = new Set<string>([
  ...GROUPS.filter(([id]) => ["mail", "google", "messaging"].includes(id))
    .flatMap(([, , fields]) => fields)
    .filter((f) => f !== "telegram_bot_token"),
  "model_vision",
]);
// Opened once at startup.
const RESTART = new Set<string>([
  "provider", "model_name", "memory_backend", "checkpoint_path", "enable_longterm_memory",
  "longterm_memory_path", "mcp_config_path", "enable_mcp_tools", "web_host", "web_port",
  "web_allowed_origins", "web_open_window", "web_close_with_window", "web_browser", "tts_engine", "tts_voice",
  "tts_voices_dir", "tts_length_scale", "stt_engine", "stt_model", "stt_models_dir", "stt_threads",
  "routines_enabled", "routines_path",
  "telegram_bot_token", // the bot starts with luna-web (channels/telegram.ts)
]);

export type Applies = "live" | "rebuild" | "restart";

/** When a change to `field` takes effect: "live", "rebuild" or "restart". */
export function applies(field: string): Applies {
  if (LIVE.has(field)) return "live";
  if (RESTART.has(field)) return "restart";
  return "rebuild";
}

function kindOf(name: FieldName): FieldKind {
  return (FIELDS[name] as FieldSpec).kind;
}

/** A Settings value as plain JSON. */
export function toJson(value: unknown): unknown {
  return Array.isArray(value) ? value.map(toJson) : value;
}

/** A value from the browser as `.env` text. null or "" removes the key (back to the default). */
export function toEnv(kind: FieldKind, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (kind === "bool") return [true, "true", "1", 1].includes(value as never) ? "true" : "false";
  if (kind === "list") {
    const items = Array.isArray(value) ? value : String(value).split(",");
    const text = items.map((v) => String(v).trim()).filter(Boolean).join(",");
    return text || null;
  }
  const text = String(value).trim();
  return text || null;
}

export interface SchemaField {
  name: string;
  env: string;
  kind: FieldKind;
  choices: string[] | null;
  description: string;
  secret: boolean;
  applies: Applies;
  value: unknown;
  is_set: boolean | null;
  default: unknown;
  in_file: boolean;
}

export interface SettingsSchema {
  env_path: string;
  groups: { id: string; title: string; fields: SchemaField[] }[];
  unknown: string[];
}

/** Groups of fields with their current values (secrets masked) plus any
 * LUNA_* keys in `.env` that Settings doesn't know (e.g. removed options). */
export function settingsSchema(settings: Settings, envPath: string): SettingsSchema {
  const inFile = readEnv(envPath);
  const groups = GROUPS.map(([id, title, names]) => ({
    id,
    title,
    fields: names.map((name): SchemaField => {
      const secret = SECRETS.has(name);
      const value = settings[name];
      return {
        name,
        env: envName(name),
        kind: kindOf(name),
        choices: CHOICES[name] ?? null,
        description: (FIELDS[name] as FieldSpec).description ?? "",
        secret,
        applies: applies(name),
        value: secret ? null : toJson(value),
        is_set: secret ? Boolean(value) : null,
        default: secret ? null : toJson(fieldDefault(name)),
        in_file: Object.hasOwn(inFile, envName(name)),
      };
    }),
  }));
  const known = new Set(FIELD_NAMES.map(envName));
  const unknown = Object.keys(inFile).filter((k) => k.startsWith(ENV_PREFIX) && !known.has(k)).sort();
  return { env_path: envPath, groups, unknown };
}

/** A change Settings refused; `.env` was left as it was. */
export class SettingsRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingsRejected";
  }
}

/**
 * Write `{field: value}` to `.env`, validate, and return the new Settings
 * plus `{field: applies}` for every changed field.
 *
 * Unknown field names are refused. `removeUnknown` deletes stale LUNA_* keys
 * that Settings no longer reads.
 */
export function saveSettings(
  envPath: string,
  values: Record<string, unknown>,
  removeUnknown: string[] = [],
  env: Record<string, string | undefined> = process.env,
): { settings: Settings; effects: Record<string, Applies> } {
  const changes: Record<string, string | null> = {};
  const effects: Record<string, Applies> = {};
  for (const [name, value] of Object.entries(values)) {
    if (!Object.hasOwn(FIELDS, name)) throw new SettingsRejected(`Unknown setting: ${name}`);
    changes[envName(name)] = toEnv(kindOf(name as FieldName), value);
    effects[name] = applies(name);
  }
  const known = new Set(FIELD_NAMES.map(envName));
  for (const key of removeUnknown) {
    if (!key.startsWith(ENV_PREFIX) || known.has(key)) throw new SettingsRejected(`${key} is not an unknown LUNA_ key`);
    changes[key] = null;
  }

  const before = existsSync(envPath) ? readFileSync(envPath) : null;
  try {
    updateEnv(envPath, changes);
    const settings = loadSettings({ envFile: envPath, env });
    return { settings, effects };
  } catch (error) {
    restore(envPath, before);
    if (error instanceof SettingsError || error instanceof EnvFileError) throw new SettingsRejected(error.message);
    throw error;
  }
}

/** Put the original file back byte for byte (not re-formatted). */
function restore(file: string, data: Buffer | null): void {
  if (data === null) {
    rmSync(file, { force: true });
    return;
  }
  const tmp = file + ".tmp";
  writeFileSync(tmp, data);
  chmodSync(tmp, statSync(file).mode & 0o777);
  renameSync(tmp, file);
}
