// Control Center: typed client for /api/control (src/luna/web/control.py)
// plus small pure helpers (formatting, sparklines) that the tests cover.

export type Applies = "live" | "rebuild" | "restart";
export type FieldKind = "str" | "int" | "float" | "bool" | "path" | "list";

export interface SettingField {
  name: string;
  env: string;
  kind: FieldKind;
  choices: string[] | null;
  description: string;
  secret: boolean;
  applies: Applies;
  /** null for secrets (never sent to the browser) */
  value: unknown;
  /** secrets only: is a value saved? */
  is_set: boolean | null;
  default: unknown;
  /** the key is written in .env (otherwise the default is used) */
  in_file: boolean;
}

export interface SettingGroup {
  id: string;
  title: string;
  fields: SettingField[];
}

export interface SettingsSchema {
  env_path: string;
  groups: SettingGroup[];
  /** LUNA_* keys in .env that Luna no longer reads */
  unknown: string[];
  restart_required: string[];
}

export interface SaveResult extends SettingsSchema {
  ok: boolean;
  effects: Record<string, Applies>;
  rebuilt: boolean;
}

export interface McpServer {
  name: string;
  agent: string | null;
  command: string | null;
  args: string[];
  url: string | null;
  transport: string | null;
  env_keys: string[];
  disabled: boolean;
  /** ok = loaded at startup, error = its group failed, off = disabled, restart = changed since startup */
  status: "ok" | "error" | "off" | "restart";
  error: string | null;
  tools: number;
}

export interface McpList {
  path: string;
  enabled: boolean;
  servers: McpServer[];
  helpers: string[];
  error?: string;
}

export interface McpServerInput {
  command?: string;
  args?: string[];
  url?: string;
  agent?: string | null;
  disabled?: boolean;
  env?: Record<string, string | null>;
}

export interface Connections {
  google: {
    client_file?: boolean;
    client_path?: string;
    token: boolean;
    ok: boolean;
    error: string | null;
    scopes?: string[];
    signing_in?: boolean;
  };
  mail: {
    backend: "gmail" | "imap";
    address: string | null;
    password_set: boolean;
    imap_host: string;
    smtp_host: string;
    ready: boolean;
  };
  keys: Record<string, boolean>;
}

export interface ProviderRow {
  id: string;
  label: string;
  configured: boolean;
  default_model: string;
  model_env: string;
  key_env: string | null;
}

export interface Providers {
  providers: ProviderRow[];
  current: { provider: string; model: string };
  default: { provider: string; model: string };
  can_switch: boolean;
}

export interface ToolPermission {
  name: string;
  /** "main" or a helper (assistant, files, coder, researcher) */
  owner: string;
  risky: boolean;
  /** ask = pauses for approval, auto = in LUNA_AUTO_APPROVE, free = read-only */
  mode: "ask" | "auto" | "free";
  can_toggle: boolean;
}

export interface Permissions {
  tools: ToolPermission[];
  helpers: { name: string; tools: number }[];
  auto_approve: string[];
  workspace_dirs: string[];
}

export interface RoutineRun {
  id: number;
  routine_id: number;
  started_at: string;
  finished_at: string | null;
  status: "running" | "ok" | "error" | "skipped";
  summary: string;
  data: any;
  error: string | null;
  /** recent_runs only */
  name?: string;
  kind?: "builtin" | "agent";
}

export interface Routine {
  id: number;
  name: string;
  kind: "builtin" | "agent";
  builtin: string | null;
  prompt: string;
  cron: string;
  /** English version of cron, e.g. "weekdays at 08:00" */
  schedule: string;
  enabled: boolean;
  notify: boolean;
  created_at: string;
  updated_at: string;
  next_run_at: string | null;
  last_run: RoutineRun | null;
  running: boolean;
}

export interface RoutineList {
  routines: Routine[];
  builtins: Record<string, { name: string; tool: string; description: string; cron: string }>;
  scheduler: boolean;
  timezone: string;
}

export interface UsageDay {
  day: string;
  runs: number;
  model_calls: number;
  tool_calls: number;
  errors: number;
}

export interface Stats {
  now: number;
  uptime: number;
  pid: number;
  process: { cpu_percent: number; rss: number; threads: number | null };
  system: { cpus: number; load: number[] | null; mem_total: number | null; mem_available: number | null };
  model: { provider: string; model: string };
  tabs: number;
  memory: {
    total: number;
    by_kind: Record<string, number>;
    pinned: number;
    deleted: number;
    pending: number;
    changes: number;
  } | null;
  storage: { checkpoints: number | null; longterm: number | null; routines: number | null };
  sessions: { count: number; routine_threads: number; turns: number; last: string | null } | null;
  helper_tools: Record<string, number>;
  tools: { main: number; mcp_tools: number; mcp_errors: Record<string, string> };
  usage: {
    since_start: { runs: number; model_calls: number; tool_calls: number; errors: number };
    days: UsageDay[];
    models: { provider: string; model: string; runs: number; model_calls: number; tool_calls: number; errors: number }[];
  };
  routines: { total: number; enabled: number; running: number[]; scheduler: boolean; recent: RoutineRun[] };
  restart_required: string[];
}

export interface DashboardPrefs {
  widgets: { mail: boolean; agenda: boolean; todos: boolean; stats: boolean };
  position: "bottom-left" | "bottom-right";
  style: "compact" | "minimal";
  opacity: number;
  show_hints: boolean;
}

export interface Insights {
  insights: Partial<Record<"mail_check" | "agenda" | "todos", RoutineRun>>;
  dashboard: DashboardPrefs;
}

export interface CronCheck {
  valid: boolean;
  error?: string;
  expr?: string;
  text?: string;
  next?: string[];
}

// --- client --------------------------------------------------------------------

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/control/${path}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    /* empty body */
  }
  if (!res.ok) throw new ApiError(data?.error ?? `${res.status} ${res.statusText}`, res.status);
  return data as T;
}

export const api = {
  settings: () => call<SettingsSchema>("GET", "settings"),
  saveSettings: (values: Record<string, unknown>, remove_unknown: string[] = []) =>
    call<SaveResult>("PATCH", "settings", { values, remove_unknown }),
  mcp: () => call<McpList>("GET", "mcp"),
  saveMcp: (name: string, server: McpServerInput) => call<McpList>("PUT", `mcp/${encodeURIComponent(name)}`, server),
  deleteMcp: (name: string) => call<McpList>("DELETE", `mcp/${encodeURIComponent(name)}`),
  connections: () => call<Connections>("GET", "connections"),
  connectGoogle: () => call<Connections>("POST", "connections/google"),
  disconnectGoogle: () => call<Connections>("DELETE", "connections/google"),
  providers: () => call<Providers>("GET", "providers"),
  models: (provider: string) =>
    call<{ provider: string; models: string[]; error?: string }>("GET", `providers/${provider}/models`),
  setDefaultModel: (provider: string, model: string, apply: boolean) =>
    call<Providers>("POST", "providers/default", { provider, model, apply }),
  permissions: () => call<Permissions>("GET", "permissions"),
  stats: () => call<Stats>("GET", "stats"),
  insights: () => call<Insights>("GET", "insights"),
  dashboard: () => call<DashboardPrefs>("GET", "dashboard"),
  saveDashboard: (prefs: Partial<DashboardPrefs>) => call<DashboardPrefs>("PUT", "dashboard", prefs),
  routines: () => call<RoutineList>("GET", "routines"),
  createRoutine: (r: { name: string; prompt: string; cron: string; enabled?: boolean; notify?: boolean }) =>
    call<RoutineList>("POST", "routines", r),
  updateRoutine: (id: number, changes: Partial<Pick<Routine, "name" | "prompt" | "cron" | "enabled" | "notify">>) =>
    call<RoutineList>("PATCH", `routines/${id}`, changes),
  deleteRoutine: (id: number) => call<RoutineList>("DELETE", `routines/${id}`),
  runRoutine: (id: number) => call<RoutineList & { run: RoutineRun }>("POST", `routines/${id}/run`),
  routineRuns: (id: number) => call<{ runs: RoutineRun[] }>("GET", `routines/${id}/runs`),
  cron: (expr: string) => call<CronCheck>("GET", `cron?expr=${encodeURIComponent(expr)}`),
};

// --- pure helpers ----------------------------------------------------------------

/** 1536 → "1.5 KB" */
export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${i === 0 ? v : v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

/** 3725 → "1h 2m", 59 → "59s", 90061 → "1d 1h" */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

/** Time until an ISO moment: "in 5 min", "in 2 h", "now" ("" if unknown). */
export function until(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const min = Math.round((t - now) / 60000);
  if (min <= 0) return "now";
  if (min < 60) return `in ${min} min`;
  if (min < 48 * 60) return `in ${Math.round(min / 60)} h`;
  return `in ${Math.round(min / 1440)} d`;
}

/** SVG path for a sparkline of `values` in a width × height box. */
export function sparkPath(values: number[], width: number, height: number, pad = 2): string {
  if (!values.length) return "";
  const max = Math.max(...values, 1);
  const step = values.length > 1 ? (width - pad * 2) / (values.length - 1) : 0;
  return values
    .map((v, i) => {
      const x = pad + i * step;
      const y = height - pad - (v / max) * (height - pad * 2);
      return `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");
}

/** A setting's value as text for an input (lists comma-joined). */
export function fieldText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.join(", ");
  return String(value);
}

/** Parse an input's text back to the field's type (null = back to default). */
export function parseField(kind: FieldKind, text: string): unknown {
  const t = text.trim();
  if (!t) return null;
  if (kind === "int") {
    const n = Number(t);
    if (!Number.isInteger(n)) throw new Error("Must be a whole number");
    return n;
  }
  if (kind === "float") {
    const n = Number(t);
    if (Number.isNaN(n)) throw new Error("Must be a number");
    return n;
  }
  if (kind === "list") return t.split(",").map((s) => s.trim()).filter(Boolean);
  return t;
}

/** Find a field by name across groups. */
export function findField(schema: SettingsSchema | null, name: string): SettingField | undefined {
  return schema?.groups.flatMap((g) => g.fields).find((f) => f.name === name);
}

/** Fields whose name, env key or description contains `query`. */
export function searchFields(groups: SettingGroup[], query: string): SettingGroup[] {
  const q = query.trim().toLowerCase();
  if (!q) return groups;
  return groups
    .map((g) => ({
      ...g,
      fields: g.fields.filter((f) =>
        [f.name, f.env, f.description, g.title].some((s) => s.toLowerCase().includes(q)),
      ),
    }))
    .filter((g) => g.fields.length > 0);
}

/** "127.0.0.1" / "localhost" / "::1" are local; anything else is exposed. */
export function isLoopback(host: string): boolean {
  const h = host.trim().toLowerCase();
  return h === "localhost" || h === "::1" || h.startsWith("127.");
}

/** HUD widget text for one insight, or null when there is nothing to show. */
export function insightLine(key: "mail_check" | "agenda" | "todos", run: RoutineRun | undefined): { title: string; detail: string } | null {
  if (!run || run.status !== "ok") return null;
  const d = run.data ?? {};
  if (key === "mail_check") {
    const n = d.unread ?? 0;
    const first = d.items?.[0];
    return { title: n ? `${n} unread` : "Inbox zero", detail: first ? `${first.from}: ${first.subject}` : "" };
  }
  if (key === "agenda") {
    const events = d.events?.length ?? 0;
    const next = d.next;
    const when = next?.start && next.start.length > 10 ? next.start.slice(11, 16) : next ? "all day" : "";
    return {
      title: events ? `${events} event${events === 1 ? "" : "s"} today` : "Clear calendar",
      detail: next ? `Next · ${when} ${next.title}` : events ? "All done for today" : "",
    };
  }
  const open = d.open ?? 0;
  const bits = [d.due_today ? `${d.due_today} due today` : "", d.overdue ? `${d.overdue} overdue` : ""].filter(Boolean);
  return { title: open ? `${open} to-do${open === 1 ? "" : "s"}` : "No to-dos", detail: bits.join(" · ") || d.items?.[0]?.title || "" };
}
