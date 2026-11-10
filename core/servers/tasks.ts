/**
 * To-do / reminder MCP server — a local list, two-way synced with Google Tasks.
 *
 * BEGINNER MAP
 * ------------
 * Like servers/demo.ts, this is a separate program that Luna starts and
 * talks to over stdio. config/mcp_servers.json tags it with
 * "agent": "assistant", so its tools go to the assistant helper (not the
 * main agent), and that is what turns ask_assistant on.
 *
 * Tasks live in one JSON file (default data/tasks.json, override with
 * LUNA_TASKS_PATH). The file is the source of truth, so the list works
 * offline and without a Google account.
 *
 * Google Tasks sync (LUNA_TASKS_GOOGLE_SYNC, on by default): when you are
 * signed in (luna-google-auth), every tool call first syncs the file with one
 * Google task list (LUNA_GOOGLE_TASKLIST_ID) both ways:
 *
 *   local only           → created in Google
 *   changed locally      → pushed to Google
 *   changed in Google    → pulled into the file
 *   changed in both      → the newer change wins
 *   deleted on one side  → deleted on the other
 *   new open Google task → added to the file (completed ones are not imported)
 *
 * Not signed in, or Google unreachable: the tools keep working on the file
 * alone; unsynced changes go up on the next successful sync. Each task says
 * "synced": true once Google has its latest version.
 *
 * Tools:
 *   list_tasks           read-only, runs without asking
 *   add_task             ┐
 *   set_task_done        │ names contain add/set/delete → Luna asks for approval
 *   delete_task          │ (unless listed in LUNA_AUTO_APPROVE)
 *   add_task_from_email  ┘ a to-do from an email (mail server), linked back to it
 *
 * Try it alone:
 *
 *     node core/servers/tasks.ts
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod";

import { loadSettings, PROJECT_ROOT, type Settings } from "../src/config/settings.ts";
import * as googleApi from "../src/integrations/google.ts";
import { guarded, runStdio } from "./common.ts";
import * as mail from "./mail.ts";

export const DEFAULT_PATH = path.join(PROJECT_ROOT, "data", "tasks.json");
// Line in a task's notes that links it to the email it came from.
const EMAIL_MARKER = /\[luna-email:(.+?)\]/;

/** A task as stored in the file (sync bookkeeping included). */
export interface Task {
  id: number;
  title: string;
  due: string | null;
  notes: string;
  done: boolean;
  created: string;
  updated?: string;
  dirty?: boolean;
  deleted?: boolean;
  google_id?: string;
  google_updated?: string;
}

/** What the model sees (sync bookkeeping left out). */
export interface PublicTask {
  id: number;
  title: string;
  due: string | null;
  notes: string;
  done: boolean;
  created: string;
  synced: boolean;
  from_email: string;
}

// Read per call so tests (and users) can point it elsewhere.
const tasksPath = () => process.env.LUNA_TASKS_PATH || DEFAULT_PATH;

function load(): Task[] {
  const file = tasksPath();
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Task[]) : [];
}

function save(tasks: Task[]): void {
  const file = tasksPath();
  mkdirSync(path.dirname(file), { recursive: true });
  // Write a temp file then rename, so a crash never leaves half a file.
  const tmp = file.replace(/\.json$/, "") + ".tmp";
  writeFileSync(tmp, JSON.stringify(tasks, null, 2), "utf8");
  renameSync(tmp, file);
}

const now = () => new Date().toISOString().slice(0, 19) + "+00:00";

/** Mark a local change, so the next sync pushes it. */
function touch(task: Task): void {
  task.updated = now();
  task.dirty = true;
}

/** Accept YYYY-MM-DD or an ISO date-time; return it normalized (minutes). */
export function checkDue(due: string): string {
  const fail = () => new Error(`due must be YYYY-MM-DD or YYYY-MM-DDTHH:MM, got '${due}'`);
  const validDay = (day: string) => !Number.isNaN(Date.parse(`${day}T00:00:00Z`)) && new Date(`${day}T00:00:00Z`).toISOString().startsWith(day);
  if (due.length === 10) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(due) || !validDay(due)) throw fail();
    return due;
  }
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/.exec(due);
  if (!m || !validDay(m[1]) || Number(m[2]) > 23 || Number(m[3]) > 59) throw fail();
  let offset = m[4] ?? "";
  if (offset === "Z") offset = "+00:00";
  else if (offset && !offset.includes(":")) offset = `${offset.slice(0, 3)}:${offset.slice(3)}`;
  return `${m[1]}T${m[2]}:${m[3]}${offset}`;
}

function find(tasks: Task[], taskId: number): Task {
  const task = tasks.find((t) => t.id === taskId && !t.deleted);
  if (!task) throw new Error(`No task with id ${taskId}. Call list_tasks to see ids.`);
  return task;
}

export function publicTask(task: Task): PublicTask {
  const linked = EMAIL_MARKER.exec(task.notes || "");
  return {
    id: task.id,
    title: task.title,
    due: task.due ?? null,
    notes: task.notes ?? "",
    done: task.done ?? false,
    created: task.created,
    synced: Boolean(task.google_id) && !task.dirty,
    from_email: linked ? linked[1] : "",
  };
}

// --- Google Tasks sync -------------------------------------------------------

const stamp = (value: string) => Date.parse(value);

/** The Google Tasks fields for a local task (Google keeps only the due date). */
function remoteBody(task: Task): Record<string, unknown> {
  const body: Record<string, unknown> = {
    title: task.title,
    notes: task.notes ?? "",
    due: task.due ? `${task.due.slice(0, 10)}T00:00:00.000Z` : null,
    status: task.done ? "completed" : "needsAction",
  };
  if (!task.done) body.completed = null; // clearing it is what reopens a Google task
  return body;
}

type Remote = Record<string, any>;

/** Copy a Google task into the local one. */
function pull(task: Task, remote: Remote): void {
  task.title = remote.title ?? "";
  task.notes = remote.notes ?? "";
  const remoteDay = String(remote.due ?? "").slice(0, 10) || null;
  if ((task.due ?? "").slice(0, 10) !== (remoteDay ?? "")) task.due = remoteDay; // a local time is kept while the day still matches
  task.done = remote.status === "completed";
  task.updated = remote.updated ?? now();
  task.google_updated = remote.updated ?? "";
  task.dirty = false;
}

/** Every task in the Google list, including completed, hidden and deleted ones. */
async function remoteTasks(api: any, tasklist: string): Promise<Map<string, Remote>> {
  const found = new Map<string, Remote>();
  let page: string | undefined;
  for (;;) {
    const params: Record<string, unknown> = { tasklist, showCompleted: true, showHidden: true, showDeleted: true, maxResults: 100 };
    if (page) params.pageToken = page;
    const response = await googleApi.execute(api.list(params));
    for (const item of response.items ?? []) found.set(item.id, item);
    page = response.nextPageToken;
    if (!page) return found;
  }
}

/**
 * Two-way sync `tasks` (in place) with Google Tasks. false when sync is off.
 *
 * Throws on Google errors; every step records its result on the task right
 * after Google accepts it, so a sync cut short leaves a consistent file.
 */
export async function syncWithGoogle(tasks: Task[], settings: Settings): Promise<boolean> {
  if (!settings.tasks_google_sync || !googleApi.isConnected(settings)) return false;
  const api = (await googleApi.service("tasks", "v1", settings)).tasks;
  const tasklist = settings.google_tasklist_id;
  const remote = await remoteTasks(api, tasklist);
  const linked = new Set<string>();
  const remove = (task: Task) => tasks.splice(tasks.indexOf(task), 1);

  for (const task of [...tasks]) {
    const googleId = task.google_id;
    const theirs = googleId ? remote.get(googleId) : undefined;
    if (googleId) linked.add(googleId);
    if (task.deleted) {
      // deleted here while offline
      if (theirs && !theirs.deleted) await googleApi.execute(api.delete({ tasklist, task: googleId }));
      remove(task);
    } else if (!googleId) {
      // new here
      const created = await googleApi.execute(api.insert({ tasklist, requestBody: remoteBody(task) }));
      task.google_id = created.id;
      task.google_updated = created.updated ?? "";
      task.dirty = false;
      linked.add(created.id);
    } else if (!theirs || theirs.deleted) {
      remove(task); // deleted in Google
    } else {
      const changedThere = (theirs.updated ?? "") !== task.google_updated;
      if (task.dirty && changedThere && stamp(theirs.updated) > stamp(task.updated!)) {
        pull(task, theirs); // both changed, Google's is newer
      } else if (task.dirty) {
        const pushed = await googleApi.execute(api.patch({ tasklist, task: googleId, requestBody: remoteBody(task) }));
        task.google_updated = pushed.updated ?? "";
        task.dirty = false;
      } else if (changedThere) {
        pull(task, theirs);
      }
    }
  }

  let nextId = Math.max(0, ...tasks.map((t) => t.id)) + 1;
  for (const [googleId, theirs] of remote) {
    if (linked.has(googleId) || theirs.deleted || theirs.status === "completed") continue;
    if (!String(theirs.title ?? "").trim()) continue; // Google keeps empty placeholder rows
    const task: Task = { id: nextId, title: "", due: null, notes: "", done: false, created: now(), google_id: googleId };
    pull(task, theirs);
    tasks.push(task);
    nextId += 1;
  }
  return true;
}

/** Sync if possible; on any Google problem keep working locally. */
async function synced(tasks: Task[]): Promise<void> {
  try {
    await syncWithGoogle(tasks, loadSettings());
  } catch (error) {
    // offline / expired sign-in must not break to-dos
    console.error(`Google Tasks sync skipped: ${(error as Error).message}`);
  }
}

/** Replaceable in tests. */
export const deps = { synced, fetchEmail: mail.fetchEmail };

function newTask(tasks: Task[], title: string, due: string | null | undefined, notes: string): Task {
  title = title.trim();
  if (!title) throw new Error("title must not be empty");
  const task: Task = {
    id: Math.max(0, ...tasks.map((t) => t.id)) + 1,
    title,
    due: due ? checkDue(due) : null,
    notes,
    done: false,
    created: now(),
  };
  touch(task);
  tasks.push(task);
  return task;
}

// --- Tools -------------------------------------------------------------------

/** To-dos and reminders, soonest due first (undated ones last). */
export async function listTasks(includeDone = false): Promise<PublicTask[]> {
  const tasks = load();
  await deps.synced(tasks);
  save(tasks);
  const shown = tasks.filter((t) => !t.deleted && (includeDone || !t.done));
  shown.sort((a, b) => {
    if ((a.due === null) !== (b.due === null)) return a.due === null ? 1 : -1;
    if ((a.due ?? "") !== (b.due ?? "")) return (a.due ?? "") < (b.due ?? "") ? -1 : 1;
    return a.id - b.id;
  });
  return shown.map(publicTask);
}

export async function addTask(title: string, due: string | null = null, notes = ""): Promise<PublicTask> {
  const tasks = load();
  const task = newTask(tasks, title, due, notes);
  await deps.synced(tasks);
  save(tasks);
  return publicTask(task);
}

export async function setTaskDone(taskId: number, done = true): Promise<PublicTask> {
  const tasks = load();
  const task = find(tasks, taskId);
  task.done = done;
  touch(task);
  await deps.synced(tasks);
  save(tasks);
  return publicTask(task);
}

export async function deleteTask(taskId: number): Promise<string> {
  const tasks = load();
  const task = find(tasks, taskId);
  if (task.google_id) {
    task.deleted = true; // kept until Google has deleted it too
    touch(task);
  } else {
    tasks.splice(tasks.indexOf(task), 1);
  }
  await deps.synced(tasks);
  save(tasks);
  return `Deleted task ${taskId}: ${task.title}`;
}

export async function addTaskFromEmail(uid: string, title = "", due: string | null = null, folder = "INBOX") {
  const ref = mail.emailReference(await deps.fetchEmail(uid, folder), uid, folder);
  const tasks = load();
  await deps.synced(tasks);
  for (const task of tasks) {
    if (!task.deleted && publicTask(task).from_email === ref.id) {
      save(tasks);
      return { created: false, note: "A to-do for this email already exists", task: publicTask(task) };
    }
  }
  const task = newTask(tasks, title.trim() || ref.subject || `Email from ${ref.from}`, due, `${mail.referenceText(ref)}\n[luna-email:${ref.id}]`);
  await deps.synced(tasks);
  save(tasks);
  return { created: true, task: publicTask(task) };
}

export function createServer(): McpServer {
  const server = new McpServer({ name: "luna-tasks", version: "1.0.0" });
  server.registerTool(
    "list_tasks",
    {
      description:
        "List to-dos and reminders, soonest due first (undated ones last).\n" +
        "Synced with Google Tasks when the user is signed in.",
      inputSchema: { include_done: z.boolean().default(false) },
    },
    ({ include_done }) => guarded(() => listTasks(include_done)),
  );
  server.registerTool(
    "add_task",
    {
      description:
        "Add a to-do. due is optional: YYYY-MM-DD or YYYY-MM-DDTHH:MM (local time;\n" +
        "Google Tasks shows the date only).",
      inputSchema: { title: z.string(), due: z.string().nullable().optional(), notes: z.string().default("") },
    },
    ({ title, due, notes }) => guarded(() => addTask(title, due ?? null, notes)),
  );
  server.registerTool(
    "set_task_done",
    {
      description: "Mark a to-do done (or not done again with done=false).",
      inputSchema: { task_id: z.number().int(), done: z.boolean().default(true) },
    },
    ({ task_id, done }) => guarded(() => setTaskDone(task_id, done)),
  );
  server.registerTool(
    "delete_task",
    { description: "Delete a to-do permanently (also from Google Tasks).", inputSchema: { task_id: z.number().int() } },
    ({ task_id }) => guarded(() => deleteTask(task_id)),
  );
  server.registerTool(
    "add_task_from_email",
    {
      description:
        "Make a to-do from an email (uid from list_inbox / search_emails).\n" +
        "title defaults to the subject; the notes link back to the email. If a\n" +
        "to-do for this email exists already, it is returned instead.",
      inputSchema: { uid: z.string(), title: z.string().default(""), due: z.string().nullable().optional(), folder: z.string().default("INBOX") },
    },
    ({ uid, title, due, folder }) => guarded(() => addTaskFromEmail(uid, title, due ?? null, folder)),
  );
  return server;
}

if (import.meta.main) await runStdio(createServer(), new StdioServerTransport());
