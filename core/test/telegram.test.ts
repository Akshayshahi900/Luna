// Telegram bridge: media helpers, the Bot API client, and whole conversations
// (text, voice notes, photos, approvals, questions, commands) against a fake
// Telegram and fake models — no network, no API key.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { tool } from "@langchain/core/tools";
import { MemorySaver } from "@langchain/langgraph";
import { createAgent, humanInTheLoopMiddleware } from "langchain";
import { beforeEach, describe, expect, test } from "vitest";
import * as z from "zod";

import type { LunaAgent } from "../src/agent/types.ts";
import { decodeAudio, pickPhoto, safeFilename, splitText, wavToOggOpus } from "../src/channels/media.ts";
import { answersFromText, pauseToken, replyKind, TelegramBridge } from "../src/channels/telegram.ts";
import { type BotApi, type Buttons, TelegramAPI, TelegramError } from "../src/channels/telegram_api.ts";
import { applies, SECRETS } from "../src/config/schema.ts";
import { loadSettings, type Settings } from "../src/config/settings.ts";
import { askUser } from "../src/tools/builtin/index.ts";
import { pcmToWav } from "../src/voice/wav.ts";
import type { Pause } from "../src/web/events.ts";
import { AgentHost } from "../src/web/session.ts";
import { type FakeToolModel, fakeModel, tmpDir, toolCall } from "./helpers.ts";

const OWNER = 42;

/** A sine-wave WAV. */
function wav(seconds = 1.0, rate = 22050): Buffer {
  const n = Math.floor(rate * seconds);
  const pcm = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) pcm.writeInt16LE(Math.round(Math.sin(i / 10) * 8000), i * 2);
  return pcmToWav(pcm, rate);
}

// --- media -------------------------------------------------------------------

describe("media", () => {
  test("voice round trip: WAV → Opus → Whisper samples", async () => {
    const ogg = await wavToOggOpus(wav(1.0));
    expect(ogg.subarray(0, 4).toString()).toBe("OggS");
    const pcm = await decodeAudio(ogg);
    const samples = pcm.length / 2;
    expect(samples).toBeGreaterThan(15_000); // ~1 s at 16 kHz (Opus adds a little padding)
    expect(samples).toBeLessThan(17_500);
    let peak = 0;
    for (let i = 0; i < samples; i++) peak = Math.max(peak, Math.abs(pcm.readInt16LE(i * 2)) / 32768);
    expect(peak).toBeGreaterThan(0.1);
    expect(peak).toBeLessThanOrEqual(1);
  });

  test("decodeAudio refuses garbage and long notes", async () => {
    await expect(decodeAudio(Buffer.from("definitely not audio"))).rejects.toThrow();
    await expect(decodeAudio(wav(2.0), 1)).rejects.toThrow(/longer than/);
  });

  test("splitText prefers breaks and respects the limit", () => {
    expect(splitText("hello")).toEqual(["hello"]);
    const parts = splitText("word ".repeat(50), 40);
    expect(parts.every((p) => p.length <= 40)).toBe(true);
    expect(parts.join(" ").split(/\s+/)).toEqual(Array(50).fill("word"));
    expect(splitText("x".repeat(100), 40)).toEqual(["x".repeat(40), "x".repeat(40), "x".repeat(20)]); // no break: hard cut
    expect(splitText("a\n\nb", 3)).toEqual(["a", "b"]);
  });

  test("pickPhoto and safeFilename", () => {
    const sizes = [{ file_id: "s", width: 90, height: 60 }, { file_id: "m", width: 1280, height: 853 }, { file_id: "l", width: 2560, height: 1706 }];
    expect(pickPhoto(sizes)!.file_id).toBe("m");
    expect(pickPhoto(sizes.slice(2))!.file_id).toBe("l"); // nothing fits: the smallest there is
    expect(pickPhoto([])).toBeNull();
    expect(safeFilename("../../etc/passwd")).toBe("passwd");
    expect(safeFilename("my report (final).pdf")).toBe("my_report_final_.pdf");
    expect(safeFilename("...")).toBe("file");
  });
});

// --- replies to pauses -------------------------------------------------------

const APPROVAL: Pause = { id: "p1", kind: "approval", actions: [{ name: "write_file", args: {}, description: null, allowed: ["approve", "edit", "reject"] }] };

test("reply words", () => {
  expect(replyKind("Yes!")).toBe("approve");
  expect(replyKind("go ahead.")).toBe("approve");
  expect(replyKind("No")).toBe("reject");
  expect(replyKind("cancel")).toBe("reject");
  expect(replyKind("no, call it b.txt")).toBe("other");
});

test("text answers for approvals and questions", () => {
  const question: Pause = { id: "q1", kind: "question", question: "Which?" };
  expect(answersFromText(new Map([["p1", APPROVAL]]), "yes")).toEqual({ p1: { decisions: [{ type: "approve" }] } });
  expect(answersFromText(new Map([["p1", APPROVAL]]), "nope")).toEqual({ p1: { decisions: [{ type: "reject" }] } });
  expect(answersFromText(new Map<string, Pause>([["p1", APPROVAL], ["q1", question]]), "use b.txt")).toEqual({
    p1: { decisions: [{ type: "reject", message: "use b.txt" }] },
    q1: "use b.txt",
  });
  expect(pauseToken({ ["b".repeat(40)]: {}, ["a".repeat(40)]: {} })).toBe("a".repeat(16));
});

test("Telegram settings in the Control Center", () => {
  expect(SECRETS.has("telegram_bot_token")).toBe(true);
  expect(applies("telegram_bot_token")).toBe("restart");
  expect(applies("telegram_allowed_users")).toBe("live");
  expect(applies("model_vision")).toBe("live");
  expect(loadSettings({ envFile: null, env: { LUNA_TELEGRAM_ALLOWED_USERS: "42, 7" } }).telegram_allowed_users).toEqual([42, 7]);
});

// --- Bot API client ----------------------------------------------------------

test("API calls, and the token never leaks", async () => {
  const seen: { url: string; body?: string }[] = [];
  const fake = (async (url: string, init?: RequestInit) => {
    seen.push({ url, body: typeof init?.body === "string" ? init.body : undefined });
    if (url.endsWith("/getFile")) return new Response(JSON.stringify({ ok: true, result: { file_path: "voice/1.oga", file_size: 3 } }));
    if (url.includes("/file/")) return new Response("abc");
    if (url.endsWith("/sendMessage")) return new Response(JSON.stringify({ ok: false, description: "Bad Request: chat not found" }));
    throw new Error(`boom ${url}`);
  }) as typeof fetch;
  const api = new TelegramAPI("123:SECRET", fake);
  expect((await api.download("f1")).toString()).toBe("abc");
  expect(new URL(seen[1].url).pathname).toBe("/file/bot123:SECRET/voice/1.oga");
  await expect(api.sendMessage(1, "hi", [[{ text: "ok", callback_data: "x" }]])).rejects.toThrow(/chat not found/);
  expect(JSON.parse(seen[2].body!).reply_markup).toEqual({ inline_keyboard: [[{ text: "ok", callback_data: "x" }]] });
  const error = await api.getUpdates(null, 1).catch((e) => e);
  expect(error).toBeInstanceOf(TelegramError);
  expect(String(error.message)).not.toContain("SECRET");
  expect(String(error.message)).toContain("<token>");
});

// --- whole conversations -----------------------------------------------------

/** Records what the bot sends; serves uploaded files from `files`. */
class FakeTelegram implements BotApi {
  files: Record<string, Buffer>;
  sent: { chat: number; text: string; buttons: Buttons | null }[] = [];
  voices: Buffer[] = [];
  acks: (string | null)[] = [];
  cleared: number[] = [];
  constructor(files: Record<string, Buffer> = {}) {
    this.files = files;
  }
  async getUpdates() {
    return [];
  }
  async sendMessage(chat: number, text: string, buttons: Buttons | null = null) {
    this.sent.push({ chat, text, buttons });
    return { message_id: this.sent.length };
  }
  async sendVoice(_chat: number, ogg: Buffer) {
    this.voices.push(ogg);
  }
  async sendChatAction() {}
  async answerCallback(_id: string, text: string | null = null) {
    this.acks.push(text);
  }
  async clearButtons(_chat: number, messageId: number) {
    this.cleared.push(messageId);
  }
  async download(fileId: string) {
    return this.files[fileId];
  }
  async close() {}
  get texts() {
    return this.sent.map((m) => m.text);
  }
}

class FakeSTT {
  text: string;
  samples = 0;
  constructor(text: string) {
    this.text = text;
  }
  async transcribe(_pcm: Buffer, samples: number) {
    this.samples = samples;
    return this.text;
  }
  async warmUp() {}
}

const fakeTTS = { synthesize: async () => wav(0.3), warmUp: async () => undefined };

let written: { path: string; text: string }[] = [];
const writeFile = tool(async ({ path: p, text }) => {
  written.push({ path: p, text });
  return `wrote ${p}`;
}, { name: "write_file", description: "Write a file.", schema: z.object({ path: z.string(), text: z.string() }) });

let dir: string;
beforeEach(() => {
  dir = tmpDir();
  written = [];
});

const settingsFor = (overrides: Partial<Settings> = {}) =>
  loadSettings({
    envFile: null,
    env: {},
    overrides: {
      openrouter_api_key: "test", task_budget: 50, telegram_allowed_users: [OWNER], workspace_dirs: [path.join(dir, "ws")],
      telegram_voice_replies: true, telegram_routine_alerts: true, model_vision: false, ...overrides,
    },
  });
const agentOf = (model: FakeToolModel, tools: unknown[] = [], extra: Record<string, unknown> = {}) =>
  createAgent({ model: model as never, tools: tools as never, checkpointer: new MemorySaver(), ...extra } as never) as unknown as LunaAgent;
const approvalAgent = (model: FakeToolModel) => agentOf(model, [writeFile], { middleware: [humanInTheLoopMiddleware({ interruptOn: { write_file: true } })] });

function bridgeFor(agent: LunaAgent, api = new FakeTelegram(), overrides: Partial<Settings> = {}) {
  const host = new AgentHost(agent, settingsFor(overrides), "openrouter", "fake");
  return new TelegramBridge(host, api, path.join(dir, "telegram.json"));
}
const fakeApi = (bridge: TelegramBridge) => bridge.api as FakeTelegram;

function msg(text: string | null, extra: Record<string, unknown> = {}, user = OWNER, chatType = "private", date?: number) {
  const m: Record<string, unknown> = { message_id: 1, date: date ?? Math.floor(Date.now() / 1000), chat: { id: user, type: chatType }, from: { id: user }, ...extra };
  if (text !== null) m.text = text;
  return { update_id: 1, message: m };
}
const press = (data: string, user = OWNER, messageId = 99) => ({
  update_id: 2,
  callback_query: { id: "cb", from: { id: user }, data, message: { message_id: messageId, chat: { id: user } } },
});

async function deliver(bridge: TelegramBridge, update: Record<string, unknown>) {
  await bridge.handleUpdate(update);
  await bridge.chats.get(OWNER)?.task;
}

describe("conversations", () => {
  test("strangers get their id; groups are ignored", async () => {
    const model = fakeModel("should never run");
    const bridge = bridgeFor(agentOf(model));
    await deliver(bridge, msg("hi", {}, 7));
    expect(fakeApi(bridge).texts).toHaveLength(1);
    expect(fakeApi(bridge).texts[0]).toContain("Your Telegram user id is 7");
    await deliver(bridge, msg("hi", {}, OWNER, "group"));
    expect(fakeApi(bridge).sent).toHaveLength(1);
    expect(model.received).toEqual([]);
  });

  test("a text message gets a reply on a saved thread", async () => {
    const bridge = bridgeFor(agentOf(fakeModel("Hello, Sir.")));
    await deliver(bridge, msg("hello"));
    expect(fakeApi(bridge).texts).toEqual(["Hello, Sir."]);
    const thread = JSON.parse(readFileSync(path.join(dir, "telegram.json"), "utf8")).threads[String(OWNER)];
    expect(thread).toBe(bridge.chats.get(OWNER)!.threadId);
    expect([bridge.host.usage.runs, bridge.host.usage.model_calls]).toEqual([1, 1]);
  });

  test("stale messages are skipped", async () => {
    const model = fakeModel("late");
    const bridge = bridgeFor(agentOf(model));
    await deliver(bridge, msg("send the report", {}, OWNER, "private", Math.floor(Date.now() / 1000) - 3600));
    expect(fakeApi(bridge).texts[0]).toContain("offline");
    expect(model.received).toEqual([]);
  });

  test("approval with buttons", async () => {
    const bridge = bridgeFor(approvalAgent(fakeModel(toolCall("write_file", "c1", { path: "a.txt", text: "hi" }), "Saved it.")));
    await deliver(bridge, msg("save a note"));
    const card = fakeApi(bridge).sent.at(-1)!;
    expect(card.text).toContain("write_file");
    expect(card.text).toContain("a.txt");
    expect(written).toEqual([]);
    const [approve, reject] = card.buttons![0];
    expect(approve.text.endsWith("Approve")).toBe(true);
    expect(reject.text.endsWith("Reject")).toBe(true);

    await deliver(bridge, press(approve.callback_data));
    expect(written).toEqual([{ path: "a.txt", text: "hi" }]);
    expect(fakeApi(bridge).texts.at(-1)).toBe("Saved it.");
    expect(fakeApi(bridge).acks).toEqual(["Approved"]);
    expect(fakeApi(bridge).cleared).toEqual([fakeApi(bridge).sent.length - 1]); // the card lost its buttons
    expect(bridge.chats.get(OWNER)!.pending.size).toBe(0);

    await deliver(bridge, press(approve.callback_data)); // pressed again
    expect(fakeApi(bridge).acks.at(-1)).toBe("That was already answered.");
    expect(written).toHaveLength(1);
  });

  test("a reply text rejects with a reason", async () => {
    const model = fakeModel(toolCall("write_file", "c1", { path: "a.txt", text: "hi" }), "OK, I won't.");
    const bridge = bridgeFor(approvalAgent(model));
    await deliver(bridge, msg("save a note"));
    await deliver(bridge, msg("no, call it b.txt"));
    expect(written).toEqual([]);
    expect(fakeApi(bridge).texts.at(-1)).toBe("OK, I won't.");
    expect(model.inputs.at(-1)!.some((t) => t.includes("call it b.txt"))).toBe(true); // Luna saw why
  });

  test("a question is answered by the next message", async () => {
    const bridge = bridgeFor(agentOf(fakeModel(toolCall("ask_user", "c1", { question: "Which colour?" }), "Blue it is."), [askUser]));
    await deliver(bridge, msg("pick a colour"));
    expect(fakeApi(bridge).texts.at(-1)).toBe("❓ Which colour?");
    await deliver(bridge, msg("blue"));
    expect(fakeApi(bridge).texts.at(-1)).toBe("Blue it is.");
  });

  test("a pending approval survives a restart", async () => {
    const agent = approvalAgent(fakeModel(toolCall("write_file", "c1", { path: "a.txt", text: "hi" }), "Done after restart."));
    const first = bridgeFor(agent);
    await deliver(first, msg("save a note"));
    const approve = fakeApi(first).sent.at(-1)!.buttons![0][0].callback_data;
    const second = bridgeFor(agent); // same state file and checkpointer
    await deliver(second, press(approve));
    expect(written).toEqual([{ path: "a.txt", text: "hi" }]);
    expect(fakeApi(second).texts.at(-1)).toBe("Done after restart.");
  });

  test("a voice note is transcribed and answered by voice", async () => {
    const model = fakeModel("It is noon.");
    const api = new FakeTelegram({ v1: await wavToOggOpus(wav(1.0)) });
    const bridge = bridgeFor(agentOf(model), api);
    const stt = new FakeSTT("what time is it");
    bridge.host.stt = stt;
    bridge.host.tts = fakeTTS;
    await deliver(bridge, msg(null, { voice: { file_id: "v1", duration: 1 } }));
    expect(api.texts).toEqual(["🎙 “what time is it”", "It is noon."]);
    expect(model.inputs.at(-1)!.at(-1)).toBe("what time is it");
    expect(stt.samples).toBeGreaterThan(15_000); // real 16 kHz samples reached Whisper
    expect(api.voices).toHaveLength(1);
    expect(api.voices[0].subarray(0, 4).toString()).toBe("OggS");
  });

  test("a voice note without Whisper explains", async () => {
    const model = fakeModel("unused");
    const bridge = bridgeFor(agentOf(model));
    await deliver(bridge, msg(null, { voice: { file_id: "v1" } }));
    expect(fakeApi(bridge).texts.at(-1)).toContain("LUNA_STT_ENGINE=whisper");
    expect(model.received).toEqual([]);
  });

  test("a photo is saved and shown to a vision model", async () => {
    const agent = agentOf(fakeModel("A cat."));
    const api = new FakeTelegram({ big: Buffer.from([0xff, 0xd8, ...Buffer.from("jpeg")]) });
    const bridge = bridgeFor(agent, api, { model_vision: true });
    const photo = [{ file_id: "small", width: 90, height: 90 }, { file_id: "big", file_unique_id: "u1", width: 800, height: 800 }];
    await deliver(bridge, msg(null, { photo, caption: "what is this?" }));
    expect(api.texts).toEqual(["A cat."]);
    const [saved] = readdirSync(path.join(dir, "ws", "telegram"));
    expect(readFileSync(path.join(dir, "ws", "telegram", saved))).toEqual(api.files.big);
    expect(saved.endsWith("photo-u1.jpg")).toBe(true);
    const state = await agent.getState({ configurable: { thread_id: bridge.chats.get(OWNER)!.threadId } });
    const content = state.values.messages[0].content;
    expect(content[0].text.startsWith("what is this?")).toBe(true);
    expect(content[0].text).toContain(`telegram/${saved}`);
    expect(content[1].image_url.url.startsWith("data:image/jpeg;base64,")).toBe(true);
  });

  test("a file without vision only gives the path", async () => {
    const model = fakeModel("Got the PDF.");
    const api = new FakeTelegram({ d1: Buffer.from("%PDF") });
    const bridge = bridgeFor(agentOf(model), api);
    await deliver(bridge, msg(null, { document: { file_id: "d1", file_name: "../Q3 report.pdf", mime_type: "application/pdf" } }));
    const [saved] = readdirSync(path.join(dir, "ws", "telegram"));
    expect(saved.endsWith("Q3_report.pdf")).toBe(true);
    expect(model.inputs.at(-1)!.at(-1)).toContain(`saved in the workspace as telegram/${saved}`);
  });

  test("commands", async () => {
    const bridge = bridgeFor(agentOf(fakeModel("hi")));
    await deliver(bridge, msg("/start"));
    expect(fakeApi(bridge).texts.at(-1)).toContain("/new");
    await deliver(bridge, msg("/stop"));
    expect(fakeApi(bridge).texts.at(-1)).toBe("Nothing to stop.");
    const old = bridge.chats.get(OWNER)!.threadId;
    await deliver(bridge, msg("/new"));
    expect(bridge.chats.get(OWNER)!.threadId).not.toBe(old);
    expect(JSON.parse(readFileSync(path.join(dir, "telegram.json"), "utf8")).threads[String(OWNER)]).toBe(bridge.chats.get(OWNER)!.threadId);
  });

  test("/stop abandons a pending approval", async () => {
    const bridge = bridgeFor(approvalAgent(fakeModel(toolCall("write_file", "c1", { path: "a.txt", text: "hi" }), "Next task done.")));
    await deliver(bridge, msg("save a note"));
    await deliver(bridge, msg("/stop"));
    expect(fakeApi(bridge).texts.at(-1)).toBe("Cancelled.");
    expect(bridge.chats.get(OWNER)!.pending.size).toBe(0);
    await deliver(bridge, msg("something else"));
    expect(fakeApi(bridge).texts.at(-1)).toBe("Next task done.");
    expect(written).toEqual([]);
  });

  test("routine results are forwarded", async () => {
    const bridge = bridgeFor(agentOf(fakeModel()));
    bridge.onHostEvent({ type: "routine_result", routine: { name: "Mail check", notify: true }, run: { status: "ok", summary: "2 new emails" } });
    bridge.onHostEvent({ type: "routine_result", routine: { name: "Quiet", notify: false }, run: { status: "ok", summary: "x" } });
    bridge.onHostEvent({ type: "model", provider: "groq" });
    await Promise.all([...bridge.background]);
    expect(fakeApi(bridge).sent).toEqual([{ chat: OWNER, text: "⏰ Mail check: 2 new emails", buttons: null }]);
  });
});
