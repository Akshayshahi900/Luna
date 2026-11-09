import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { tool } from "@langchain/core/tools";
import { afterAll, afterEach, beforeEach, describe, expect, test } from "vitest";
import * as z from "zod";

import * as tasksServer from "../servers/tasks.ts";
import { getSubagentSpecs } from "../src/agent/subagents/index.ts";
import { loadSettings, PROJECT_ROOT } from "../src/config/settings.ts";
import * as googleApi from "../src/integrations/google.ts";
import { closeMcpClients, loadMcpConfig, loadMcpTools, splitByAgent } from "../src/mcp/loader.ts";
import type { AnyTool } from "../src/tools/registry.ts";
import { missing, tmpDir } from "./helpers.ts";
import { fakeEmail } from "./mail_fakes.ts";

const SERVER = path.join(PROJECT_ROOT, "core", "servers", "tasks.ts");
const realService = googleApi.hooks.service;
const realDeps = { ...tasksServer.deps };
let dir: string;
const stored = () => JSON.parse(readFileSync(path.join(dir, "tasks.json"), "utf8"));

beforeEach(() => {
  dir = tmpDir();
  process.env.LUNA_TASKS_PATH = path.join(dir, "tasks.json");
});
afterEach(() => {
  googleApi.hooks.service = realService;
  Object.assign(tasksServer.deps, realDeps);
  delete process.env.LUNA_TASKS_PATH;
  delete process.env.LUNA_MAIL_BACKEND;
});
afterAll(() => closeMcpClients());

test("add, list, done, delete over MCP", async () => {
  const tools = Object.fromEntries(
    (await loadMcpTools({ mcpServers: { tasks: { command: process.execPath, args: [SERVER], env: { PATH: process.env.PATH!, LUNA_TASKS_PATH: process.env.LUNA_TASKS_PATH!, LUNA_GOOGLE_TOKEN_PATH: path.join(dir, "none.json") } } } })).map((t) => [t.name, t]),
  );
  expect(new Set(Object.keys(tools))).toEqual(new Set(["list_tasks", "add_task", "set_task_done", "delete_task", "add_task_from_email"]));
  await tools.add_task.invoke({ title: "later" });
  await tools.add_task.invoke({ title: "dentist", due: "2026-10-20" });
  expect(stored().map((s: { title: string }) => s.title)).toEqual(["later", "dentist"]);
  // Soonest due first, undated last.
  expect((await tasksServer.listTasks()).map((x) => x.title)).toEqual(["dentist", "later"]);
  await tools.set_task_done.invoke({ task_id: 2 });
  expect((await tasksServer.listTasks()).map((x) => x.title)).toEqual(["later"]);
  expect(await tasksServer.listTasks(true)).toHaveLength(2);
  await tools.delete_task.invoke({ task_id: 1 });
  expect((await tasksServer.listTasks(true)).map((x) => x.id)).toEqual([2]);
  // A tool error is an MCP error result; the adapter raises it, and inside an
  // agent the tool node hands the message to the model.
  await expect(tools.add_task.invoke({ title: "  " })).rejects.toThrow(/title must not be empty/);
});

test("ids keep increasing after a delete", async () => {
  await tasksServer.addTask("a");
  await tasksServer.addTask("b");
  await tasksServer.deleteTask(1);
  expect((await tasksServer.addTask("c")).id).toBe(3);
});

test("bad input is rejected", async () => {
  await expect(tasksServer.addTask("x", "next tuesday")).rejects.toThrow(/due must be/);
  await expect(tasksServer.addTask("   ")).rejects.toThrow(/title/);
  await expect(tasksServer.setTaskDone(7)).rejects.toThrow(/No task with id 7/);
  expect((await tasksServer.addTask("x", "2026-10-20T09:30:00")).due).toBe("2026-10-20T09:30");
});

test("the repo config routes tasks to the assistant with approval", () => {
  const groups = splitByAgent(loadMcpConfig(path.join(PROJECT_ROOT, "config", "mcp_servers.json"))!);
  expect(Object.keys(groups.get("assistant")!.mcpServers)).toContain("tasks");
  const names = ["list_tasks", "add_task", "set_task_done", "delete_task", "add_task_from_email"];
  const fake = (n: string) => tool(async () => "ok", { name: n, description: "Fake MCP tool.", schema: z.object({}) }) as unknown as AnyTool;
  const s = loadSettings({ envFile: null, env: {}, overrides: { openrouter_api_key: "test", workspace_dirs: [path.join(dir, "ws")] } });
  const assistant = getSubagentSpecs(s, new Map([["assistant", names.map(fake)]])).find((x) => x.name === "ask_assistant")!;
  expect(assistant.interruptOn).toEqual({ add_task: true, set_task_done: true, delete_task: true, add_task_from_email: true });
});

test("without a Google sign-in tasks stay local", async () => {
  // test/setup.ts points LUNA_GOOGLE_TOKEN_PATH at a missing file: no sync, no error.
  expect((await tasksServer.addTask("local only")).synced).toBe(false);
});

// --- Google Tasks sync ---------------------------------------------------------

const OLD = "2000-01-01T00:00:00.000Z";
const NEW = "2999-01-01T00:00:00.000Z";

/** Tasks v1 client (googleapis shape): tasks.list (paged, shows deleted) / insert / patch / delete. */
class FakeGoogleTasks {
  items = new Map<string, Record<string, any>>();
  pageSize = 100;
  clock = 0;
  calls: string[] = [];
  tasks = {
    list: async ({ pageToken, maxResults: _max, tasklist: _list, ...kw }: Record<string, any>) => {
      expect(kw).toEqual({ showCompleted: true, showHidden: true, showDeleted: true });
      this.calls.push("list");
      const start = Number(pageToken ?? 0);
      const all = [...this.items.values()];
      const page = all.slice(start, start + this.pageSize).map((t) => ({ ...t }));
      const more = start + this.pageSize < all.length;
      return { data: { items: page, ...(more ? { nextPageToken: String(start + this.pageSize) } : {}) } };
    },
    insert: async ({ requestBody }: Record<string, any>) => {
      this.calls.push("insert");
      const task = { ...requestBody, id: `g${this.items.size + 1}`, updated: this.stamp() };
      this.items.set(task.id, task);
      return { data: task };
    },
    patch: async ({ task, requestBody }: Record<string, any>) => {
      this.calls.push("patch");
      if (!this.items.has(task)) missing("task", task);
      Object.assign(this.items.get(task)!, requestBody, { updated: this.stamp() });
      return { data: this.items.get(task) };
    },
    delete: async ({ task }: Record<string, any>) => {
      this.calls.push("delete");
      this.items.get(task)!.deleted = true;
      return { data: "" };
    },
  };

  stamp() {
    this.clock += 1;
    return `2026-10-18T00:00:${String(this.clock).padStart(2, "0")}.000Z`;
  }

  /** A change made in the Google Tasks app (by default newer than any local change). */
  edit(taskId: string, fields: Record<string, unknown>, updated?: string) {
    this.clock += 1;
    Object.assign(this.items.get(taskId)!, fields, { updated: updated ?? `2999-01-01T00:00:${String(this.clock).padStart(2, "0")}.000Z` });
  }
}

describe("Google Tasks sync", () => {
  let google: FakeGoogleTasks;
  beforeEach(() => {
    const token = path.join(dir, "token.json");
    writeFileSync(token, "{}"); // isConnected only checks that the file exists
    process.env.LUNA_GOOGLE_TOKEN_PATH = token;
    google = new FakeGoogleTasks();
    googleApi.hooks.service = async () => google;
  });

  test("a new local task is pushed", async () => {
    const task = await tasksServer.addTask("dentist", "2026-10-20T09:30", "bring card");
    expect(task.synced).toBe(true);
    const remote = google.items.get("g1")!;
    expect([remote.title, remote.due, remote.notes, remote.status]).toEqual(["dentist", "2026-10-20T00:00:00.000Z", "bring card", "needsAction"]);
  });

  test("open Google tasks are pulled and completed ones skipped", async () => {
    google.items = new Map(Object.entries({
      a: { id: "a", title: "from phone", due: "2026-10-21T00:00:00.000Z", status: "needsAction", updated: OLD },
      b: { id: "b", title: "old and done", status: "completed", updated: OLD },
      c: { id: "c", title: "", status: "needsAction", updated: OLD },
    }));
    google.pageSize = 1; // every page is read
    const listed = await tasksServer.listTasks(true);
    expect(listed.map((t) => [t.title, t.due, t.synced])).toEqual([["from phone", "2026-10-21", true]]);
  });

  test("changes flow both ways", async () => {
    const task = await tasksServer.addTask("call mom", "2026-10-20T18:00");
    await tasksServer.setTaskDone(task.id); // done locally → pushed
    expect(google.items.get("g1")!.status).toBe("completed");
    // Reopened and renamed in Google → pulled; the local time survives the same day.
    google.edit("g1", { title: "call mom and dad", status: "needsAction" });
    const [pulled] = await tasksServer.listTasks();
    expect([pulled.title, pulled.done, pulled.due]).toEqual(["call mom and dad", false, "2026-10-20T18:00"]);
    // Moved to another day in Google → the local due follows (Google has no time).
    google.edit("g1", { due: "2026-10-22T00:00:00.000Z" });
    expect((await tasksServer.listTasks())[0].due).toBe("2026-10-22");
    expect(stored()[0].dirty).toBe(false);
  });

  test("a conflict: the newest change wins", async () => {
    const task = await tasksServer.addTask("draft");
    // A local change Google hasn't seen yet, and an older change in Google.
    tasksServer.deps.synced = async () => undefined;
    await tasksServer.setTaskDone(task.id);
    tasksServer.deps.synced = realDeps.synced;
    google.edit("g1", { title: "older remote edit" }, OLD);
    await tasksServer.listTasks(true);
    expect(google.items.get("g1")!.status).toBe("completed"); // local was newer: pushed

    tasksServer.deps.synced = async () => undefined;
    await tasksServer.setTaskDone(task.id, false);
    tasksServer.deps.synced = realDeps.synced;
    google.edit("g1", { title: "newer remote edit" }, NEW);
    const [kept] = await tasksServer.listTasks(true);
    expect([kept.title, kept.done]).toEqual(["newer remote edit", true]); // Google was newer: pulled
  });

  test("deletes flow both ways", async () => {
    const a = await tasksServer.addTask("a");
    await tasksServer.addTask("b");
    await tasksServer.deleteTask(a.id);
    expect(google.items.get("g1")!.deleted).toBe(true);
    expect(stored().map((t: { title: string }) => t.title)).toEqual(["b"]);
    google.edit("g2", { deleted: true });
    expect(await tasksServer.listTasks()).toEqual([]);
  });

  test("offline changes wait for the next sync", async () => {
    googleApi.hooks.service = async () => {
      throw new Error("Google API error 503: unavailable");
    };
    const task = await tasksServer.addTask("buy milk");
    expect(task.synced).toBe(false);
    await tasksServer.deleteTask((await tasksServer.addTask("typo")).id); // never reached Google: just gone
    expect((await tasksServer.listTasks()).map((t) => t.title)).toEqual(["buy milk"]);
    googleApi.hooks.service = async () => google;
    expect((await tasksServer.listTasks())[0].synced).toBe(true);
    expect([...google.items.values()].map((t) => t.title)).toEqual(["buy milk"]);
  });

  test("a delete while offline reaches Google later", async () => {
    const task = await tasksServer.addTask("cancel gym");
    googleApi.hooks.service = async () => {
      throw new Error("offline");
    };
    await tasksServer.deleteTask(task.id);
    expect(await tasksServer.listTasks()).toEqual([]); // hidden locally right away
    expect(stored()[0].deleted).toBe(true); // kept until Google knows
    googleApi.hooks.service = async () => google;
    await tasksServer.listTasks();
    expect(google.items.get("g1")!.deleted).toBe(true);
    expect(stored()).toEqual([]);
  });

  test("a task from an email links back and does not duplicate", async () => {
    process.env.LUNA_MAIL_BACKEND = "gmail";
    const email = await fakeEmail({ from: "Bob <bob@example.com>", subject: "Invoice 42", messageId: "<m7@example.com>", body: "Please pay by Friday." });
    tasksServer.deps.fetchEmail = async () => email;
    const first = await tasksServer.addTaskFromEmail("7", "", "2026-10-23");
    expect(first.created).toBe(true);
    const task = first.task;
    expect([task.title, task.due, task.from_email]).toEqual(["Invoice 42", "2026-10-23", "<m7@example.com>"]);
    expect(task.notes).toContain("rfc822msgid:m7%40example.com");
    expect(google.items.get("g1")!.notes).toBe(task.notes); // the link reaches Google Tasks too
    const again = await tasksServer.addTaskFromEmail("7");
    expect(again.created).toBe(false);
    expect(again.task.id).toBe(task.id);
    expect(google.items.size).toBe(1);
  });
});
