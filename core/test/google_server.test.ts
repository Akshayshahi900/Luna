import { writeFileSync } from "node:fs";
import path from "node:path";

import { tool } from "@langchain/core/tools";
import { afterAll, afterEach, beforeEach, describe, expect, test } from "vitest";
import * as z from "zod";

import * as googleServer from "../servers/google.ts";
import * as todos from "../servers/tasks.ts";
import { getSubagentSpecs } from "../src/agent/subagents/index.ts";
import { loadSettings, PROJECT_ROOT } from "../src/config/settings.ts";
import * as googleApi from "../src/integrations/google.ts";
import { closeMcpClients, loadMcpConfig, loadMcpTools, splitByAgent } from "../src/mcp/loader.ts";
import type { AnyTool } from "../src/tools/registry.ts";
import { missing, tmpDir } from "./helpers.ts";
import { fakeEmail, type FakeMail } from "./mail_fakes.ts";

const SERVER = path.join(PROJECT_ROOT, "core", "servers", "google.ts");
const READ_ONLY = ["list_events", "get_agenda"];
const RISKY = ["create_event", "update_event", "delete_event", "create_event_from_email"];
const realService = googleApi.hooks.service;
const realDeps = { ...googleServer.deps };
afterAll(() => closeMcpClients());

/** Calendar v3 events.list/get/insert/patch/delete (googleapis shape). */
class FakeCalendar {
  items = new Map<string, Record<string, any>>();
  calls: [string, Record<string, any>][] = [];
  events = {
    list: async (kw: Record<string, any>) => {
      this.calls.push(["list", kw]);
      let items = [...this.items.values()];
      if (kw.privateExtendedProperty) {
        const [key, value] = String(kw.privateExtendedProperty).split(/=(.*)/s);
        items = items.filter((e) => e.extendedProperties?.private?.[key] === value);
      }
      return { data: { items } };
    },
    get: async ({ eventId }: Record<string, any>) => {
      if (!this.items.has(eventId)) missing("event", eventId);
      return { data: { ...this.items.get(eventId) } };
    },
    insert: async ({ requestBody, calendarId: _c, ...kw }: Record<string, any>) => {
      this.calls.push(["insert", { body: requestBody, ...kw }]);
      const event = { id: `e${this.items.size + 1}`, htmlLink: "https://cal/x", ...requestBody };
      this.items.set(event.id, event);
      return { data: event };
    },
    patch: async ({ eventId, requestBody, calendarId: _c, ...kw }: Record<string, any>) => {
      this.calls.push(["patch", { body: requestBody, ...kw }]);
      Object.assign(this.items.get(eventId)!, requestBody);
      return { data: this.items.get(eventId) };
    },
    delete: async ({ eventId, calendarId: _c, ...kw }: Record<string, any>) => {
      this.calls.push(["delete", { eventId, ...kw }]);
      this.items.delete(eventId);
      return { data: "" };
    },
  };
}

const email = (m: FakeMail = {}) =>
  fakeEmail({ subject: "Lunch on Friday?", from: "Bob <bob@example.com>", messageId: "<m7@example.com>", body: "Shall we meet at 1pm at Cafe Blue?", ...m });

test("the tool catalog over MCP", async () => {
  const tools = await loadMcpTools({ mcpServers: { google: { command: process.execPath, args: [SERVER] } } });
  expect(new Set(tools.map((t) => t.name))).toEqual(new Set([...READ_ONLY, ...RISKY]));
});

test("eventTimes", () => {
  const tz = "Asia/Kolkata";
  expect(googleServer.eventTimes("2026-10-20T09:30", "", tz)).toEqual([
    { dateTime: "2026-10-20T09:30:00+05:30" }, { dateTime: "2026-10-20T10:30:00+05:30" },
  ]);
  // All-day: end is the last day, Google's end is exclusive.
  expect(googleServer.eventTimes("2026-10-20", "2026-10-21", tz)).toEqual([{ date: "2026-10-20" }, { date: "2026-10-22" }]);
  expect(() => googleServer.eventTimes("2026-10-20T09:30", "2026-10-20T09:00", tz)).toThrow(/end must be after start/);
  expect(() => googleServer.eventTimes("2026-10-20T09:30", "2026-10-21", tz)).toThrow(/needs a time/);
  expect(() => googleServer.eventTimes("next tuesday", "", tz)).toThrow(/YYYY-MM-DD/);
  // An offset in the text wins; DST zones get the offset of that day.
  expect(googleServer.eventTimes("2026-10-20T09:30Z", "", tz)[0]).toEqual({ dateTime: "2026-10-20T09:30:00+00:00" });
  expect(googleServer.eventTimes("2026-07-01T09:00", "", "Europe/London")[0]).toEqual({ dateTime: "2026-07-01T09:00:00+01:00" });
  expect(googleServer.eventTimes("2026-12-01T09:00", "", "Europe/London")[0]).toEqual({ dateTime: "2026-12-01T09:00:00+00:00" });
});

describe("with a fake calendar", () => {
  let calendar: FakeCalendar;
  let emails: Record<string, Awaited<ReturnType<typeof email>>>;

  beforeEach(async () => {
    const dir = tmpDir();
    process.env.LUNA_TASKS_PATH = path.join(dir, "tasks.json");
    const s = loadSettings({ envFile: null, env: { ...process.env, LUNA_TIMEZONE: "Asia/Kolkata", LUNA_MAIL_BACKEND: "gmail" } });
    googleServer.deps.settings = () => s;
    calendar = new FakeCalendar();
    googleApi.hooks.service = async () => calendar;
    emails = { "7": await email() };
    googleServer.deps.fetchEmail = async (uid: string) => emails[uid];
  });
  afterEach(() => {
    googleApi.hooks.service = realService;
    Object.assign(googleServer.deps, realDeps);
    delete process.env.LUNA_TASKS_PATH;
  });

  test("create, update and delete an event", async () => {
    const event = await googleServer.createEvent("Dentist", "2026-10-20T09:30", "", "", "Clinic");
    expect([event.title, event.start]).toEqual(["Dentist", "2026-10-20T09:30:00+05:30"]);
    expect(calendar.calls.at(-1)![1].sendUpdates).toBe("none");

    await googleServer.createEvent("Sync", "2026-10-21T10:00", "", "", "", "ann@example.com, Bob <bob@example.com>");
    expect(calendar.calls.at(-1)![1].body.attendees).toEqual([{ email: "ann@example.com" }, { email: "bob@example.com" }]);
    expect(calendar.calls.at(-1)![1].sendUpdates).toBe("all");

    const moved = await googleServer.updateEvent(event.id, "", "2026-10-20T11:00");
    expect([moved.start, moved.end]).toEqual(["2026-10-20T11:00:00+05:30", "2026-10-20T12:00:00+05:30"]);
    expect(new Set(Object.keys(calendar.calls.at(-1)![1].body))).toEqual(new Set(["start", "end"]));
    await expect(googleServer.updateEvent(event.id)).rejects.toThrow(/Nothing to change/);

    expect(await googleServer.deleteEvent(event.id)).toContain("Dentist");
    expect(calendar.items.has(event.id)).toBe(false);
  });

  test("the list window and an agenda with local to-dos", async () => {
    await googleServer.listEvents("2026-10-20", "2026-10-20", "dentist", 500);
    const params = calendar.calls.at(-1)![1];
    expect(params.timeMin).toBe("2026-10-20T00:00:00+05:30");
    expect(params.timeMax).toBe("2026-10-21T00:00:00+05:30"); // a date-only end includes that day
    expect([params.q, params.maxResults, params.singleEvents]).toEqual(["dentist", 50, true]);

    await todos.addTask("pay rent", "2026-10-15");
    await todos.addTask("call mom", "2026-10-20T18:00");
    await todos.addTask("someday");
    const agenda = await googleServer.getAgenda("2026-10-20");
    expect(agenda.date).toBe("2026-10-20");
    expect(agenda.tasks_due.map((t) => t.title)).toEqual(["call mom"]);
    expect(agenda.overdue.map((t) => t.title)).toEqual(["pay rent"]);
  });

  test("an event from an email links back and does not duplicate", async () => {
    const made = await googleServer.createEventFromEmail("7", "2026-10-23T13:00", "", "", "Cafe Blue", true);
    expect(made.created).toBe(true);
    const event = made.event;
    expect([event.title, event.from_email]).toEqual(["Lunch on Friday?", "<m7@example.com>"]);
    expect(event.attendees).toEqual(["bob@example.com"]);
    expect(event.description).toContain("Shall we meet at 1pm");
    expect(event.description).toContain("rfc822msgid:m7%40example.com"); // opens the email in Gmail
    expect(calendar.calls.at(-1)![1].sendUpdates).toBe("all");
    const again = await googleServer.createEventFromEmail("7", "2026-10-24T13:00");
    expect(again.created).toBe(false);
    expect(again.event.id).toBe(event.id);
    expect(calendar.items.size).toBe(1);
  });

  test("an email without a Message-ID links by folder and uid", async () => {
    emails["8"] = await email({ subject: "", messageId: "" });
    const { event } = await googleServer.createEventFromEmail("8", "2026-10-23");
    expect(event.from_email).toBe("INBOX:8");
    expect(event.all_day).toBe(true);
    expect(event.title).toBe("Email from Bob <bob@example.com>");
  });
});

test("not connected tells how to sign in", async () => {
  // test/setup.ts points LUNA_GOOGLE_TOKEN_PATH at a missing file.
  await expect(googleServer.listEvents()).rejects.toThrow(googleApi.GoogleNotConnected);
  await expect(googleServer.listEvents()).rejects.toThrow(/luna-google-auth/);
});

test("an old token without Gmail access asks to sign in again", async () => {
  const token = path.join(tmpDir(), "token.json");
  writeFileSync(token, JSON.stringify({ token: "t", refresh_token: "r", client_id: "c", client_secret: "s", scopes: ["https://www.googleapis.com/auth/calendar.events"] }));
  process.env.LUNA_GOOGLE_TOKEN_PATH = token;
  await expect(googleApi.credentials(loadSettings({ envFile: null }))).rejects.toThrow(/missing access/);
});

test("a Python-written token with every scope is accepted as it is", async () => {
  const token = path.join(tmpDir(), "token.json");
  writeFileSync(token, JSON.stringify({ token: "t", refresh_token: "r", client_id: "c", client_secret: "s", scopes: googleApi.SCOPES, expiry: "2999-01-01T00:00:00.000000Z" }));
  process.env.LUNA_GOOGLE_TOKEN_PATH = token;
  const client = await googleApi.credentials(loadSettings({ envFile: null }));
  expect(client.credentials.access_token).toBe("t");
  expect(client.credentials.refresh_token).toBe("r");
});

test("the repo config routes Google to the assistant with approval", () => {
  const groups = splitByAgent(loadMcpConfig(path.join(PROJECT_ROOT, "config", "mcp_servers.json"))!);
  for (const name of ["tasks", "mail", "google"]) expect(Object.keys(groups.get("assistant")!.mcpServers)).toContain(name);
  const fake = (n: string) => tool(async () => "ok", { name: n, description: "Fake MCP tool.", schema: z.object({}) }) as unknown as AnyTool;
  const s = loadSettings({ envFile: null, env: {}, overrides: { openrouter_api_key: "test", workspace_dirs: [path.join(tmpDir(), "ws")] } });
  const assistant = getSubagentSpecs(s, new Map([["assistant", [...READ_ONLY, ...RISKY].sort().map(fake)]])).find((x) => x.name === "ask_assistant")!;
  expect(assistant.interruptOn).toEqual(Object.fromEntries(RISKY.map((n) => [n, true])));
});
