/**
 * Audio, photo and text helpers for chat apps (Telegram today).
 *
 * BEGINNER MAP
 * ------------
 * Chat apps send and expect formats the rest of Luna doesn't use:
 *
 *   voice note in   OGG/Opus (any length)  → decodeAudio → 16 kHz 16-bit PCM
 *                                            for WhisperSTT (voice/stt.ts)
 *   voice note out  Piper's WAV            → wavToOggOpus → OGG/Opus, which
 *                                            Telegram shows as a voice message
 *   photo in        several sizes          → pickPhoto picks one the model can use
 *   text out        one long reply         → splitText cuts it to the 4096-char limit
 *
 * Audio goes through the ffmpeg program (install it with your package
 * manager; `ffmpeg -version` should work). LUNA uses it only here.
 */

import { spawn } from "node:child_process";

import { SAMPLE_RATE } from "../voice/wav.ts";

// Voice notes longer than this are refused (Whisper on CPU would take minutes).
export const MAX_VOICE_SECONDS = 300;
// Telegram's limit for one text message.
export const TEXT_LIMIT = 4096;
// Big enough to read text in a screenshot, small enough to keep the thread lean.
export const PHOTO_MAX_SIDE = 1280;
// Telegram voice messages are Opus at 48 kHz.
export const OPUS_RATE = 48_000;

/** Run ffmpeg with `input` on stdin; resolve its stdout. `maxBytes` stops it early. */
function ffmpeg(args: string[], input: Buffer, maxBytes = Infinity): Promise<{ out: Buffer; cut: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", ...args], { stdio: ["pipe", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let size = 0;
    let cut = false;
    let err = "";
    child.stdout.on("data", (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) {
        cut = true;
        child.kill("SIGKILL");
        return;
      }
      chunks.push(c);
    });
    child.stderr.on("data", (c: Buffer) => (err = (err + c.toString()).slice(-1000)));
    child.on("error", (e) => reject(new Error(`ffmpeg is needed for voice notes (${(e as Error).message})`)));
    child.on("close", (code) => {
      if (cut) return resolve({ out: Buffer.concat(chunks), cut });
      if (code !== 0) return reject(new Error(`couldn't read that audio (${err.trim().split("\n").at(-1) || `ffmpeg exit ${code}`})`));
      resolve({ out: Buffer.concat(chunks), cut });
    });
    child.stdin.on("error", () => undefined); // ffmpeg may stop reading early
    child.stdin.end(input);
  });
}

/**
 * Any audio file ffmpeg can read (OGG/Opus, MP3, M4A, WAV…) → 16 kHz mono
 * 16-bit PCM. Throws for bad or too-long audio.
 */
export async function decodeAudio(data: Buffer, maxSeconds = MAX_VOICE_SECONDS): Promise<Buffer> {
  const limit = SAMPLE_RATE * maxSeconds * 2;
  const { out, cut } = await ffmpeg(["-i", "pipe:0", "-f", "s16le", "-acodec", "pcm_s16le", "-ac", "1", "-ar", String(SAMPLE_RATE), "pipe:1"], data, limit);
  if (cut) throw new Error(`voice note longer than ${Math.floor(maxSeconds / 60) || maxSeconds} ${maxSeconds >= 60 ? "minutes" : "seconds"}`);
  return out;
}

/** A WAV file (Piper's output) → OGG/Opus bytes for a voice message. */
export async function wavToOggOpus(wav: Buffer): Promise<Buffer> {
  const { out } = await ffmpeg(["-f", "wav", "-i", "pipe:0", "-c:a", "libopus", "-ar", String(OPUS_RATE), "-ac", "1", "-f", "ogg", "pipe:1"], wav);
  return out;
}

export interface PhotoSize {
  file_id: string;
  file_unique_id?: string;
  width?: number;
  height?: number;
}

/** The largest photo size that fits `maxSide` (else the smallest one).
 * Telegram sends every photo in several sizes, smallest first. */
export function pickPhoto(sizes: PhotoSize[], maxSide = PHOTO_MAX_SIDE): PhotoSize | null {
  if (!sizes.length) return null;
  const area = (s: PhotoSize) => (s.width ?? 0) * (s.height ?? 0);
  const fits = sizes.filter((s) => Math.max(s.width ?? 0, s.height ?? 0) <= maxSide);
  if (fits.length) return fits.reduce((a, b) => (area(b) > area(a) ? b : a));
  return sizes.reduce((a, b) => (area(b) < area(a) ? b : a));
}

/** Cut `text` into messages of at most `limit` characters, preferring
 * paragraph, then line, then word breaks. */
export function splitText(text: string, limit = TEXT_LIMIT): string[] {
  text = text.trim();
  const parts: string[] = [];
  while (text.length > limit) {
    const window = text.slice(0, limit);
    let cut = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf("\n"), window.lastIndexOf(" "));
    if (cut < Math.floor(limit / 2)) cut = limit; // no good break: hard cut
    parts.push(text.slice(0, cut).trimEnd());
    text = text.slice(cut).trimStart();
  }
  if (text) parts.push(text);
  return parts;
}

/** A file name that can't leave its folder or upset a shell. */
export function safeFilename(name: string, fallback = "file"): string {
  const base = name.replaceAll("\\", "/").split("/").at(-1) ?? "";
  const clean = base.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._]+|[._]+$/g, "");
  return clean.slice(0, 100) || fallback;
}
