/**
 * Speech-to-text with Whisper, running locally on the CPU.
 *
 * BEGINNER MAP
 * ------------
 * The browser records one utterance at a time (it detects when you start and
 * stop talking), sends it to POST /api/stt as a 16 kHz WAV, and gets text
 * back. Nothing leaves your machine, and it works in any browser. Telegram
 * voice notes (channels/telegram.ts) use the same engine.
 *
 *   - Engine: Whisper as ONNX through @huggingface/transformers, which runs
 *     on onnxruntime: prebuilt for Linux, macOS and Windows, and it picks
 *     the CPU's fastest instructions (AVX2, AVX-512, NEON…) at runtime, so
 *     nothing is compiled and nothing breaks on an older CPU (D41).
 *   - Model: LUNA_STT_MODEL (default base.en → onnx-community/whisper-base.en,
 *     the 8-bit "q8" files, ~75 MB), downloaded once into data/models/whisper
 *     and kept loaded. tiny.en is faster, small.en more accurate. A full
 *     Hugging Face id ("org/name") works too.
 *   - Silence gate: Whisper invents words for silence ("you", "Thank
 *     you."), so audio with no loud-enough 20 ms frames returns "" without
 *     running the model. (The Python version used faster-whisper's Silero
 *     VAD filter for the same reason.)
 *   - Measured on a laptop CPU (i5-12450H): ~0.9 s for a 2 s command with
 *     base.en.
 *
 * The browser accepts the ways Whisper may spell the wake word ("Luna",
 * "Lunar", …; web/src/lib/intent.ts), so no text prompt is needed.
 *
 * LUNA_STT_ENGINE=browser turns this off; the UI then uses Chrome/Edge
 * speech recognition and has no wake word.
 */

import type { Settings } from "../config/settings.ts";
import { MAX_SECONDS, pcmToFloat, SAMPLE_RATE, wavToPcm } from "./wav.ts";

export { MAX_SECONDS, SAMPLE_RATE, wavToPcm };

// A 20 ms frame counts as sound above this RMS (~ -46 dBFS); an utterance
// needs at least MIN_LOUD_FRAMES of them (60 ms) to be sent to Whisper.
const FRAME = SAMPLE_RATE / 50;
const LOUD_RMS = 0.005;
const MIN_LOUD_FRAMES = 3;

/** What /api/stt needs from an engine (tests pass fakes). */
export interface SpeechToText {
  transcribe(pcm: Buffer, samples: number, prompt?: string | null): Promise<string>;
  warmUp(): Promise<void>;
}

/** True when the audio has enough loud frames to hold any speech. */
export function hasSound(samples: Float32Array): boolean {
  let loud = 0;
  for (let start = 0; start + FRAME <= samples.length; start += FRAME) {
    let sum = 0;
    for (let i = start; i < start + FRAME; i++) sum += samples[i] * samples[i];
    if (Math.sqrt(sum / FRAME) > LOUD_RMS && ++loud >= MIN_LOUD_FRAMES) return true;
  }
  return false;
}

/** Whisper's text, without its "[BLANK_AUDIO]" / "(music)" style notes. */
export function cleanTranscript(text: string): string {
  return text.replace(/\[[^\]]*\]|\([^)]*\)/g, " ").split(/\s+/).filter(Boolean).join(" ");
}

/** LUNA_STT_MODEL → a Hugging Face model id ("base.en" → onnx-community/whisper-base.en). */
export function modelId(name: string): string {
  return name.includes("/") ? name : `onnx-community/whisper-${name}`;
}

type Recognizer = ((audio: Float32Array) => Promise<{ text?: string } | { text?: string }[]>) & { dispose?(): Promise<void> };

/** Loads one Whisper model on first use; transcribes utterances one at a time. */
export class WhisperSTT implements SpeechToText {
  readonly modelName: string;
  readonly modelsDir: string;
  readonly threads: number;
  #recognizer: Promise<Recognizer> | null = null;
  #queue: Promise<unknown> = Promise.resolve(); // one transcription at a time keeps CPU use predictable

  constructor(model: string, modelsDir: string, threads = 4) {
    this.modelName = model;
    this.modelsDir = modelsDir;
    this.threads = threads;
  }

  /** The Hugging Face model this engine uses (cached under modelsDir). */
  get model(): string {
    return modelId(this.modelName);
  }

  #load(): Promise<Recognizer> {
    this.#recognizer ??= (async () => {
      console.error(`Loading Whisper ${this.modelName} (the first time downloads it)…`);
      const transformers = await import("@huggingface/transformers");
      transformers.env.cacheDir = this.modelsDir;
      return (await transformers.pipeline("automatic-speech-recognition", this.model, {
        dtype: "q8",
        device: "cpu",
        session_options: { intraOpNumThreads: this.threads },
      } as never)) as unknown as Recognizer;
    })();
    this.#recognizer.catch(() => (this.#recognizer = null)); // try again next time
    return this.#recognizer;
  }

  /** Text for one utterance (16-bit PCM at 16 kHz); "" when it is silent. */
  transcribe(pcm: Buffer, _samples: number, _prompt: string | null = null): Promise<string> {
    const audio = pcmToFloat(pcm);
    if (!hasSound(audio)) return Promise.resolve("");
    const job = this.#queue.then(async () => {
      const recognizer = await this.#load();
      const result = await recognizer(audio);
      const text = Array.isArray(result) ? result.map((r) => r.text ?? "").join(" ") : (result.text ?? "");
      return cleanTranscript(text);
    });
    this.#queue = job.catch(() => undefined);
    return job;
  }

  /** Download/load the model in the background so the first command is quick. */
  async warmUp(): Promise<void> {
    try {
      const recognizer = await this.#load();
      await recognizer(new Float32Array(SAMPLE_RATE / 2)); // one run builds the ONNX graphs
      console.error(`Whisper ${this.modelName} ready`);
    } catch (error) {
      // the UI falls back to browser recognition
      console.error(`Whisper unavailable (${(error as Error).message}).`);
    }
  }

  async close(): Promise<void> {
    const recognizer = await this.#recognizer?.catch(() => null);
    await recognizer?.dispose?.();
    this.#recognizer = null;
  }
}

/** The configured engine, or null for browser speech recognition. */
export function createStt(settings: Settings): WhisperSTT | null {
  if (settings.stt_engine !== "whisper") return null;
  return new WhisperSTT(settings.stt_model, settings.stt_models_dir, settings.stt_threads);
}
