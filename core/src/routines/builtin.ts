/**
 * Built-in routines: quick data-only checks for the dashboard (no LLM).
 *
 * BEGINNER MAP
 * ------------
 * Each built-in calls ONE read-only MCP tool directly, the same tool objects
 * the assistant helper uses (loaded once by luna-web), and turns the answer
 * into a one-line summary plus a little data for the HUD widgets:
 *
 *   mail_check  list_inbox(unread_only=true)  → unread count, newest senders
 *   agenda      get_agenda()                  → today's events, the next one
 *   todos       list_tasks()                  → open / due today / overdue
 *
 * No model is involved, so these cost no LLM quota. Only tools whose names
 * are not risky (mcp/loader.ts) may be called here: a routine runs with
 * nobody watching, so it must never change anything.
 *
 * A missing tool (the server isn't configured) gives status "skipped"; a
 * tool error (e.g. not signed in to Google) gives "error". Neither stops the
 * scheduler.
 *
 * Read next: routines/agent.ts
 */

import { isRiskyToolName } from "../mcp/loader.ts";
import { dayText, fromWall, toWall } from "../util/zoned.ts";

/** "ok", "skipped" or "error". */
export type Status = "ok" | "skipped" | "error";
/** [status, summary, data] */
export type Result = [Status, string, any];

/** An instant and the zone it is read in (the routines' "now"). */
export interface Now {
  utc: number;
  zone: string;
}

export interface BuiltinSpec {
  name: string;
  cron: string;
  tool: string;
  args: Record<string, unknown>;
  description: string;
  collect: (output: unknown, now: Now) => Result;
}

interface ToolLike {
  invoke(args: Record<string, unknown>): Promise<unknown>;
}

function maybeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * An MCP tool's answer as plain JSON.
 *
 * MCP tools return text content (a string, or a list of content blocks);
 * Luna's servers put JSON in it. Several blocks that each hold JSON are
 * returned as a list.
 */
export function decodeToolOutput(output: unknown): unknown {
  if (output === null || output === undefined || typeof output === "number" || typeof output === "boolean") return output ?? null;
  if (Array.isArray(output)) {
    // [content, artifact] from a content_and_artifact tool
    if (output.length === 2 && typeof output[0] === "string" && !(typeof output[1] === "string")) return decodeToolOutput(output[0]);
    const texts = output.map((block) => (typeof block === "string" ? block : String((block as { text?: unknown })?.text ?? "")));
    const parsed = texts.map(maybeJson);
    return parsed.length === 1 ? parsed[0] : parsed;
  }
  if (typeof output === "object") {
    const content = (output as { content?: unknown }).content; // a ToolMessage
    return content !== undefined ? decodeToolOutput(content) : output;
  }
  return maybeJson(String(output));
}

function asList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const result = (value as { result?: unknown })?.result;
  return Array.isArray(result) ? result : [];
}

/** One line, at most `limit` characters. */
export function clip(text: unknown, limit = 60): string {
  const s = String(text ?? "").split(/\s+/).filter(Boolean).join(" ");
  return [...s].length <= limit ? s : [...s].slice(0, limit - 1).join("") + "…";
}

/** 'Ann Lee <ann@x.com>' → 'Ann Lee'. */
function sender(value: unknown): string {
  const text = String(value ?? "").trim();
  const name = text.split("<")[0].trim().replace(/^"+|"+$/g, "");
  return name || text;
}

const isObject = (x: unknown): x is Record<string, any> => typeof x === "object" && x !== null && !Array.isArray(x);

// --- collectors --------------------------------------------------------------

function mail(output: unknown): Result {
  const items = asList(output);
  if (!items.length && !Array.isArray(output)) return ["error", clip(output, 160) || "No answer from the mail server.", null];
  const mails = items.filter(isObject).map((m) => ({ from: sender(m.from), subject: clip(m.subject, 90), date: m.date }));
  if (!mails.length) return ["ok", "Inbox zero: no unread mail.", { unread: 0, items: [] }];
  const latest = mails[0];
  const more = mails.length > 1 ? ` (+${mails.length - 1} more)` : "";
  return ["ok", `${mails.length} unread · latest from ${latest.from}: ${latest.subject}${more}`, { unread: mails.length, items: mails.slice(0, 5) }];
}

function eventStart(event: Record<string, any>): string {
  const start = event.start;
  if (isObject(start)) return String(start.dateTime || start.date || ""); // raw Google shape
  return String(start ?? "");
}

/** An ISO time → instant; a time without an offset is read in `zone`. */
function instant(text: string, zone: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/.exec(text);
  if (!m) return null;
  if (m[8]) {
    const ms = Date.parse(text.replace(" ", "T"));
    return Number.isNaN(ms) ? null : ms;
  }
  return fromWall({ year: +m[1], month: +m[2], day: +m[3], hour: +m[4], minute: +m[5], second: +(m[6] ?? 0) }, zone);
}

/** All-day events count all day; timed ones until they end (or start). */
function notOver(event: Record<string, string>, now: Now): boolean {
  for (const key of ["end", "start"]) {
    const text = event[key] || "";
    if (text.length <= 10) continue;
    const moment = instant(text, now.zone);
    if (moment === null) continue;
    return moment >= now.utc;
  }
  return Boolean(event.start);
}

function agenda(output: unknown, now: Now): Result {
  if (!isObject(output)) return ["error", clip(output, 160) || "No answer from the calendar server.", null];
  const events = ((output.events ?? []) as unknown[]).filter(isObject);
  const slim = events.map((e) => ({
    title: clip(e.title || e.summary, 80),
    start: eventStart(e),
    end: String(e.end ?? ""),
    location: clip(e.location, 60),
  }));
  const upcoming = slim.filter((e) => notOver(e, now));
  const next = upcoming[0] ?? null;
  const due = output.tasks_due ?? [];
  const overdue = output.overdue ?? [];
  const data = { events: slim, next, tasks_due: due.length, overdue: overdue.length, date: output.date };
  let summary: string;
  if (!slim.length) summary = "Nothing on the calendar today.";
  else {
    const when = next && next.start.length > 10 ? next.start.slice(11, 16) : "all day";
    summary = `${slim.length} event${slim.length !== 1 ? "s" : ""} today`;
    summary += next ? ` · next: ${next.title} (${when})` : " · all done";
  }
  return ["ok", summary, data];
}

function todos(output: unknown, now: Now): Result {
  const items = asList(output);
  if (!items.length && !Array.isArray(output)) return ["error", clip(output, 160) || "No answer from the to-do server.", null];
  const tasks = items.filter(isObject).filter((t) => !t.done);
  const today = dayText(toWall(now.utc, now.zone));
  const dueToday = tasks.filter((t) => String(t.due ?? "").slice(0, 10) === today);
  const overdue = tasks.filter((t) => t.due && String(t.due).slice(0, 10) < today);
  const seen = new Set<string>();
  const top = [...overdue, ...dueToday, ...tasks]
    .slice(0, 5)
    .map((t) => ({ title: clip(t.title, 80), due: t.due }))
    .filter((t) => !seen.has(t.title) && (seen.add(t.title), true));
  const data = { open: tasks.length, due_today: dueToday.length, overdue: overdue.length, items: top };
  if (!tasks.length) return ["ok", "No open to-dos.", data];
  const parts = [`${tasks.length} open`];
  if (dueToday.length) parts.push(`${dueToday.length} due today`);
  if (overdue.length) parts.push(`${overdue.length} overdue`);
  return ["ok", parts.join(" · "), data];
}

export const BUILTINS: Record<string, BuiltinSpec> = {
  mail_check: {
    name: "Check email",
    cron: "*/15 * * * *",
    tool: "list_inbox",
    args: { limit: 10, unread_only: true },
    description: "Unread mail count and the newest senders (mail server)",
    collect: mail,
  },
  agenda: {
    name: "Today's agenda",
    cron: "*/30 * * * *",
    tool: "get_agenda",
    args: {},
    description: "Today's calendar events and the next one (Google server)",
    collect: agenda,
  },
  todos: {
    name: "To-dos",
    cron: "*/30 * * * *",
    tool: "list_tasks",
    args: {},
    description: "Open, due-today and overdue to-dos (tasks server)",
    collect: todos,
  },
};

/**
 * The tool called `name`, or `<server>_<name>`: when two servers of one
 * helper export the same tool name, the loader prefixes the second with its
 * server's name (e.g. `mail_list_inbox`). null when missing or ambiguous.
 */
export function findTool<T>(tools: Record<string, T>, name: string): T | null {
  if (Object.hasOwn(tools, name)) return tools[name];
  const matches = Object.entries(tools).filter(([key]) => key.endsWith(`_${name}`)).map(([, t]) => t);
  return matches.length === 1 ? matches[0] : null;
}

/** Run one built-in: call its tool (no LLM) and summarize the answer. */
export async function runBuiltin(
  key: string,
  tools: Record<string, ToolLike>,
  now: Now,
  call?: (tool: ToolLike, args: Record<string, unknown>) => Promise<unknown>,
): Promise<Result> {
  const spec = BUILTINS[key];
  if (!spec) return ["error", `Unknown built-in routine: ${key}`, null];
  if (isRiskyToolName(spec.tool)) return ["error", `${spec.tool} is not read-only`, null]; // routines must never change anything
  const tool = findTool(tools, spec.tool);
  if (!tool) return ["skipped", `Not connected: no ${spec.tool} tool (check MCP connectors).`, null];
  let raw: unknown;
  try {
    raw = await (call ? call(tool, spec.args) : tool.invoke(spec.args));
  } catch (error) {
    // a failing server must not stop the scheduler
    return ["error", clip((error as Error)?.message || (error as Error)?.name || String(error), 200), null];
  }
  return spec.collect(decodeToolOutput(raw), now);
}
