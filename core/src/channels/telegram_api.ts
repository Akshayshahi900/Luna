/**
 * A small client for the Telegram Bot API (https://core.telegram.org/bots/api).
 *
 * BEGINNER MAP
 * ------------
 * Only the calls Luna's bot needs, over fetch, so there is no bot framework
 * to learn:
 *
 *   getUpdates       long polling: waits up to `timeout` s for new messages
 *   sendMessage      text, optionally with inline buttons (approve / reject)
 *   sendVoice        an OGG/Opus voice message
 *   sendChatAction   "typing…" while Luna works
 *   answerCallback   acknowledge a button press
 *   clearButtons     remove the buttons once a pause is answered
 *   download         a file the user sent (voice note, photo, document)
 *
 * Long polling means Luna asks Telegram for messages; Telegram never connects
 * to your machine, so no public URL, port forwarding or webhook is needed.
 *
 * SECURITY: the bot token is part of every URL, and error messages can
 * include URLs, so every error here is re-thrown as TelegramError with the
 * token replaced by "<token>", which keeps it out of logs and chat replies.
 */

export const API_BASE = "https://api.telegram.org";
// The Bot API refuses downloads above 20 MB anyway.
export const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;

/** A failed Bot API call (network error or ok=false), token removed. */
export class TelegramError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TelegramError";
  }
}

export type Buttons = { text: string; callback_data: string }[][];

/** What the bridge needs (tests pass a fake). */
export interface BotApi {
  getUpdates(offset: number | null, timeout?: number, signal?: AbortSignal): Promise<any[]>;
  sendMessage(chatId: number, text: string, buttons?: Buttons | null): Promise<{ message_id?: number }>;
  sendVoice(chatId: number, ogg: Buffer): Promise<unknown>;
  sendChatAction(chatId: number, action?: string): Promise<void>;
  answerCallback(callbackId: string, text?: string | null): Promise<void>;
  clearButtons(chatId: number, messageId: number): Promise<void>;
  download(fileId: string, maxBytes?: number): Promise<Buffer>;
  close(): Promise<void>;
}

type Fetch = typeof fetch;

/** Bot API calls for one bot token. */
export class TelegramAPI implements BotApi {
  readonly #token: string;
  readonly #base: string;
  readonly #fetch: Fetch;

  constructor(token: string, fetcher: Fetch = fetch, base = API_BASE) {
    this.#token = token;
    this.#base = base.replace(/\/+$/, "");
    this.#fetch = fetcher;
  }

  #hide(text: string): string {
    return this.#token ? text.replaceAll(this.#token, "<token>") : text;
  }

  /** POST one method; returns its `result`. Throws TelegramError. */
  async call(method: string, params: Record<string, unknown> = {}, files?: Record<string, [string, Buffer, string]>, timeoutMs = 20_000, signal?: AbortSignal): Promise<any> {
    const url = `${this.#base}/bot${this.#token}/${method}`;
    const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== null && v !== undefined));
    let body: any;
    try {
      const timeout = AbortSignal.timeout(timeoutMs);
      const init: RequestInit = { method: "POST", signal: signal ? AbortSignal.any([signal, timeout]) : timeout };
      if (files) {
        // multipart: nested values (reply_markup) must be JSON text
        const form = new FormData();
        for (const [k, v] of Object.entries(clean)) form.append(k, typeof v === "string" ? v : JSON.stringify(v));
        for (const [k, [name, data, type]] of Object.entries(files)) form.append(k, new Blob([new Uint8Array(data)], { type }), name);
        init.body = form;
      } else {
        init.headers = { "Content-Type": "application/json" };
        init.body = JSON.stringify(clean);
      }
      const response = await this.#fetch(url, init);
      body = await response.json();
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new TelegramError(this.#hide(`${method} failed: ${(error as Error).message} (${url})`));
    }
    if (!body?.ok) throw new TelegramError(this.#hide(`${method}: ${body?.description ?? "unknown error"}`));
    return body.result;
  }

  /** New updates after `offset` (waits up to `timeout` seconds). */
  getUpdates(offset: number | null, timeout = 30, signal?: AbortSignal): Promise<any[]> {
    return this.call("getUpdates", { offset, timeout, allowed_updates: ["message", "callback_query"] }, undefined, (timeout + 10) * 1000, signal);
  }

  /** Plain text (no Markdown: model output would break its escaping). */
  sendMessage(chatId: number, text: string, buttons: Buttons | null = null) {
    return this.call("sendMessage", { chat_id: chatId, text, reply_markup: buttons ? { inline_keyboard: buttons } : null });
  }

  /** An OGG/Opus voice message. */
  sendVoice(chatId: number, ogg: Buffer) {
    return this.call("sendVoice", { chat_id: chatId }, { voice: ["luna.ogg", ogg, "audio/ogg"] }, 60_000);
  }

  /** Show "typing…" (lasts ~5 s on the phone). */
  async sendChatAction(chatId: number, action = "typing"): Promise<void> {
    await this.call("sendChatAction", { chat_id: chatId, action });
  }

  /** Stop the button's spinner, optionally with a short toast. */
  async answerCallback(callbackId: string, text: string | null = null): Promise<void> {
    await this.call("answerCallbackQuery", { callback_query_id: callbackId, text });
  }

  /** Remove the inline buttons from a message. */
  async clearButtons(chatId: number, messageId: number): Promise<void> {
    await this.call("editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } });
  }

  /** The bytes of a file the user sent. Throws TelegramError. */
  async download(fileId: string, maxBytes = MAX_DOWNLOAD_BYTES): Promise<Buffer> {
    const tooBig = `file is larger than ${Math.floor(maxBytes / (1024 * 1024))} MB`;
    const info = await this.call("getFile", { file_id: fileId });
    if ((info?.file_size ?? 0) > maxBytes) throw new TelegramError(tooBig);
    const file = info?.file_path;
    if (!file) throw new TelegramError("Telegram gave no download path for that file");
    const url = `${this.#base}/file/bot${this.#token}/${file}`;
    let data: Buffer;
    try {
      const response = await this.#fetch(url, { signal: AbortSignal.timeout(60_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      data = Buffer.from(await response.arrayBuffer());
    } catch (error) {
      throw new TelegramError(this.#hide(`download failed: ${(error as Error).message} (${url})`));
    }
    if (data.length > maxBytes) throw new TelegramError(tooBig);
    return data;
  }

  async close(): Promise<void> {
    // fetch keeps no connection to close
  }
}
