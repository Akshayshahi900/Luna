/**
 * TelegramBridge — use Luna from your phone through a Telegram bot.
 *
 * BEGINNER MAP
 * ------------
 * While luna-web runs (with LUNA_TELEGRAM_BOT_TOKEN set), the bridge long-polls
 * Telegram and treats each private chat like a browser tab (web/session.ts
 * Session): same agent, same memory, same approvals.
 *
 *   text        → a new task (runTask with a fresh TaskBudget)
 *   voice note  → Whisper (voice/stt.ts) → text; Luna echoes what she heard,
 *                 and answers with a voice note too (LUNA_TELEGRAM_VOICE_REPLIES)
 *   photo       → saved to <workspace>/telegram/; sent to the model as an image
 *                 when LUNA_MODEL_VISION=true, else Luna only gets the file path
 *   document    → saved to <workspace>/telegram/; Luna gets the file path
 *   /new /stop /help  → new thread, cancel, help
 *
 * Pauses (D9: risky actions need a human):
 *   approval  → a card with Approve / Reject buttons; a text or voice reply
 *               works too: "yes" / "approve" approves, "no" / "reject" rejects,
 *               anything else rejects WITH that text as the reason, so Luna can
 *               try again your way
 *   question  → your next reply is the answer
 *
 * Who may use it: only private chats with users listed in
 * LUNA_TELEGRAM_ALLOWED_USERS. Anyone else gets their own user id back (so the
 * owner can find theirs) and nothing else. Groups are ignored.
 *
 * State: data/telegram.json keeps the update offset (so a message is never
 * handled twice) and each chat's thread id (so the conversation carries on
 * after a restart; it also shows up in the web UI's SESSIONS list). Pauses
 * live in the checkpoint, so a pending approval survives a restart too.
 *
 * Routine results with notifications on are sent to the allowed users
 * (LUNA_TELEGRAM_ROUTINE_ALERTS).
 *
 * Read next: channels/telegram_api.ts (the HTTP calls), docs/messaging.md.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { BaseMessage } from "@langchain/core/messages";
import { Command } from "@langchain/langgraph";

import { TaskBudget } from "../agent/budget.ts";
import { recursionLimit } from "../agent/builder.ts";
import { runTask } from "../agent/runner.ts";
import { newSessionId } from "../agent/sessions.ts";
import { type Interrupt, snapshotInterrupts } from "../agent/types.ts";
import type { Settings } from "../config/settings.ts";
import { MAX_TEXT_CHARS } from "../voice/tts.ts";
import { buildAnswer, describePause, EventTranslator, isModelUpdate, type Pause, type PauseAction } from "../web/events.ts";
import { type AgentHost, cancelCleanup } from "../web/session.ts";
import { decodeAudio, pickPhoto, safeFilename, splitText, wavToOggOpus } from "./media.ts";
import { type BotApi, type Buttons, TelegramAPI, TelegramError } from "./telegram_api.ts";

const POLL_TIMEOUT = 30; // seconds one getUpdates call waits for news
const RETRY_SECONDS = 5; // after a network error
const TYPING_SECONDS = 4; // "typing…" fades after ~5 s on the phone
// Messages that waited this long (Luna was off) are skipped, not run late.
const STALE_SECONDS = 15 * 60;
const INBOX_DIR = "telegram"; // under the first workspace folder
const ARGS_PREVIEW = 700; // characters of tool arguments shown on an approval card

const APPROVE_WORDS = new Set(["yes", "y", "approve", "approved", "ok", "okay", "go", "go ahead", "do it", "sure", "yes please", "👍"]);
const REJECT_WORDS = new Set(["no", "n", "reject", "nope", "don't", "dont", "cancel", "👎"]);

export const HELP =
  "I'm Luna. Send me a message, a voice note, a photo or a file and I'll get on it.\n\n" +
  "When I need your OK for something risky (sending mail, writing files, running commands) " +
  "I'll ask with Approve / Reject buttons. You can also just reply \"yes\" or \"no\", or say " +
  "what to do instead.\n\n" +
  "/new  start a fresh conversation\n" +
  "/stop  cancel what I'm doing\n" +
  "/help  this message";

function normal(text: string): string {
  return text.toLowerCase().trim().replace(/^[ .!?,]+|[ .!?,]+$/g, "").split(/\s+/).filter(Boolean).join(" ");
}

/** How a typed / spoken reply to an approval reads: approve, reject or other. */
export function replyKind(text: string): "approve" | "reject" | "other" {
  const word = normal(text);
  if (APPROVE_WORDS.has(word)) return "approve";
  if (REJECT_WORDS.has(word)) return "reject";
  return "other";
}

/** Resume values for every pending pause from one text reply. */
export function answersFromText(pending: Map<string, Pause>, text: string): Record<string, unknown> {
  const kind = replyKind(text);
  const answers: Record<string, unknown> = {};
  for (const [id, pause] of pending) {
    if (pause.kind === "approval") {
      let decision: Record<string, unknown>;
      if (kind === "approve" && pause.actions.every((a) => a.allowed.includes("approve"))) decision = { type: "approve" };
      else if (kind === "approve" || kind === "reject") decision = { type: "reject" };
      else decision = { type: "reject", message: text };
      answers[id] = buildAnswer(pause, { decisions: [decision] });
    } else {
      answers[id] = buildAnswer(pause, { answer: text });
    }
  }
  return answers;
}

/** One line per tool call waiting for approval. */
export function describeAction(action: PauseAction): string {
  const args = action.args ?? {};
  let shown = Object.keys(args).length ? JSON.stringify(args, null, 1) : "";
  if ([...shown].length > ARGS_PREVIEW) shown = [...shown].slice(0, ARGS_PREVIEW - 1).join("") + "…";
  return `• ${action.name}` + (shown ? `\n${shown}` : "");
}

/**
 * A short, stable id for the current set of pauses (for button data).
 * Pause ids live in the checkpoint, so buttons sent before a restart still
 * match; buttons from an older, already answered pause don't.
 */
export function pauseToken(pending: Map<string, Pause> | Record<string, unknown>): string {
  const ids = pending instanceof Map ? [...pending.keys()] : Object.keys(pending);
  return ids.length ? ids.sort()[0].slice(0, 16) : "";
}

/** One Telegram chat: its thread, pending pauses and running task. */
export class Chat {
  readonly chatId: number;
  threadId: string;
  pending = new Map<string, Pause>(); // pause id → describePause() output
  budget: TaskBudget | null = null;
  task: Promise<void> | null = null;
  controller: AbortController | null = null;
  card: number | null = null; // message id of the approval card with buttons
  loaded = false; // pending pauses read from the checkpoint

  constructor(chatId: number, threadId: string) {
    this.chatId = chatId;
    this.threadId = threadId;
  }

  get busy(): boolean {
    return this.task !== null;
  }
}

class Stopped extends Error {}

/** Long-polls one bot and runs every allowed chat through the agent. */
export class TelegramBridge {
  readonly host: AgentHost;
  readonly api: BotApi;
  readonly statePath: string;
  offset: number | null = null;
  threads: Record<string, string> = {}; // chat id (as text) → thread id
  readonly chats = new Map<number, Chat>();
  readonly background = new Set<Promise<unknown>>();
  #polling: Promise<void> | null = null;
  #stop = new AbortController();
  #listener = (event: Record<string, any>) => this.onHostEvent(event);

  constructor(host: AgentHost, api: BotApi, statePath: string) {
    this.host = host;
    this.api = api;
    this.statePath = statePath;
    this.#loadState();
  }

  /** The host's settings: allowed users and voice replies apply right away. */
  get settings(): Settings {
    return this.host.settings;
  }

  // --- state file ----------------------------------------------------------

  #loadState(): void {
    let data: any;
    try {
      data = JSON.parse(readFileSync(this.statePath, "utf8"));
    } catch {
      return;
    }
    this.offset = Number.isInteger(data?.offset) ? data.offset : null;
    const threads = data?.threads;
    this.threads = threads && typeof threads === "object" ? Object.fromEntries(Object.entries(threads).map(([k, v]) => [String(k), String(v)])) : {};
  }

  #saveState(): void {
    mkdirSync(path.dirname(this.statePath), { recursive: true });
    const tmp = `${this.statePath}.tmp`;
    writeFileSync(tmp, JSON.stringify({ offset: this.offset, threads: this.threads }, null, 2), "utf8");
    renameSync(tmp, this.statePath);
  }

  // --- lifecycle -----------------------------------------------------------

  /** Start polling and listen for routine results. */
  start(): void {
    this.host.listeners.add(this.#listener);
    this.#polling = this.#poll();
  }

  /** Stop polling and cancel every chat's run. */
  async stop(): Promise<void> {
    this.host.listeners.delete(this.#listener);
    this.#stop.abort();
    for (const chat of this.chats.values()) chat.controller?.abort();
    await Promise.allSettled([this.#polling, ...this.background, ...[...this.chats.values()].map((c) => c.task)]);
    await this.api.close();
  }

  #spawn(job: Promise<unknown>): void {
    this.background.add(job);
    void job.finally(() => this.background.delete(job));
  }

  async #poll(): Promise<void> {
    const signal = this.#stop.signal;
    while (!signal.aborted) {
      let updates: any[];
      try {
        updates = await this.api.getUpdates(this.offset, POLL_TIMEOUT, signal);
      } catch (error) {
        if (signal.aborted) return;
        console.error(`Telegram: ${(error as Error).message} (retrying in ${RETRY_SECONDS} s)`);
        await new Promise((r) => setTimeout(r, RETRY_SECONDS * 1000));
        continue;
      }
      for (const update of updates ?? []) {
        this.offset = Number(update.update_id) + 1;
        this.#saveState(); // before handling: a crash never repeats a command
        try {
          await this.handleUpdate(update);
        } catch (error) {
          // one bad update must not stop the bot
          console.error(`Telegram update failed: ${(error as Error).stack ?? error}`);
        }
      }
    }
  }

  // --- sending -------------------------------------------------------------

  /** Send text (split at Telegram's limit); returns the last message. Never throws. */
  async send(chatId: number, text: string, buttons: Buttons | null = null): Promise<{ message_id?: number } | null> {
    let sent: { message_id?: number } | null = null;
    const parts = splitText(text);
    if (!parts.length) parts.push("…");
    for (let i = 0; i < parts.length; i++) {
      try {
        sent = await this.api.sendMessage(chatId, parts[i], i === parts.length - 1 ? buttons : null);
      } catch (error) {
        console.error(`Telegram: couldn't send a message (${(error as Error).message})`);
        return null;
      }
    }
    return sent;
  }

  async #sendVoice(chatId: number, text: string): Promise<void> {
    const engine = this.host.tts;
    if (!engine) return;
    try {
      const wav = await engine.synthesize([...text].slice(0, MAX_TEXT_CHARS).join(""));
      await this.api.sendVoice(chatId, await wavToOggOpus(wav));
    } catch (error) {
      // the text reply was already sent
      console.error(`Telegram: voice reply failed (${(error as Error).message})`);
    }
  }

  #typing(chatId: number): () => void {
    let on = true;
    const tick = async () => {
      while (on) {
        await this.api.sendChatAction(chatId).catch(() => undefined);
        await new Promise((r) => setTimeout(r, TYPING_SECONDS * 1000).unref?.());
      }
    };
    void tick();
    return () => (on = false);
  }

  /** AgentHost listener: forward routine results to the allowed users. */
  onHostEvent(event: Record<string, any>): void {
    if (event?.type !== "routine_result" || !this.settings.telegram_routine_alerts) return;
    const routine = event.routine ?? {};
    const run = event.run ?? {};
    if (routine.notify === false) return;
    const mark = run.status === "error" ? "⚠️" : "⏰";
    const text = `${mark} ${routine.name ?? "Routine"}: ${run.summary || run.error || "done"}`;
    for (const userId of this.settings.telegram_allowed_users) this.#spawn(this.send(userId, text)); // private chat id = user id
  }

  // --- chats ---------------------------------------------------------------

  #config(chat: Chat): Record<string, any> {
    return { configurable: { thread_id: chat.threadId }, recursionLimit: recursionLimit(this.settings) };
  }

  #setPending(chat: Chat, interrupts: Interrupt[]): void {
    chat.pending = new Map(interrupts.map((i) => [i.id ?? "", describePause(i)]));
  }

  /** The chat's session; on first use, its thread and any pause still waiting. */
  async chat(chatId: number): Promise<Chat> {
    let chat = this.chats.get(chatId);
    if (!chat) {
      let threadId = this.threads[String(chatId)];
      if (!threadId) {
        threadId = this.threads[String(chatId)] = newSessionId();
        this.#saveState();
      }
      chat = new Chat(chatId, threadId);
      this.chats.set(chatId, chat);
    }
    if (!chat.loaded) {
      chat.loaded = true;
      const agent = this.host.agent;
      if (agent.checkpointer) {
        this.#setPending(chat, snapshotInterrupts(await agent.getState(this.#config(chat))));
        if (chat.pending.size) chat.budget = new TaskBudget(this.settings.task_budget);
      }
    }
    return chat;
  }

  #newThread(chat: Chat): void {
    chat.threadId = this.threads[String(chat.chatId)] = newSessionId();
    chat.pending = new Map();
    chat.budget = null;
    chat.card = null;
    this.#saveState();
  }

  #startTask(chat: Chat, job: (signal: AbortSignal) => Promise<void>): void {
    chat.controller = new AbortController();
    chat.task = job(chat.controller.signal).finally(() => {
      chat.task = null;
      chat.controller = null;
    });
  }

  // --- incoming ------------------------------------------------------------

  /** React to one Telegram update (a message or a button press). */
  async handleUpdate(update: Record<string, any>): Promise<void> {
    if (update.callback_query) return this.#onButton(update.callback_query);
    const msg = update.message;
    if (!msg || typeof msg !== "object") return;
    const chatId = msg.chat?.id;
    if (msg.chat?.type !== "private" || chatId === undefined || chatId === null) return; // groups and channels: never
    const userId = msg.from?.id;
    if (!this.settings.telegram_allowed_users.includes(userId)) {
      await this.send(
        chatId,
        `Sorry, I only work for my owner.\nYour Telegram user id is ${userId}. ` +
          "To use me, add it to LUNA_TELEGRAM_ALLOWED_USERS (Control Center → General → Messaging).",
      );
      return;
    }
    if (Date.now() / 1000 - (msg.date ?? Date.now() / 1000) > STALE_SECONDS) {
      const what = [...String(msg.text || msg.caption || "a message")].slice(0, 80).join("");
      await this.send(chatId, `I was offline when you sent “${what}”. Send it again if you still need it.`);
      return;
    }

    const chat = await this.chat(chatId);
    const text = String(msg.text ?? "").trim();
    if (text.startsWith("/")) return this.#command(chat, text);
    if (chat.busy) {
      await this.send(chatId, "Still working on your last message. /stop cancels it.");
      return;
    }
    this.#startTask(chat, (signal) => this.#process(chat, msg, signal));
  }

  async #command(chat: Chat, text: string): Promise<void> {
    const command = text.split(/\s+/)[0].split("@")[0].toLowerCase();
    if (command === "/stop") {
      if (chat.busy) {
        chat.controller?.abort(); // the run cleans up and says so
        return;
      }
      if (chat.pending.size) {
        await cancelCleanup(this.host.agent, this.#config(chat));
        await this.#dropCard(chat);
        chat.pending = new Map();
        chat.budget = null;
        await this.send(chat.chatId, "Cancelled.");
        return;
      }
      await this.send(chat.chatId, "Nothing to stop.");
      return;
    }
    if (command === "/new") {
      if (chat.busy) {
        await this.send(chat.chatId, "Finish or /stop the current task first.");
        return;
      }
      await this.#dropCard(chat);
      this.#newThread(chat);
      await this.send(chat.chatId, "Fresh start. What can I do for you?");
      return;
    }
    await this.send(chat.chatId, HELP); // /start, /help and anything unknown
  }

  async #onButton(query: Record<string, any>): Promise<void> {
    const userId = query.from?.id;
    const message = query.message ?? {};
    const chatId = message.chat?.id;
    if (!this.settings.telegram_allowed_users.includes(userId) || chatId === undefined || chatId === null) {
      await this.#ack(query, "Not allowed.");
      return;
    }
    const chat = await this.chat(chatId);
    const data = String(query.data ?? "");
    const decision = data.split(":")[0];
    const token = data.includes(":") ? data.slice(data.indexOf(":") + 1) : "";
    if (chat.busy || !chat.pending.size || token !== pauseToken(chat.pending)) {
      await this.#ack(query, "That was already answered.");
      await this.#clear(chatId, message.message_id);
      return;
    }
    if ([...chat.pending.values()].some((p) => p.kind !== "approval")) {
      await this.#ack(query, "Reply with a message to answer my question too.");
      return;
    }
    await this.#ack(query, decision === "approve" ? "Approved" : "Rejected");
    let answers: Record<string, unknown>;
    try {
      answers = Object.fromEntries(
        [...chat.pending].map(([id, p]) => [id, buildAnswer(p, { decisions: [{ type: decision === "approve" ? "approve" : "reject" }] })]),
      );
    } catch (error) {
      await this.send(chatId, `Can't do that: ${(error as Error).message}`);
      return;
    }
    await this.#dropCard(chat);
    this.#startTask(chat, (signal) => this.#run(chat, new Command({ resume: answers }), false, signal));
  }

  async #ack(query: Record<string, any>, text: string): Promise<void> {
    await this.api.answerCallback(String(query.id), text).catch(() => undefined);
  }

  async #clear(chatId: number, messageId: number | null | undefined): Promise<void> {
    if (messageId === null || messageId === undefined) return;
    await this.api.clearButtons(chatId, messageId).catch(() => undefined); // already gone, or too old to edit
  }

  async #dropCard(chat: Chat): Promise<void> {
    const card = chat.card;
    chat.card = null;
    await this.#clear(chat.chatId, card);
  }

  /** Turn one message into text / an image, then start or resume a run. */
  async #process(chat: Chat, msg: Record<string, any>, signal: AbortSignal): Promise<void> {
    let read: { text: string; image: Record<string, unknown> | null; voice: boolean };
    try {
      read = await this.#read(msg, signal);
    } catch (error) {
      if (error instanceof Stopped || signal.aborted) {
        await this.send(chat.chatId, "Stopped."); // /stop while downloading or transcribing
        return;
      }
      await this.send(chat.chatId, `I couldn't read that: ${(error as Error).message}`);
      return;
    }
    const { text, image, voice } = read;
    if (!text && !image) {
      await this.send(chat.chatId, "I can read text, voice notes, photos and files. Try one of those.");
      return;
    }

    if (chat.pending.size) {
      if (!text) {
        await this.send(chat.chatId, "I'm waiting for your answer first (or /stop).");
        return;
      }
      let answers: Record<string, unknown>;
      try {
        answers = answersFromText(chat.pending, text);
      } catch (error) {
        await this.send(chat.chatId, `Can't do that: ${(error as Error).message}`);
        return;
      }
      await this.#dropCard(chat);
      return this.#run(chat, new Command({ resume: answers }), voice, signal);
    }

    const content = image ? [{ type: "text", text }, image] : text;
    chat.budget = new TaskBudget(this.settings.task_budget);
    await this.#run(chat, { messages: [{ role: "user", content }] }, voice, signal);
  }

  /** text, an image block for the model (or null), and whether it came as a voice note. */
  async #read(msg: Record<string, any>, signal: AbortSignal): Promise<{ text: string; image: Record<string, unknown> | null; voice: boolean }> {
    const check = () => {
      if (signal.aborted) throw new Stopped();
    };
    let text = String(msg.text || msg.caption || "").trim();
    const notes: string[] = [];
    let image: Record<string, unknown> | null = null;

    const audio = msg.voice || msg.audio;
    if (audio) {
      const heard = await this.#transcribe(audio.file_id);
      check();
      if (!heard) throw new Error("I couldn't make out any words in that voice note");
      await this.send(msg.chat.id, `🎙 “${heard}”`);
      text = `${text}\n${heard}`.trim();
      if (msg.voice) return { text, image: null, voice: true };
    }

    if (msg.photo) {
      const size = pickPhoto(msg.photo)!;
      const data = await this.api.download(size.file_id);
      check();
      const rel = this.#saveUpload(data, `photo-${size.file_unique_id ?? "x"}.jpg`);
      notes.push(`[The user sent a photo, saved in the workspace as ${rel}]`);
      if (this.settings.model_vision) image = imageBlock(data, "image/jpeg");
    }

    const document = msg.document;
    if (document) {
      const data = await this.api.download(document.file_id);
      check();
      const rel = this.#saveUpload(data, document.file_name || "file");
      const mime = document.mime_type || "unknown type";
      notes.push(`[The user sent a file (${mime}), saved in the workspace as ${rel}]`);
      if (this.settings.model_vision && ["image/jpeg", "image/png", "image/webp"].includes(mime)) image = imageBlock(data, mime);
    }

    if (notes.length) text = [text, ...notes].join("\n").trim();
    return { text, image, voice: false };
  }

  async #transcribe(fileId: string): Promise<string> {
    if (!this.host.stt) throw new Error("voice notes need Whisper (set LUNA_STT_ENGINE=whisper)");
    const data = await this.api.download(fileId);
    const pcm = await decodeAudio(data);
    return (await this.host.stt.transcribe(pcm, pcm.length / 2, null)).trim();
  }

  /** Write an upload to <workspace>/telegram/; returns the workspace-relative path. */
  #saveUpload(data: Buffer, name: string): string {
    const root = this.settings.workspace_dirs[0];
    const folder = path.join(root, INBOX_DIR);
    mkdirSync(folder, { recursive: true });
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    const file = path.join(folder, `${stamp}-${safeFilename(name)}`);
    writeFileSync(file, data);
    return path.relative(root, file).split(path.sep).join("/");
  }

  // --- runs ----------------------------------------------------------------

  /** One runTask: collect the reply text, then send it and any pauses. */
  async #run(chat: Chat, payload: unknown, voice: boolean, signal: AbortSignal): Promise<void> {
    const agent = this.host.agent; // fixed for this run
    const config = this.#config(chat);
    const translate = new EventTranslator();
    const reply: string[] = [];
    const counts = { model_calls: 0, tool_calls: 0 };
    const onEvent = (namespace: string[], mode: string, data: unknown) => {
      if (isModelUpdate(mode, data)) counts.model_calls += 1;
      for (const event of translate.translate(namespace, mode, data)) {
        if (event.type === "token") reply.push(event.text);
        else if (event.type === "tool_call") counts.tool_calls += 1;
      }
    };

    const stopTyping = this.#typing(chat.chatId);
    let interrupts: Interrupt[];
    try {
      if (agent.checkpointer) translate.prime(((await agent.getState(config)).values?.messages ?? []) as BaseMessage[]);
      interrupts = await runTask(agent, payload, config, { budget: chat.budget, onEvent, signal });
    } catch (error) {
      stopTyping();
      chat.pending = new Map();
      chat.budget = null;
      if (signal.aborted) {
        this.host.recordUsage({ runs: 1, ...counts });
        await cancelCleanup(agent, config).catch(() => undefined);
        await this.send(chat.chatId, "Stopped.");
        return;
      }
      // tell the user, keep the bot running
      this.host.recordUsage({ runs: 1, errors: 1, ...counts });
      await this.send(chat.chatId, `Something went wrong: ${(error as Error).message || String(error)}`);
      return;
    }
    stopTyping();
    this.host.recordUsage({ runs: 1, ...counts });

    const text = reply.join("").trim();
    if (text) {
      await this.send(chat.chatId, text);
      if (voice && this.settings.telegram_voice_replies) await this.#sendVoice(chat.chatId, text);
    }
    this.#setPending(chat, interrupts);
    if (chat.pending.size) await this.#sendPauses(chat);
    else {
      chat.budget = null;
      if (!text) await this.send(chat.chatId, "Done.");
    }
    this.host.broadcastInbox(); // Luna may have suggested a memory
  }

  async #sendPauses(chat: Chat): Promise<void> {
    const pauses = [...chat.pending.values()];
    const actions = pauses.flatMap((p) => (p.kind === "approval" ? p.actions : []));
    for (const pause of pauses) {
      if (pause.kind === "question") await this.send(chat.chatId, `❓ ${pause.question}`);
      else if (pause.kind === "other") await this.send(chat.chatId, `⏸ ${pause.text}\n(Reply to continue.)`);
    }
    if (!actions.length) return;
    const token = pauseToken(chat.pending);
    let buttons = [{ text: "✅ Approve", callback_data: `approve:${token}` }];
    if (!actions.every((a) => a.allowed.includes("approve"))) buttons = [];
    buttons.push({ text: "❌ Reject", callback_data: `reject:${token}` });
    const lines = actions.map(describeAction).join("\n");
    const sent = await this.send(
      chat.chatId,
      `I need your OK for:\n${lines}\n\nTap a button, or reply "yes", "no" or what to do instead.`,
      [buttons],
    );
    chat.card = sent?.message_id ?? null;
  }
}

function imageBlock(data: Buffer, mime: string): Record<string, unknown> {
  return { type: "image_url", image_url: { url: `data:${mime};base64,${data.toString("base64")}` } };
}

/** Start the bot if LUNA_TELEGRAM_BOT_TOKEN is set (called by luna-web). */
export function startTelegram(host: AgentHost, statePath: string): TelegramBridge | null {
  const token = host.settings.telegram_bot_token;
  if (!token) return null;
  if (!host.settings.telegram_allowed_users.length) {
    console.error("Telegram: no LUNA_TELEGRAM_ALLOWED_USERS yet; message the bot to get your user id.");
  }
  const bridge = new TelegramBridge(host, new TelegramAPI(token), statePath);
  bridge.start();
  return bridge;
}

export { TelegramError };
