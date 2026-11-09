/**
 * Chat-app channels: use Luna from your phone.
 *
 * BEGINNER MAP
 * ------------
 *   - telegram.ts      TelegramBridge: one private chat = one session (like a
 *                      browser tab): text, voice notes, photos, files, approvals
 *   - telegram_api.ts  the few Bot API calls it needs, over fetch (long polling)
 *   - media.ts         voice note ⇄ Whisper / Piper audio (ffmpeg), photo sizes, long text
 *
 * The bridge runs inside luna-web (started in web/server.ts when
 * LUNA_TELEGRAM_BOT_TOKEN is set). Setup: docs/messaging.md.
 */

import type { AgentHost } from "../web/session.ts";
import { startTelegram as start, TelegramBridge } from "./telegram.ts";

export { TelegramBridge };

export async function startTelegram(host: AgentHost, statePath: string): Promise<TelegramBridge | null> {
  return start(host, statePath);
}
