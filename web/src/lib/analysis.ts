// Turns live audio (Luna's voice or your mic) into the numbers the core
// animates with. The math parts are plain functions so they can be tested.

export const BINS = 64;

/** One frame of voice features, all roughly 0..1. */
export interface VoiceFrame {
  /** loudness envelope (RMS-based, fast attack / slower release) */
  level: number;
  /** ~80–300 Hz: the voice's body / pitch energy */
  low: number;
  /** ~300–2000 Hz: vowels (formants) */
  mid: number;
  /** ~2–7 kHz: consonants, "s" / "t" sounds */
  high: number;
  /** increments on every detected syllable onset */
  onsets: number;
}

export const emptyFrame = (): VoiceFrame => ({ level: 0, low: 0, mid: 0, high: 0, onsets: 0 });

/**
 * FFT bin ranges for `count` bands spaced logarithmically between fMin and
 * fMax, like hearing: low frequencies get more bands than highs.
 */
export function logBands(count: number, fMin: number, fMax: number, sampleRate: number, fftSize: number): [number, number][] {
  const hzPerBin = sampleRate / fftSize;
  const last = fftSize / 2 - 1;
  const out: [number, number][] = [];
  for (let i = 0; i < count; i++) {
    const f0 = fMin * (fMax / fMin) ** (i / count);
    const f1 = fMin * (fMax / fMin) ** ((i + 1) / count);
    const b0 = Math.min(last, Math.floor(f0 / hzPerBin));
    const b1 = Math.min(last, Math.max(b0, Math.ceil(f1 / hzPerBin) - 1));
    out.push([b0, b1]);
  }
  return out;
}

/** Root-mean-square of a waveform buffer (-1..1 samples). */
export function rms(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / (samples.length || 1));
}

/** Soft loudness curve: rises like `rms * gain` when quiet, never quite hits 1,
 * so loud passages still show variation instead of pinning at the top. */
export function loudness(rmsValue: number, gain: number): number {
  return 1 - Math.exp(-rmsValue * gain);
}

/** Rescale `v` so [lo, hi] maps to [0, 1] (clamped). */
export function stretch(v: number, lo: number, hi: number): number {
  return Math.min(1, Math.max(0, (v - lo) / (hi - lo)));
}

/**
 * Self-calibrating 0..1 range for one frequency band: tracks the band's
 * recent peak (slowly forgotten) and reports how close the current value
 * is to it. Works the same for any voice, mic or browser, where fixed
 * thresholds would pin at 0 or 1.
 */
export class AutoRange {
  private peak: number;

  constructor(
    private floor = 0.05,
    /** per-frame peak decay: 0.997 ≈ halves in 4 s at 60 fps */
    private decay = 0.997,
  ) {
    this.peak = floor;
  }

  push(v: number): number {
    this.peak = Math.max(v, this.peak * this.decay, this.floor);
    return stretch(v, this.peak * 0.45, this.peak);
  }
}

/** Moves toward `target` quickly when rising and slowly when falling. */
export function follow(current: number, target: number, attack: number, release: number): number {
  return current + (target - current) * (target > current ? attack : release);
}

/**
 * Syllable onset detector: a fast and a slow envelope; when the fast one
 * jumps clearly above the slow one, a new syllable / word started.
 */
export class OnsetDetector {
  private fast = 0;
  private slow = 0;
  private lastAt = -Infinity;
  /** Re-armed only once the sound settles; stops a held vowel re-triggering. */
  private armed = true;
  count = 0;

  constructor(
    private threshold = 0.1,
    private minGapMs = 140,
  ) {}

  /** Feed one loudness value; returns true on an onset. */
  push(level: number, now: number): boolean {
    this.fast = follow(this.fast, level, 0.7, 0.3);
    this.slow = follow(this.slow, level, 0.08, 0.08);
    const rise = this.fast - this.slow;
    if (rise < this.threshold * 0.5) this.armed = true;
    if (this.armed && rise > this.threshold && now - this.lastAt > this.minGapMs) {
      this.armed = false;
      this.lastAt = now;
      this.count += 1;
      return true;
    }
    return false;
  }
}

const range = (data: Uint8Array, [b0, b1]: [number, number]) => {
  let sum = 0;
  for (let b = b0; b <= b1; b++) sum += data[b];
  return sum / ((b1 - b0 + 1) * 255);
};

/** Reads an AnalyserNode into a VoiceFrame + spectrum bins every frame. */
export class VoiceAnalyser {
  readonly frame = emptyFrame();
  private freq: Uint8Array<ArrayBuffer>;
  private wave: Float32Array<ArrayBuffer>;
  private bands: [number, number][];
  private lowBand: [number, number];
  private midBand: [number, number];
  private highBand: [number, number];
  private onset = new OnsetDetector();
  private ranges = [new AutoRange(), new AutoRange(), new AutoRange()];

  constructor(
    readonly node: AnalyserNode,
    /**
     * loudness gain for loudness(). 4 suits Piper speech (measured: median
     * RMS 0.12 → 0.39, p90 0.28 → 0.67); a mic is quieter and needs more.
     */
    private gain = 4,
  ) {
    node.fftSize = 1024;
    node.smoothingTimeConstant = 0.45;
    node.minDecibels = -85;
    node.maxDecibels = -20;
    const sr = node.context.sampleRate;
    this.freq = new Uint8Array(node.frequencyBinCount);
    this.wave = new Float32Array(node.fftSize);
    this.bands = logBands(BINS, 80, 7000, sr, node.fftSize);
    [this.lowBand, this.midBand, this.highBand] = [
      [80, 300],
      [300, 2000],
      [2000, 7000],
    ].map(([a, b]) => logBands(1, a, b, sr, node.fftSize)[0]);
  }

  sample(bins: Float32Array, now: number): VoiceFrame {
    const f = this.frame;
    this.node.getFloatTimeDomainData(this.wave);
    this.node.getByteFrequencyData(this.freq);
    const loud = loudness(rms(this.wave), this.gain);
    f.level = follow(f.level, loud, 0.6, 0.18);
    for (let i = 0; i < bins.length; i++) {
      const v = range(this.freq, this.bands[i]);
      bins[i] = follow(bins[i], v * v * 1.4, 0.7, 0.25); // square: more contrast between peaks
    }
    // Each band relative to its own recent peak, so they move independently:
    // low ≈ voicing, mid ≈ vowels, high ≈ consonants ("s", "t", "k").
    const [low, mid, high] = this.ranges;
    f.low = follow(f.low, low.push(range(this.freq, this.lowBand)), 0.6, 0.2);
    f.mid = follow(f.mid, mid.push(range(this.freq, this.midBand)), 0.6, 0.2);
    f.high = follow(f.high, high.push(range(this.freq, this.highBand)), 0.7, 0.3);
    this.onset.push(loud, now);
    f.onsets = this.onset.count;
    return f;
  }
}
