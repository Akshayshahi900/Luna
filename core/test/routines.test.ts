// Routines: cron, the store, built-in data checks, agent routines
// (auto-reject of risky tools) and the scheduler. Fake tools and model only.
import { tool } from "@langchain/core/tools";
import { MemorySaver } from "@langchain/langgraph";
import { createAgent, humanInTheLoopMiddleware } from "langchain";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import * as z from "zod";

import type { LunaAgent } from "../src/agent/types.ts";
import { loadSettings } from "../src/config/settings.ts";
import { autoAnswer, REJECTED, routineThread, runAgentRoutine } from "../src/routines/agent.ts";
import { BUILTINS, decodeToolOutput, findTool, runBuiltin } from "../src/routines/builtin.ts";
import { CronError, describe as describeCron, nextRun, parse } from "../src/routines/cron.ts";
import { makeExecutor, RoutineScheduler } from "../src/routines/scheduler.ts";
import { KEEP_RUNS, RoutineRefused, RoutineStore } from "../src/routines/store.ts";
import { isRiskyToolName } from "../src/mcp/loader.ts";
import { isoUtc } from "../src/util/zoned.ts";
import { fakeModel, tmpDir, toolCall } from "./helpers.ts";

const at = (text: string) => Date.parse(text.endsWith("Z") || /[+-]\d\d:\d\d$/.test(text) ? text : text + "Z");
const settings = loadSettings({ envFile: null, env: {}, overrides: { openrouter_api_key: "t" } });

// --- cron ------------------------------------------------------------------------

describe("cron", () => {
  test("fields, lists, ranges and steps", () => {
    const cron = parse("*/15 8-10 1,15 * 1-5");
    expect(cron.minutes).toEqual(new Set([0, 15, 30, 45]));
    expect(cron.hours).toEqual(new Set([8, 9, 10]));
    expect(cron.days).toEqual(new Set([1, 15]));
    expect(cron.weekdays).toEqual(new Set([1, 2, 3, 4, 5]));
    expect(parse("0 0 * * 7").weekdays).toEqual(new Set([0])); // 7 is Sunday too
    expect(parse("5/20 * * * *").minutes).toEqual(new Set([5, 25, 45]));
    expect(parse("@daily").expr).toBe("0 0 * * *");
  });

  test.each(["", "* * * *", "60 * * * *", "* 24 * * *", "* * 0 * *", "*/0 * * * *", "a * * * *", "5-1 * * * *"])(
    "an invalid schedule is refused: %j",
    (bad) => expect(() => parse(bad)).toThrow(CronError),
  );

  test("the next run is strictly after", () => {
    expect(nextRun("*/15 * * * *", at("2026-10-18T10:15:00"), "UTC")).toBe(at("2026-10-18T10:30:00"));
    expect(nextRun("*/15 * * * *", at("2026-10-18T10:16:59"), "UTC")).toBe(at("2026-10-18T10:30:00"));
    expect(nextRun("0 8 * * *", at("2026-10-18T08:00:00"), "UTC")).toBe(at("2026-10-19T08:00:00"));
  });

  test("weekdays, months and leap days", () => {
    // 2026-10-17 is a Saturday → next weekday 09:00 is Monday the 19th.
    expect(nextRun("0 9 * * 1-5", at("2026-10-17T12:00:00"), "UTC")).toBe(at("2026-10-19T09:00:00"));
    expect(nextRun("30 6 1 * *", at("2026-12-15T00:00:00"), "UTC")).toBe(at("2027-01-01T06:30:00"));
    expect(nextRun("0 0 29 2 *", at("2026-03-01T00:00:00"), "UTC")).toBe(at("2028-02-29T00:00:00"));
  });

  test("day of month OR day of week, like cron", () => {
    // Both set: either one matches (the 1st, or any Monday).
    expect(nextRun("0 0 1 * 1", at("2026-10-02T00:00:00"), "UTC")).toBe(at("2026-10-05T00:00:00"));
  });

  test("the next run in a timezone", () => {
    expect(nextRun("0 8 * * *", at("2026-10-18T09:00:00+05:30"), "Asia/Kolkata")).toBe(at("2026-10-19T08:00:00+05:30"));
  });

  test("describe reads like English", () => {
    expect(describeCron("*/15 * * * *")).toBe("every 15 minutes");
    expect(describeCron("5 * * * *")).toBe("every hour at :05");
    expect(describeCron("0 */2 * * *")).toBe("every 2 hours at :00");
    expect(describeCron("0 8 * * *")).toBe("daily at 08:00");
    expect(describeCron("30 9 * * 1-5")).toBe("weekdays at 09:30");
    expect(describeCron("0 10 * * 0,6")).toBe("weekends at 10:00");
    expect(describeCron("0 18 * * 0")).toBe("Sunday at 18:00");
    expect(describeCron("0 7 1 * *")).toBe("monthly on day 1 at 07:00");
    expect(describeCron("0 7 1 1 *")).toBe("cron 0 7 1 1 *");
  });
});

// --- store ---------------------------------------------------------------------

let store: RoutineStore;
beforeEach(() => {
  store = new RoutineStore(":memory:", "UTC");
});
afterEach(() => store.close());

const NOW = { utc: at("2026-10-18T12:00:00"), zone: "UTC" };

describe("store", () => {
  test("built-ins are seeded once, switched off", () => {
    store.seedBuiltins();
    store.seedBuiltins();
    const routines = store.list();
    expect(routines.map((r) => r.builtin)).toEqual(Object.keys(BUILTINS));
    expect(routines.some((r) => r.enabled)).toBe(false);
    expect(routines[0].schedule).toBe("every 15 minutes");
  });

  test("add validates", () => {
    expect(() => store.add("Brief", "agent", "0 8 * * *")).toThrow(/prompt/);
    expect(() => store.add("Brief", "agent", "daily", { prompt: "hi" })).toThrow(/5 fields/);
    expect(() => store.add("X", "builtin", "* * * * *", { builtin: "nope" })).toThrow(/Unknown built-in/);
    expect(() => store.add("  ", "agent", "* * * * *", { prompt: "hi" })).toThrow(/name/);
  });

  test("update reschedules; built-ins can't be deleted", () => {
    store.seedBuiltins();
    const builtin = store.list()[0];
    expect(() => store.delete(builtin.id)).toThrow(/turned off/);
    let r = store.add("Brief", "agent", "0 8 * * *", { prompt: "hi" });
    const before = r.next_run_at;
    r = store.update(r.id, { cron: "*/5 * * * *", enabled: true, name: "Quick" });
    expect([r.name, r.enabled, r.schedule]).toEqual(["Quick", true, "every 5 minutes"]);
    expect(r.next_run_at).not.toBe(before);
    expect(() => store.update(r.id, { kind: "builtin" })).toThrow(/Can't change/);
    store.delete(r.id);
    expect(() => store.get(r.id)).toThrow(/No routine/);
  });

  test("due: only enabled and past", () => {
    const on = store.add("On", "agent", "* * * * *", { prompt: "hi", enabled: true });
    store.add("Off", "agent", "* * * * *", { prompt: "hi", enabled: false });
    expect(store.due(Date.now())).toEqual([]); // the next run is a minute away
    const later = Date.now() + 2 * 60_000;
    expect(store.due(later).map((r) => r.id)).toEqual([on.id]);
    store.scheduleNext(on.id, later);
    expect(store.due(later)).toEqual([]);
  });

  test("runs are recorded and trimmed", () => {
    const r = store.add("Brief", "agent", "* * * * *", { prompt: "hi" });
    for (let i = 0; i < KEEP_RUNS + 5; i++) store.finishRun(store.startRun(r.id), "ok", `run ${i}`, { n: i });
    const runs = store.runs(r.id, 1000);
    expect(runs).toHaveLength(KEEP_RUNS);
    expect(runs[0].summary).toBe(`run ${KEEP_RUNS + 4}`);
    expect(runs[0].data).toEqual({ n: KEEP_RUNS + 4 });
    expect(store.get(r.id).last_run?.status).toBe("ok");
    expect(store.recentRuns(1)[0].name).toBe("Brief");
  });

  test("interrupted runs are closed on open", () => {
    const file = `${tmpDir()}/r.sqlite`;
    let s = new RoutineStore(file);
    const r = s.add("Brief", "agent", "* * * * *", { prompt: "hi" });
    s.startRun(r.id);
    s.close();
    s = new RoutineStore(file);
    expect(s.runs(r.id)[0].status).toBe("error");
    s.close();
  });

  test("insights are the last ok run of enabled built-ins", () => {
    store.seedBuiltins();
    const mail = store.list().find((r) => r.builtin === "mail_check")!;
    store.update(mail.id, { enabled: true });
    store.finishRun(store.startRun(mail.id), "ok", "2 unread", { unread: 2 });
    store.finishRun(store.startRun(mail.id), "error", "offline");
    expect(store.insights().mail_check.data).toEqual({ unread: 2 });
    store.update(mail.id, { enabled: false });
    expect(store.insights()).toEqual({});
  });

  test("usage per day with gaps", () => {
    const today = store.today();
    store.addUsage("groq", "m", { runs: 1, model_calls: 3, tool_calls: 2 });
    store.addUsage("groq", "m", { runs: 1, model_calls: 2, errors: 1 });
    const twoDaysAgo = new Date(Date.parse(`${today}T00:00:00Z`) - 2 * 86_400_000).toISOString().slice(0, 10);
    store.addUsage("openrouter", "x", { model_calls: 4 }, twoDaysAgo);
    const usage = store.usage(3);
    expect(usage.days.map((d) => d.model_calls)).toEqual([4, 0, 5]);
    expect(usage.days.at(-1)).toEqual({ day: today, runs: 2, model_calls: 5, tool_calls: 2, errors: 1 });
    expect(usage.models[0].provider).toBe("groq");
  });
});

// --- built-ins -----------------------------------------------------------------

const fake = (name: string, run: () => unknown) => tool(async () => run(), { name, description: "Fake.", schema: z.object({}).passthrough() });
const TOOLS = {
  list_inbox: fake("list_inbox", () =>
    JSON.stringify([{ from: "Ann Lee <ann@x.com>", subject: "Lunch?", date: "d1" }, { from: "bot@x.com", subject: "Report", date: "d2" }])),
  get_agenda: fake("get_agenda", () =>
    JSON.stringify({
      date: "2026-10-18",
      events: [
        { title: "Standup", start: "2026-10-18T09:00:00+00:00", end: "2026-10-18T09:15:00+00:00" },
        { title: "Dentist", start: "2026-10-18T15:00:00+00:00", end: "2026-10-18T16:00:00+00:00" },
      ],
      tasks_due: [{}],
      overdue: [],
    })),
  list_tasks: fake("list_tasks", () =>
    JSON.stringify([
      { title: "Pay rent", due: "2026-10-18", done: false },
      { title: "Call mom", due: "2026-10-01T10:00", done: false },
      { title: "Someday", due: null, done: false },
      { title: "Old", due: "2026-10-01", done: true },
    ])),
};

describe("built-ins", () => {
  test("mail_check", async () => {
    const [status, summary, data] = await runBuiltin("mail_check", TOOLS, NOW);
    expect(status).toBe("ok");
    expect(summary).toBe("2 unread · latest from Ann Lee: Lunch? (+1 more)");
    expect(data.unread).toBe(2);
    expect(data.items[0].from).toBe("Ann Lee");
  });

  test("the agenda picks the next event", async () => {
    const [status, summary, data] = await runBuiltin("agenda", TOOLS, NOW);
    expect(status).toBe("ok");
    expect(summary).toBe("2 events today · next: Dentist (15:00)");
    expect(data.next.title).toBe("Dentist");
    expect(data.tasks_due).toBe(1);
  });

  test("todos counts due and overdue", async () => {
    const [status, summary, data] = await runBuiltin("todos", TOOLS, NOW);
    expect([status, summary]).toEqual(["ok", "3 open · 1 due today · 1 overdue"]);
    expect(data.items[0].title).toBe("Call mom"); // overdue first
  });

  test("a missing tool is skipped and errors are caught", async () => {
    expect((await runBuiltin("mail_check", {}, NOW))[0]).toBe("skipped");
    const broken = fake("list_tasks", () => {
      throw new Error("server down");
    });
    const [status, summary] = await runBuiltin("todos", { list_tasks: broken }, NOW);
    expect(status).toBe("error");
    expect(summary).toContain("server down");
  });

  test("built-ins find server-prefixed tools", async () => {
    const prefixed = Object.fromEntries(Object.entries(TOOLS).map(([n, t]) => [`mail_${n}`, t]));
    expect(findTool(prefixed, "list_inbox")).toBe(TOOLS.list_inbox);
    expect(findTool(TOOLS, "list_inbox")).toBe(TOOLS.list_inbox); // exact name wins
    expect(findTool({ a_list_tasks: 1, b_list_tasks: 2 }, "list_tasks")).toBeNull(); // ambiguous
    expect((await runBuiltin("todos", { tasks_list_tasks: TOOLS.list_tasks }, NOW))[0]).not.toBe("skipped");
  });

  test("decodeToolOutput shapes", () => {
    expect(decodeToolOutput('{"a": 1}')).toEqual({ a: 1 });
    expect(decodeToolOutput([{ type: "text", text: "[1, 2]" }])).toEqual([1, 2]);
    expect(decodeToolOutput([{ type: "text", text: "1" }, { type: "text", text: "2" }])).toEqual([1, 2]);
    expect(decodeToolOutput(["[3]", null])).toEqual([3]);
    expect(decodeToolOutput("not json")).toBe("not json");
  });

  test("built-ins only use read-only tools", () => {
    expect(Object.values(BUILTINS).some((s) => isRiskyToolName(s.tool))).toBe(false);
  });
});

// --- agent routines ------------------------------------------------------------

const sendEmail = tool(async () => {
  throw new Error("must never run without approval");
}, { name: "send_email", description: "Send an email.", schema: z.object({ to: z.string(), body: z.string() }) });

const brief = (prompt = "Morning brief please") => store.add("Brief", "agent", "0 8 * * *", { prompt });

describe("agent routines", () => {
  test("run on their own thread", async () => {
    const agent = createAgent({ model: fakeModel("Three emails, one meeting.") as never, tools: [], checkpointer: new MemorySaver() }) as unknown as LunaAgent;
    const routine = brief();
    const [status, summary, data] = await runAgentRoutine(agent, routine, settings);
    expect([status, summary]).toEqual(["ok", "Three emails, one meeting."]);
    expect(data).toEqual({ thread: routineThread(routine.id), rejected: [] });
    const state = await agent.getState({ configurable: { thread_id: routineThread(routine.id) } });
    expect(state.values.messages[0].text).toBe("Morning brief please");
  });

  test("reject risky tools", async () => {
    const model = fakeModel(toolCall("send_email", "c1", { to: "boss@x.com", body: "hi" }), "Couldn't send: needs approval.");
    const agent = createAgent({
      model: model as never, tools: [sendEmail], checkpointer: new MemorySaver(),
      middleware: [humanInTheLoopMiddleware({ interruptOn: { send_email: true } })],
    }) as unknown as LunaAgent;
    const [status, summary, data] = await runAgentRoutine(agent, brief(), settings);
    expect(status).toBe("ok");
    expect(data.rejected).toEqual(["send_email"]);
    expect(summary).toBe("Couldn't send: needs approval.");
    expect(model.inputs.at(-1)!.some((t) => t.includes(REJECTED))).toBe(true);
  });

  test("autoAnswer formats", () => {
    const approval = { id: "p", kind: "approval" as const, actions: [{ name: "a" }, { name: "b" }] as never };
    expect((autoAnswer(approval) as { decisions: { type: string }[] }).decisions.map((d) => d.type)).toEqual(["reject", "reject"]);
    expect((autoAnswer({ id: "q", kind: "question", question: "?" }) as { answer: string }).answer).toContain("away");
  });
});

// --- scheduler -----------------------------------------------------------------

describe("scheduler", () => {
  test("tick runs due routines and notifies", async () => {
    store.seedBuiltins();
    const todos = store.list().find((r) => r.builtin === "todos")!;
    store.update(todos.id, { enabled: true });
    const events: Record<string, any>[] = [];
    const scheduler = new RoutineScheduler(store, makeExecutor(() => TOOLS, null, store), (e) => events.push(e));
    expect(await scheduler.tick()).toEqual([]); // not due yet
    store.db.exec("UPDATE routines SET next_run_at = '2000-01-01T00:00:00+00:00'");
    const [run] = await scheduler.tick();
    expect(run.status).toBe("ok");
    expect(run.summary).toContain("open");
    expect(events[0].type).toBe("routine_result");
    expect(events[0].routine.builtin).toBe("todos");
    expect(store.get(todos.id).next_run_at! > isoUtc()).toBe(true);
    expect(await scheduler.tick()).toEqual([]);
  });

  test("runNow records failures", async () => {
    const routine = brief();
    const scheduler = new RoutineScheduler(store, makeExecutor(() => ({}), async () => {
      throw new Error("model offline");
    }, store));
    const run = await scheduler.runNow(routine.id);
    expect([run.status, run.error]).toEqual(["error", "model offline"]);
    expect(scheduler.running.size).toBe(0);
  });

  test("the same routine never runs twice at once", async () => {
    const routine = brief();
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const scheduler = new RoutineScheduler(store, async () => {
      await gate;
      return ["ok", "done", null];
    });
    const first = scheduler.runNow(routine.id);
    await expect(scheduler.runNow(routine.id)).rejects.toThrow(/already running/);
    open();
    expect((await first).summary).toBe("done");
  });

  test("start and stop", async () => {
    const scheduler = new RoutineScheduler(store, makeExecutor(() => ({}), null, store), null, 0.01);
    scheduler.start();
    expect(scheduler.active).toBe(true);
    await new Promise((r) => setTimeout(r, 30));
    await scheduler.stop();
    expect(scheduler.active).toBe(false);
  });
});
