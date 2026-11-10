/**
 * Text-to-speech with Piper voices — small neural voices that run on your CPU.
 *
 * BEGINNER MAP
 * ------------
 * The browser's built-in speech gives the page no audio, so the web UI's
 * core could only guess when Luna is speaking. With Piper, the server makes
 * a real WAV per sentence; the browser plays it through an analyser, and the
 * core moves with the actual sound (see web/src/lib/speech.ts `Speaker`).
 *
 * A Piper voice is an ONNX model plus a JSON file. Speaking a sentence is
 * the same three steps the Piper program does:
 *
 *   1. text → phonemes   espeak-ng (`espeak-ng -q --ipa`), one clause at a
 *                        time, keeping the clause's punctuation so Luna
 *                        pauses where the text does
 *   2. phonemes → ids    the voice's phoneme_id_map: ^, then each phoneme
 *                        followed by the pad _, then $
 *   3. ids → audio       the ONNX model on onnxruntime (in this process,
 *                        loaded once), normalised to 16-bit mono WAV
 *
 *   - Voices: LUNA_TTS_VOICE (default en_US-lessac-medium, ~60 MB), downloaded
 *     once into data/voices/ (list: https://huggingface.co/rhasspy/piper-voices).
 *   - espeak-ng is a system program: `dnf/apt install espeak-ng`,
 *     `brew install espeak-ng`. Without it the UI uses browser speech.
 *   - Piper voices are MIT licensed; espeak-ng is GPL-3.0 and runs as a
 *     separate program.
 *
 * LUNA_TTS_ENGINE=browser turns this off and the UI uses browser speech.
 */

import { execFile } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

import type { Settings } from "../config/settings.ts";
import { which } from "../web/window.ts";
import { downloadOnce } from "./download.ts";
import { pcmToWav } from "./wav.ts";

// One sentence at a time is the norm; this only stops abuse of the endpoint.
export const MAX_TEXT_CHARS = 1000;
const VOICES_URL = "https://huggingface.co/rhasspy/piper-voices/resolve/main";
// Punctuation that ends a clause; it is kept as a phoneme (a pause / tone).
const CLAUSE = /([^.,!?;:]*)([.,!?;:]+|$)/g;

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

/** The parts of a voice's .onnx.json that synthesis uses. */
export interface VoiceConfig {
  audio: { sample_rate: number };
  espeak: { voice: string };
  inference: { noise_scale: number; length_scale: number; noise_w: number };
  phoneme_id_map: Record<string, number[]>;
  num_speakers?: number;
}

/** Text → clauses with their ending punctuation: "Hi, Sir." → [["Hi", ","], ["Sir", "."]]. */
export function clauses(text: string): [string, string][] {
  const out: [string, string][] = [];
  for (const m of text.matchAll(CLAUSE)) {
    const words = m[1].trim();
    const mark = m[2].trim();
    if (words) out.push([words, mark ? mark[mark.length - 1] : ""]);
    else if (mark && out.length) out[out.length - 1][1] = mark[mark.length - 1];
  }
  return out;
}

/** Phonemes → model ids: ^, every known phoneme followed by _, then $ (Piper's rule). */
export function phonemeIds(phonemes: string, map: Record<string, number[]>): number[] {
  const ids = [...(map["^"] ?? [])];
  for (const phoneme of phonemes.normalize("NFD")) {
    const known = map[phoneme];
    if (!known) continue; // Piper skips phonemes the voice doesn't know
    ids.push(...known, ...(map["_"] ?? []));
  }
  ids.push(...(map["$"] ?? []));
  return ids;
}

/** Float audio → 16-bit PCM, louder parts scaled to full range (Piper's normalisation). */
export function floatToPcm(audio: Float32Array): Buffer {
  let peak = 0.01;
  for (const v of audio) peak = Math.max(peak, Math.abs(v));
  const scale = 32767 / peak;
  const out = Buffer.alloc(audio.length * 2);
  for (let i = 0; i < audio.length; i++) out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(audio[i] * scale))), i * 2);
  return out;
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** IPA phonemes for one clause from espeak-ng. */
function espeak(command: string, voice: string, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, ["-q", "--ipa", "-v", voice, "--", text], { timeout: 15_000 }, (error, stdout) => {
      if (error) reject(new Error(`espeak-ng failed: ${error.message}`));
      else resolve(stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join(" "));
    });
  });
}

type Session = {
  run(feeds: Record<string, unknown>): Promise<Record<string, { data: Float32Array }>>;
  release?(): Promise<void>;
};

/** One Piper voice, loaded on first use; synthesizes sentences one at a time. */
export class PiperTTS implements TextToSpeech {
  readonly voiceName: string;
  readonly voicesDir: string;
  readonly lengthScale: number;
  #ready: Promise<{ session: Session; config: VoiceConfig; espeak: string; ort: typeof import("onnxruntime-node") }> | null = null;
  #queue: Promise<unknown> = Promise.resolve(); // one sentence at a time

  constructor(voice: string, voicesDir: string, lengthScale = 1.0) {
    this.voiceName = voice;
    this.voicesDir = voicesDir;
    this.lengthScale = lengthScale;
  }

  /** Where the Piper voice model file is (downloaded on first use). */
  get modelPath(): string {
    return path.join(this.voicesDir, `${this.voiceName}.onnx`);
  }

  #prepare() {
    this.#ready ??= (async () => {
      const command = which("espeak-ng");
      if (!command) throw new Error("espeak-ng not found: install it (dnf/apt install espeak-ng, brew install espeak-ng) for Luna's voice");
      const url = voiceUrl(this.voiceName);
      if (!isFile(this.modelPath) || !isFile(`${this.modelPath}.json`)) console.error(`Downloading Piper voice ${this.voiceName} (one time)…`);
      await downloadOnce(url, this.modelPath);
      await downloadOnce(`${url}.json`, `${this.modelPath}.json`);
      const config = JSON.parse(readFileSync(`${this.modelPath}.json`, "utf8")) as VoiceConfig;
      const ort = await import("onnxruntime-node");
      const session = (await ort.InferenceSession.create(this.modelPath)) as unknown as Session;
      return { session, config, espeak: command, ort };
    })();
    this.#ready.catch(() => (this.#ready = null)); // try again next time
    return this.#ready;
  }

  /** WAV (16-bit mono, the voice's sample rate) for `text`. */
  synthesize(text: string): Promise<Buffer> {
    const clean = [...text.split(/\s+/).filter(Boolean).join(" ")].slice(0, MAX_TEXT_CHARS).join("");
    if (!clean) return Promise.reject(new Error("Nothing to say."));
    const job = this.#queue.then(async () => {
      const { session, config, espeak: command, ort } = await this.#prepare();
      let phonemes = "";
      for (const [words, mark] of clauses(clean)) {
        phonemes += (phonemes ? " " : "") + (await espeak(command, config.espeak.voice, words)) + mark;
      }
      const ids = phonemeIds(phonemes, config.phoneme_id_map);
      const { noise_scale, noise_w } = config.inference;
      const feeds: Record<string, unknown> = {
        input: new ort.Tensor("int64", BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
        input_lengths: new ort.Tensor("int64", BigInt64Array.from([BigInt(ids.length)]), [1]),
        scales: new ort.Tensor("float32", Float32Array.from([noise_scale, this.lengthScale, noise_w]), [3]),
      };
      if ((config.num_speakers ?? 1) > 1) feeds.sid = new ort.Tensor("int64", BigInt64Array.from([0n]), [1]);
      const output = await session.run(feeds);
      return pcmToWav(floatToPcm(output.output.data), config.audio.sample_rate);
    });
    this.#queue = job.catch(() => undefined);
    return job;
  }

  /** Download/load the voice and run it once, so the first reply isn't slow. */
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
  return new PiperTTS(settings.tts_voice, settings.tts_voices_dir, settings.tts_length_scale);
}
