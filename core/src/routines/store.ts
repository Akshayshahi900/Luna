/**
 * RoutineStore — routines, their run history and API usage counters, in SQLite.
 *
 * BEGINNER MAP
 * ------------
 * Three tables in data/luna_routines.sqlite:
 *
 *   routines  what to run and when (a cron line), enabled or not
 *             kind "builtin" = a data-only check (builtin.ts, no LLM)
 *             kind "agent"   = a prompt the agent runs (agent.ts, uses LLM quota)
 *   runs      one row per run: status, a one-line summary, the data the
 *             dashboard shows; only the newest KEEP_RUNS per routine are kept
 *   usage     model calls / tool calls / errors per day, provider and model,
 *             for the Control Center charts (counted in web/server.ts)
 *
 * Same style as agent/longterm.ts: synchronous better-sqlite3. The schema is
 * the Python version's, so an existing data/luna_routines.sqlite carries over.
 *
 * Times are stored as UTC ISO text, so comparing strings compares times.
 * Schedules are read in your timezone (LUNA_TIMEZONE, else the machine's).
 *
 * Read next: routines/builtin.ts
 */

import { mkdirSync } from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import { dayText, isoUtc, localZone, toWall } from "../util/zoned.ts";
import { BUILTINS, type Now } from "./builtin.ts";
import { describe, nextRun, parse } from "./cron.ts";

export const KINDS = ["builtin", "agent"] as const;
export const KEEP_RUNS = 50;
export const MAX_PROMPT_CHARS = 4000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS routines (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    builtin TEXT,
    prompt TEXT NOT NULL DEFAULT '',
    cron TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 0,
    notify INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    next_run_at TEXT
);
CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY,
    routine_id INTEGER NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    status TEXT NOT NULL DEFAULT 'running',
    summary TEXT NOT NULL DEFAULT '',
    data TEXT,
    error TEXT
);
CREATE INDEX IF NOT EXISTS runs_by_routine ON runs (routine_id, id);
CREATE TABLE IF NOT EXISTS usage (
    day TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    runs INTEGER NOT NULL DEFAULT 0,
    model_calls INTEGER NOT NULL DEFAULT 0,
    tool_calls INTEGER NOT NULL DEFAULT 0,
    errors INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, provider, model)
);
`;

/** A routine change the store refuses (bad schedule, unknown id, ...). */
export class RoutineRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoutineRefused";
  }
}

export interface Run {
  id: number;
  routine_id: number;
  started_at: string;
  finished_at: string | null;
  status: string;
  summary: string;
  data: any;
  error: string | null;
}

export interface Routine {
  id: number;
  name: string;
  kind: "builtin" | "agent";
  builtin: string | null;
  prompt: string;
  cron: string;
  schedule: string;
  enabled: boolean;
  notify: boolean;
  created_at: string;
  updated_at: string;
  next_run_at: string | null;
  last_run: Run | null;
}

export interface UsageDay {
  day: string;
  runs: number;
  model_calls: number;
  tool_calls: number;
  errors: number;
}

type Row = Record<string, any>;

const squash = (text: string) => text.split(/\s+/).filter(Boolean).join(" ");

function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

/** The routines database (see the module comment). */
export class RoutineStore {
  readonly db: Database.Database;
  /** The zone schedules are read in. */
  readonly zone: string;

  constructor(file = ":memory:", zone: string | null = null) {
    if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
    this.zone = zone || localZone();
    this.db = new Database(file);
    this.db.exec(SCHEMA);
    // A run still "running" was cut off by a restart.
    this.db
      .prepare("UPDATE runs SET status = 'error', error = 'Interrupted by a restart', finished_at = ? WHERE status = 'running'")
      .run(isoUtc());
  }

  /** Close the database connection. */
  close(): void {
    this.db.close();
  }

  // --- schedules -----------------------------------------------------------

  /** Now, in the timezone schedules are read in. */
  localNow(): Now {
    return { utc: Date.now(), zone: this.zone };
  }

  /** Today's date (YYYY-MM-DD) in that timezone. */
  today(): string {
    return dayText(toWall(Date.now(), this.zone));
  }

  /** UTC ISO time of the next run of `cron` after `after` (ms, default now). */
  nextAfter(cron: string, after: number = Date.now()): string {
    return isoUtc(nextRun(cron, after, this.zone));
  }

  // --- routines ------------------------------------------------------------

  #routine(row: Row): Routine {
    const last = this.db.prepare("SELECT * FROM runs WHERE routine_id = ? ORDER BY id DESC LIMIT 1").get(row.id) as Row | undefined;
    return {
      id: row.id,
      name: row.name,
      kind: row.kind,
      builtin: row.builtin ?? null,
      prompt: row.prompt,
      cron: row.cron,
      schedule: describe(row.cron),
      enabled: Boolean(row.enabled),
      notify: Boolean(row.notify),
      created_at: row.created_at,
      updated_at: row.updated_at,
      next_run_at: row.enabled ? row.next_run_at : null,
      last_run: last ? RoutineStore.#run(last) : null,
    };
  }

  static #run(row: Row): Run {
    return {
      id: row.id,
      routine_id: row.routine_id,
      started_at: row.started_at,
      finished_at: row.finished_at ?? null,
      status: row.status,
      summary: row.summary,
      data: row.data ? JSON.parse(row.data) : null,
      error: row.error ?? null,
    };
  }

  #row(routineId: number): Row {
    const row = this.db.prepare("SELECT * FROM routines WHERE id = ?").get(routineId) as Row | undefined;
    if (!row) throw new RoutineRefused(`No routine ${routineId}.`);
    return row;
  }

  /** Every routine: built-ins first, then by id. */
  list(): Routine[] {
    return (this.db.prepare("SELECT * FROM routines ORDER BY kind = 'agent', id").all() as Row[]).map((r) => this.#routine(r));
  }

  /** One routine by id; RoutineRefused if missing. */
  get(routineId: number): Routine {
    return this.#routine(this.#row(routineId));
  }

  static #checkCron(cron: string): string {
    try {
      return parse(cron).expr;
    } catch (error) {
      throw new RoutineRefused((error as Error).message);
    }
  }

  /** Create a routine. Agent routines need a prompt; built-ins a known key. */
  add(
    name: string,
    kind: string,
    cron: string,
    options: { prompt?: string; builtin?: string | null; enabled?: boolean; notify?: boolean } = {},
  ): Routine {
    name = squash(name);
    if (!name) throw new RoutineRefused("A routine needs a name.");
    if (!(KINDS as readonly string[]).includes(kind)) throw new RoutineRefused(`Kind must be one of: ${KINDS.join(", ")}.`);
    const prompt = (options.prompt ?? "").trim();
    if (kind === "agent" && !prompt) throw new RoutineRefused("An agent routine needs a prompt.");
    if ([...prompt].length > MAX_PROMPT_CHARS) throw new RoutineRefused(`Prompts are limited to ${MAX_PROMPT_CHARS} characters.`);
    const builtin = options.builtin ?? null;
    if (kind === "builtin" && !(builtin && Object.hasOwn(BUILTINS, builtin))) throw new RoutineRefused(`Unknown built-in routine: '${builtin}'`);
    cron = RoutineStore.#checkCron(cron);
    const now = isoUtc();
    const info = this.db
      .prepare(
        "INSERT INTO routines (name, kind, builtin, prompt, cron, enabled, notify, created_at, updated_at, next_run_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(name, kind, kind === "builtin" ? builtin : null, prompt, cron, options.enabled ? 1 : 0, options.notify === false ? 0 : 1, now, now, this.nextAfter(cron));
    return this.#routine(this.#row(Number(info.lastInsertRowid)));
  }

  /** Change name / prompt / cron / enabled / notify. Built-ins keep their kind. */
  update(routineId: number, changes: Record<string, unknown>): Routine {
    const allowed = new Set(["name", "prompt", "cron", "enabled", "notify"]);
    const unknown = Object.keys(changes).filter((k) => !allowed.has(k)).sort();
    if (unknown.length) throw new RoutineRefused(`Can't change: ${unknown.join(", ")}`);
    const row = this.#row(routineId);
    const has = (k: string) => Object.hasOwn(changes, k);
    const name = squash(String(has("name") ? changes.name : row.name));
    const prompt = String(has("prompt") ? changes.prompt : row.prompt).trim();
    const cron = RoutineStore.#checkCron(String(has("cron") ? changes.cron : row.cron));
    if (!name) throw new RoutineRefused("A routine needs a name.");
    if (row.kind === "agent" && !prompt) throw new RoutineRefused("An agent routine needs a prompt.");
    if ([...prompt].length > MAX_PROMPT_CHARS) throw new RoutineRefused(`Prompts are limited to ${MAX_PROMPT_CHARS} characters.`);
    const enabled = Boolean(has("enabled") ? changes.enabled : row.enabled);
    const notify = Boolean(has("notify") ? changes.notify : row.notify);
    // A new schedule, or switching on, counts from now.
    let nextAt = row.next_run_at;
    if (cron !== row.cron || (enabled && !row.enabled)) nextAt = this.nextAfter(cron);
    this.db
      .prepare("UPDATE routines SET name = ?, prompt = ?, cron = ?, enabled = ?, notify = ?, updated_at = ?, next_run_at = ? WHERE id = ?")
      .run(name, prompt, cron, enabled ? 1 : 0, notify ? 1 : 0, isoUtc(), nextAt, routineId);
    return this.#routine(this.#row(routineId));
  }

  /** Remove an agent routine and its runs. Built-ins can only be disabled. */
  delete(routineId: number): void {
    const row = this.#row(routineId);
    if (row.kind === "builtin") throw new RoutineRefused("Built-in routines can be turned off, not deleted.");
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM runs WHERE routine_id = ?").run(routineId);
      this.db.prepare("DELETE FROM routines WHERE id = ?").run(routineId);
    })();
  }

  /** Add any built-in routine that isn't there yet (switched off). */
  seedBuiltins(): void {
    const have = new Set((this.db.prepare("SELECT builtin FROM routines WHERE kind = 'builtin'").all() as Row[]).map((r) => r.builtin));
    for (const [key, spec] of Object.entries(BUILTINS)) {
      if (!have.has(key)) this.add(spec.name, "builtin", spec.cron, { builtin: key, enabled: false });
    }
  }

  /** Enabled routines whose next run time has come. */
  due(now: number = Date.now()): Routine[] {
    const rows = this.db
      .prepare("SELECT * FROM routines WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at, id")
      .all(isoUtc(now)) as Row[];
    return rows.map((r) => this.#routine(r));
  }

  /** Move a routine's next run past `after` (ms, default now). */
  scheduleNext(routineId: number, after: number = Date.now()): void {
    const row = this.#row(routineId);
    this.db.prepare("UPDATE routines SET next_run_at = ? WHERE id = ?").run(this.nextAfter(row.cron, after), routineId);
  }

  // --- runs ----------------------------------------------------------------

  /** Record that a run started; returns its id. */
  startRun(routineId: number): number {
    this.#row(routineId);
    return Number(this.db.prepare("INSERT INTO runs (routine_id, started_at) VALUES (?, ?)").run(routineId, isoUtc()).lastInsertRowid);
  }

  /** Record how a run ended and drop the oldest runs past KEEP_RUNS. */
  finishRun(runId: number, status: string, summary = "", data: unknown = null, error: string | null = null): Run {
    return this.db.transaction(() => {
      this.db
        .prepare("UPDATE runs SET finished_at = ?, status = ?, summary = ?, data = ?, error = ? WHERE id = ?")
        .run(isoUtc(), status, summary, data === null || data === undefined ? null : JSON.stringify(data), error, runId);
      const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as Row;
      this.db
        .prepare("DELETE FROM runs WHERE routine_id = ? AND id NOT IN (SELECT id FROM runs WHERE routine_id = ? ORDER BY id DESC LIMIT ?)")
        .run(row.routine_id, row.routine_id, KEEP_RUNS);
      return RoutineStore.#run(row);
    })();
  }

  /** A routine's runs, newest first. */
  runs(routineId: number, limit = 20): Run[] {
    return (this.db.prepare("SELECT * FROM runs WHERE routine_id = ? ORDER BY id DESC LIMIT ?").all(routineId, limit) as Row[]).map(RoutineStore.#run);
  }

  /** The newest runs of every routine, with the routine's name. */
  recentRuns(limit = 12): (Run & { name: string; kind: string })[] {
    const rows = this.db
      .prepare(
        "SELECT runs.*, routines.name AS name, routines.kind AS kind FROM runs " +
          "JOIN routines ON routines.id = runs.routine_id ORDER BY runs.id DESC LIMIT ?",
      )
      .all(limit) as Row[];
    return rows.map((r) => ({ ...RoutineStore.#run(r), name: r.name, kind: r.kind }));
  }

  /** The last successful result of each enabled built-in, keyed by its key
   * (mail_check, agenda, todos): what the HUD widgets show. */
  insights(): Record<string, Run> {
    const rows = this.db
      .prepare(
        "SELECT routines.builtin AS key, runs.* FROM routines JOIN runs ON runs.id = (" +
          "  SELECT id FROM runs WHERE routine_id = routines.id AND status = 'ok' ORDER BY id DESC LIMIT 1" +
          ") WHERE routines.kind = 'builtin' AND routines.enabled = 1",
      )
      .all() as Row[];
    return Object.fromEntries(rows.map((r) => [r.key, RoutineStore.#run(r)]));
  }

  // --- usage ---------------------------------------------------------------

  /** Add to today's counters for this provider and model. */
  addUsage(provider: string, model: string, counts: Partial<Omit<UsageDay, "day">> = {}, day?: string): void {
    this.db
      .prepare(
        "INSERT INTO usage (day, provider, model, runs, model_calls, tool_calls, errors) VALUES (?, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT (day, provider, model) DO UPDATE SET runs = runs + excluded.runs, " +
          "model_calls = model_calls + excluded.model_calls, tool_calls = tool_calls + excluded.tool_calls, errors = errors + excluded.errors",
      )
      .run(day ?? this.today(), provider, model, counts.runs ?? 0, counts.model_calls ?? 0, counts.tool_calls ?? 0, counts.errors ?? 0);
  }

  /** Per-day totals for the last `days` days (oldest first, gaps as 0) and
   * per-provider/model totals over the same window. */
  usage(days = 14): { days: UsageDay[]; models: Record<string, unknown>[] } {
    const first = addDays(this.today(), -(days - 1));
    const rows = this.db
      .prepare(
        "SELECT day, SUM(runs) runs, SUM(model_calls) model_calls, SUM(tool_calls) tool_calls, SUM(errors) errors " +
          "FROM usage WHERE day >= ? GROUP BY day",
      )
      .all(first) as Row[];
    const models = this.db
      .prepare(
        "SELECT provider, model, SUM(runs) runs, SUM(model_calls) model_calls, SUM(tool_calls) tool_calls, SUM(errors) errors " +
          "FROM usage WHERE day >= ? GROUP BY provider, model ORDER BY model_calls DESC",
      )
      .all(first) as Row[];
    const byDay = new Map(rows.map((r) => [r.day, r]));
    const series: UsageDay[] = [];
    for (let i = 0; i < days; i++) {
      const key = addDays(first, i);
      const r = byDay.get(key) ?? {};
      series.push({ day: key, runs: r.runs ?? 0, model_calls: r.model_calls ?? 0, tool_calls: r.tool_calls ?? 0, errors: r.errors ?? 0 });
    }
    return { days: series, models };
  }
}
