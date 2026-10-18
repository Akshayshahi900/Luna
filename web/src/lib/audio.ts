// Shared live values for the 3D scene, the microphone meter, and small
// synthesized UI sounds. Voice analysis itself lives in analysis.ts.
import { BINS, emptyFrame, type VoiceFrame, VoiceAnalyser } from "./analysis";

export { BINS };

/**
 * Values the 3D scene reads every frame. Kept outside React state on
 * purpose: updating them 60×/s must not re-render the component tree.
 * Filled from the mic while listening and from Luna's voice while speaking.
 */
export const live: VoiceFrame & { bins: Float32Array; pointer: { x: number; y: number } } = {
  ...emptyFrame(),
  bins: new Float32Array(BINS),
  pointer: { x: 0, y: 0 },
};

/** Copy a frame into `live` (bins are written in place by the analyser). */
export function setLive(frame: VoiceFrame): void {
  live.level = frame.level;
  live.low = frame.low;
  live.mid = frame.mid;
  live.high = frame.high;
  live.onsets = frame.onsets;
}

/** Let everything fall back to rest when nobody is talking. */
export function decayLive(): void {
  live.level *= 0.9;
  live.low *= 0.9;
  live.mid *= 0.9;
  live.high *= 0.85;
  for (let i = 0; i < BINS; i++) live.bins[i] *= 0.88;
}

export class MicMeter {
  private ctx: AudioContext | null = null;
  private analyser: VoiceAnalyser | null = null;
  private stream: MediaStream | null = null;

  get running(): boolean {
    return this.analyser !== null;
  }

  async start(): Promise<boolean> {
    if (this.analyser) return true;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
    } catch {
      return false;
    }
    this.ctx = new AudioContext();
    const node = this.ctx.createAnalyser();
    this.ctx.createMediaStreamSource(this.stream).connect(node);
    this.analyser = new VoiceAnalyser(node, 10); // a mic is much quieter than synthesized speech
    return true;
  }

  /** Write the mic's current frame into `live`. */
  sample(now: number): void {
    if (this.analyser) setLive(this.analyser.sample(live.bins, now));
  }

  stop(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close();
    this.ctx = null;
    this.analyser = null;
    this.stream = null;
  }
}

// --- UI sounds ---------------------------------------------------------------

let sfxCtx: AudioContext | null = null;
export const sfx = { muted: false };

function tone(freq: number, start: number, dur: number, gain = 0.05, type: OscillatorType = "sine") {
  if (sfx.muted) return;
  sfxCtx ??= new AudioContext();
  const ctx = sfxCtx;
  const t = ctx.currentTime + start;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

export const sounds = {
  boot() {
    [220, 330, 440, 660].forEach((f, i) => tone(f, i * 0.09, 0.35, 0.04, "triangle"));
    tone(880, 0.42, 0.9, 0.03);
  },
  listen() {
    tone(660, 0, 0.12, 0.05);
    tone(990, 0.07, 0.16, 0.04);
  },
  stopListen() {
    tone(880, 0, 0.1, 0.04);
    tone(520, 0.06, 0.14, 0.035);
  },
  send() {
    tone(740, 0, 0.08, 0.03, "triangle");
  },
  alert() {
    [0, 0.18].forEach((s) => tone(523, s, 0.14, 0.05, "square"));
  },
  done() {
    tone(1046, 0, 0.18, 0.025);
  },
  error() {
    tone(196, 0, 0.3, 0.05, "sawtooth");
  },
};
