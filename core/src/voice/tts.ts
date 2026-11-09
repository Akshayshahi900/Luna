/**
 * Text-to-speech with Piper — a small neural voice that runs on your CPU.
 *
 * BEGINNER MAP
 * ------------
 * The browser's built-in speech gives the page no audio, so the web UI's
 * core could only guess when Luna is speaking. With Piper, the server makes
 * a real WAV per sentence; the browser plays it through an analyser, and the
 * core moves with the actual sound (see web/src/lib/speech.ts `Speaker`).
 *
 *   - Piper is a separate program (https://github.com/rhasspy/piper
 *     releases): unpack it into data/piper/ (so data/piper/piper exists),
 *     put `piper` on your PATH, or set LUNA_TTS_PIPER_COMMAND.
 *   - The voice model (~60 MB) downloads once into data/voices/ the first
 *     time it's needed (LUNA_TTS_VOICE picks which; list at
 *     https://huggingface.co/rhasspy/piper-voices).
 *   - Each sentence runs `piper --model <voice> --output_file <tmp>.wav`
 *     with the text on stdin, one at a time.
 *   - Piper is GPL-3.0: fine to use, mind it if you redistribute Luna.
 *
 * Another program called `piper` (a gaming-mouse tool) exists on some Linux
 * systems, so the command is checked once: its --help must mention --model.
 *
 * LUNA_TTS_ENGINE=browser turns this off and the UI uses browser speech.
 */

import { execFile, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { PROJECT_ROOT, type Settings } from "../config/settings.ts";
import { which } from "../web/window.ts";
import { downloadOnce } from "./download.ts";

// One sentence at a time is the norm; this only stops abuse of the endpoint.
export const MAX_TEXT_CHARS = 1000;
const VOICES_URL = "https://huggingface.co/rhasspy/piper-voices/resolve/main";
const SYNTH_TIMEOUT_MS = 60_000;

/** What /api/tts needs from an engine (tests pass fakes). */
export interface TextToSpeech {
  synthesize(text: string): Promise<Buffer>;
  warmUp(): Promise<void>;
}

/** Where a voice lives on Hugging Face: en_US-lessac-medium → en/en_US/lessac/medium/. */
export function voiceUrl(voice: string): string {
  const m = /^(([a-z]{2,3})_[A-Za-z]{2,3})-(.+)-([a-z_]+)$/.exec(voice);
  if (!m) throw new Error(`Not a Piper voice name: '${voice}' (like en_US-lessac-medium)`);
  return `${VOICES_URL}/${m[2]}/${m[1]}/${m[3]}/${m[4]}/${voice}.onnx`;
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** True when `command --help` looks like the Piper TTS program. */
function looksLikePiper(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(command, ["--help"], { timeout: 5000 }, (_error, stdout, stderr) => {
      resolve(/--model|--output_file/.test(`${stdout}${stderr}`));
    });
  });
}

/** The Piper program to run: the setting, data/piper/piper, then PATH. */
export async function findPiper(preferred: string | null): Promise<string> {
  const candidates = preferred ? [preferred] : [path.join(PROJECT_ROOT, "data", "piper", "piper"), "piper-tts", "piper"];
  for (const candidate of candidates) {
    const found = isFile(candidate) ? candidate : which(candidate);
    if (found && (await looksLikePiper(found))) return found;
  }
  throw new Error(
    "Piper TTS not found: unpack a release from https://github.com/rhasspy/piper/releases into data/piper/, " +
      "or set LUNA_TTS_PIPER_COMMAND (docs/web-ui.md).",
  );
}

/** Runs the Piper program for each sentence, downloading the voice on first use. */
export class PiperTTS implements TextToSpeech {
  readonly voiceName: string;
  readonly voicesDir: string;
  readonly lengthScale: number;
  readonly command: string | null;
  #ready: Promise<string> | null = null;
  #queue: Promise<unknown> = Promise.resolve(); // one sentence at a time

  constructor(voice: string, voicesDir: string, lengthScale = 1.0, command: string | null = null) {
    this.voiceName = voice;
    this.voicesDir = voicesDir;
    this.lengthScale = lengthScale;
    this.command = command;
  }

  /** Where the Piper voice model file is (downloaded on first use). */
  get modelPath(): string {
    return path.join(this.voicesDir, `${this.voiceName}.onnx`);
  }

  #prepare(): Promise<string> {
    this.#ready ??= (async () => {
      const url = voiceUrl(this.voiceName);
      if (!isFile(this.modelPath) || !isFile(`${this.modelPath}.json`)) console.error(`Downloading Piper voice ${this.voiceName} (one time)…`);
      await downloadOnce(url, this.modelPath);
      await downloadOnce(`${url}.json`, `${this.modelPath}.json`);
      return findPiper(this.command);
    })();
    this.#ready.catch(() => (this.#ready = null));
    return this.#ready;
  }

  /** WAV (16-bit mono) for `text`. */
  synthesize(text: string): Promise<Buffer> {
    const clean = [...text.split(/\s+/).filter(Boolean).join(" ")].slice(0, MAX_TEXT_CHARS).join("");
    if (!clean) return Promise.reject(new Error("Nothing to say."));
    const job = this.#queue.then(async () => {
      const program = await this.#prepare();
      const dir = mkdtempSync(path.join(tmpdir(), "luna-tts-"));
      const out = path.join(dir, "speech.wav");
      try {
        await new Promise<void>((resolve, reject) => {
          const child = spawn(program, ["--model", this.modelPath, "--length_scale", String(this.lengthScale), "--output_file", out], {
            stdio: ["pipe", "ignore", "pipe"],
            timeout: SYNTH_TIMEOUT_MS,
          });
          let err = "";
          child.stderr.on("data", (c: Buffer) => (err = (err + c.toString()).slice(-2000)));
          child.on("error", reject);
          child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`piper exited with ${code}: ${err.trim().split("\n").at(-1) ?? ""}`))));
          child.stdin.end(clean + "\n");
        });
        return readFileSync(out);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
    this.#queue = job.catch(() => undefined);
    return job;
  }

  /** Download the voice and run it once, so the first reply isn't slow. */
  async warmUp(): Promise<void> {
    try {
      await this.synthesize("Ready.");
      console.error(`Piper voice ${this.voiceName} ready`);
    } catch (error) {
      // the UI falls back to browser speech
      console.error(`Piper voice unavailable (${(error as Error).message}); the UI will use browser speech.`);
    }
  }
}

/** The configured engine, or null for browser speech. */
export function createTts(settings: Settings): PiperTTS | null {
  if (settings.tts_engine !== "piper") return null;
  return new PiperTTS(settings.tts_voice, settings.tts_voices_dir, settings.tts_length_scale, settings.tts_piper_command);
}
