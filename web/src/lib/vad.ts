// Voice activity detection: cut a continuous mic stream into utterances,
// and package them as 16 kHz WAV for /api/stt. Pure logic, tested in
// vad.test.ts; voiceInput.ts feeds it real mic frames.

import { rms } from "./analysis";

export interface SegmenterOptions {
  /** speech must last this long before an utterance starts (filters clicks) */
  startMs: number;
  /** audio kept from just before the start, so the first syllable isn't cut */
  preRollMs: number;
  /** this much silence ends the utterance */
  endSilenceMs: number;
  /** hard cap on one utterance */
  maxMs: number;
  /** utterances with less voiced audio than this are dropped */
  minSpeechMs: number;
}

export const DEFAULT_SEGMENTER: SegmenterOptions = {
  startMs: 60,
  preRollMs: 500,
  endSilenceMs: 800,
  maxMs: 15000,
  minSpeechMs: 200,
};

export type SegmentEvent = "start" | "end" | "discard" | null;

/**
 * Energy-based VAD with an adaptive noise floor: "speech" is ~11 dB above
 * the room's recent quiet level. Not perfect in loud rooms, but the server
 * runs Silero VAD on each utterance too, so noise that slips through
 * becomes an empty transcript and is ignored.
 */
export class Segmenter {
  readonly opts: SegmenterOptions;
  private floor = 0.004;
  private run = 0; // consecutive speech frames before start
  private silence = 0; // consecutive quiet frames during an utterance
  private voiced = 0; // voiced frames in the current utterance
  private frames: Float32Array[] = [];
  private preRoll: Float32Array[] = [];
  private last: Float32Array = new Float32Array(0);
  private inSpeech = false;
  /** multiplies the threshold, e.g. raised while Luna is talking */
  sensitivity = 1;

  constructor(
    readonly sampleRate: number,
    readonly frameSize: number,
    opts: Partial<SegmenterOptions> = {},
  ) {
    this.opts = { ...DEFAULT_SEGMENTER, ...opts };
  }

  get active(): boolean {
    return this.inSpeech;
  }

  /** How many frames last `ms` milliseconds. */
  private count(ms: number): number {
    return Math.max(1, Math.round((ms / 1000) * (this.sampleRate / this.frameSize)));
  }

  get threshold(): number {
    return Math.max(this.floor * 3.5, 0.006) * this.sensitivity;
  }

  push(frame: Float32Array): SegmentEvent {
    const level = rms(frame);
    const speech = level > this.threshold;

    if (!this.inSpeech) {
      // Track the room's quiet level: falls quickly, rises slowly.
      this.floor = level < this.floor ? this.floor * 0.9 + level * 0.1 : this.floor * 1.0015;
      this.floor = Math.max(this.floor, 0.0015);
      this.preRoll.push(frame);
      if (this.preRoll.length > this.count(this.opts.preRollMs)) this.preRoll.shift();
      this.run = speech ? this.run + 1 : 0;
      if (this.run >= this.count(this.opts.startMs)) {
        this.inSpeech = true;
        this.frames = [...this.preRoll];
        this.preRoll = [];
        this.voiced = this.run;
        this.silence = 0;
        this.run = 0;
        return "start";
      }
      return null;
    }

    this.frames.push(frame);
    // Hysteresis: once talking, a slightly quieter frame still counts.
    if (level > this.threshold * 0.7) {
      this.voiced += 1;
      this.silence = 0;
    } else {
      this.silence += 1;
    }
    const tooLong = this.frames.length >= this.count(this.opts.maxMs);
    if (this.silence >= this.count(this.opts.endSilenceMs) || tooLong) return this.finish();
    return null;
  }

  /** End the current utterance now (e.g. push-to-talk released). */
  flush(): SegmentEvent {
    return this.inSpeech ? this.finish() : null;
  }

  /** Forget any utterance in progress. */
  reset(): void {
    this.inSpeech = false;
    this.frames = [];
    this.preRoll = [];
    this.run = this.silence = this.voiced = 0;
  }

  /** Samples of the utterance that just ended ("end"). */
  take(): Float32Array {
    const out = this.last;
    this.last = new Float32Array(0);
    return out;
  }

  private finish(): SegmentEvent {
    const enough = this.voiced >= this.count(this.opts.minSpeechMs);
    // Drop the trailing silence, keep ~200 ms of it.
    const keep = this.frames.length - Math.max(0, this.silence - this.count(200));
    const frames = this.frames.slice(0, keep);
    this.reset();
    if (!enough) return "discard";
    const total = frames.reduce((n, f) => n + f.length, 0);
    this.last = new Float32Array(total);
    let at = 0;
    for (const f of frames) {
      this.last.set(f, at);
      at += f.length;
    }
    return "end";
  }
}

/** Resample by averaging (a box filter also removes most aliasing). */
export function downsample(input: Float32Array, fromRate: number, toRate = 16000): Float32Array {
  if (fromRate === toRate) return input.slice();
  const ratio = fromRate / toRate;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.max(start + 1, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end && j < input.length; j++) sum += input[j];
    out[i] = sum / (end - start);
  }
  return out;
}

/** 16-bit mono PCM WAV. */
export function encodeWav(samples: Float32Array, sampleRate = 16000): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buffer);
  const text = (at: number, s: string) => [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
  text(0, "RIFF");
  v.setUint32(4, 36 + samples.length * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  v.setUint32(16, 16, true); // fmt chunk size
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true); // byte rate
  v.setUint16(32, 2, true); // block align
  v.setUint16(34, 16, true); // bits per sample
  text(36, "data");
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buffer;
}
