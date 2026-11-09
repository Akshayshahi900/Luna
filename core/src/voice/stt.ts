/**
 * Speech-to-text with Whisper (whisper.cpp), running locally on the CPU.
 *
 * BEGINNER MAP
 * ------------
 * The browser records one utterance at a time (it detects when you start and
 * stop talking), sends it to POST /api/stt as a 16 kHz WAV, and gets text
 * back. Nothing leaves your machine, and it works in any browser.
 *
 *   - Engine: whisper.cpp through @fugood/whisper.node (prebuilt binaries,
 *     nothing to compile). The model stays loaded between utterances.
 *   - Model: LUNA_STT_MODEL (default base.en, ~140 MB), the ggml file
 *     ggml-<model>.bin, downloaded once into data/models/whisper.
 *     small.en is more accurate and slower.
 *   - The prompt "Hey Luna." makes Whisper spell the wake word as "Luna"
 *     instead of "Lunar" (D22). Wake-word logic itself lives in the browser
 *     (web/src/lib/intent.ts).
 *
 * LUNA_STT_ENGINE=browser turns this off; the UI then uses Chrome/Edge
 * speech recognition and has no wake word.
 */

import path from "node:path";

import type { Settings } from "../config/settings.ts";
import { downloadOnce } from "./download.ts";
import { MAX_SECONDS, SAMPLE_RATE, wavToPcm } from "./wav.ts";

export { MAX_SECONDS, SAMPLE_RATE, wavToPcm };
export const WAKE_PROMPT = "Hey Luna.";
const MODEL_URL = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";

/** What /api/stt needs from an engine (tests pass fakes). */
export interface SpeechToText {
  transcribe(pcm: Buffer, samples: number, prompt?: string | null): Promise<string>;
  warmUp(): Promise<void>;
}

interface NativeContext {
  transcribeData(data: ArrayBuffer, options: Record<string, unknown>): { promise: Promise<{ result: string }>; stop(): Promise<void> };
  release(): Promise<void>;
}

/** Loads one whisper.cpp model on first use; transcribes utterances one at a time. */
export class WhisperSTT implements SpeechToText {
  readonly modelName: string;
  readonly modelsDir: string;
  readonly threads: number;
  #context: Promise<NativeContext> | null = null;
  #queue: Promise<unknown> = Promise.resolve(); // one transcription at a time keeps CPU use predictable

  constructor(model: string, modelsDir: string, threads = 4) {
    this.modelName = model;
    this.modelsDir = modelsDir;
    this.threads = threads;
  }

  /** The ggml model file (downloaded on first use). */
  get modelPath(): string {
    return path.join(this.modelsDir, `ggml-${this.modelName}.bin`);
  }

  #load(): Promise<NativeContext> {
    this.#context ??= (async () => {
      console.error(`Loading Whisper ${this.modelName} (the first time downloads it)…`);
      await downloadOnce(`${MODEL_URL}/ggml-${this.modelName}.bin`, this.modelPath);
      const whisper = (await import("@fugood/whisper.node" as string)) as { initWhisper(o: Record<string, unknown>): Promise<NativeContext> };
      return whisper.initWhisper({ model: this.modelPath, useGpu: false });
    })();
    this.#context.catch(() => (this.#context = null)); // try again next time
    return this.#context;
  }

  /** Text for one utterance (16-bit PCM at 16 kHz). */
  transcribe(pcm: Buffer, _samples: number, prompt: string | null = WAKE_PROMPT): Promise<string> {
    const job = this.#queue.then(async () => {
      const context = await this.#load();
      const data = pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) as ArrayBuffer;
      const { promise } = context.transcribeData(data, {
        language: this.modelName.endsWith(".en") ? "en" : "auto",
        maxThreads: this.threads,
        beamSize: 1, // greedy: much faster, same result on short commands
        ...(prompt ? { prompt } : {}),
      });
      const { result } = await promise;
      return (result ?? "").split(/\s+/).filter(Boolean).join(" ");
    });
    this.#queue = job.catch(() => undefined);
    return job;
  }

  /** Download/load the model in the background so the first command is quick. */
  async warmUp(): Promise<void> {
    try {
      const silence = Buffer.alloc((SAMPLE_RATE / 2) * 2);
      await this.transcribe(silence, SAMPLE_RATE / 2);
      console.error(`Whisper ${this.modelName} ready`);
    } catch (error) {
      // the UI falls back to browser recognition
      console.error(`Whisper unavailable (${(error as Error).message}).`);
    }
  }

  async close(): Promise<void> {
    const context = await this.#context?.catch(() => null);
    await context?.release();
  }
}

/** The configured engine, or null for browser speech recognition. */
export function createStt(settings: Settings): WhisperSTT | null {
  if (settings.stt_engine !== "whisper") return null;
  return new WhisperSTT(settings.stt_model, settings.stt_models_dir, settings.stt_threads);
}
