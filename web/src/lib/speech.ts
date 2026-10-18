// Voice in (Web Speech recognition) and voice out (Piper audio from the
// server, or speechSynthesis as a fallback). Recognition exists in Chrome /
// Edge / Safari; Firefox has none, so the UI falls back to typing. The text
// helpers at the top are pure and tested.
import { emptyFrame, type VoiceFrame, VoiceAnalyser } from "./analysis";

/** Make markdown-ish model output pleasant to hear. */
export function cleanForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?(```|$)/g, " (code omitted) ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "a link")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/(\*\*|__|\*|_|~~)(?=\S)([\s\S]*?\S)\1/g, "$2")
    .replace(/\|/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Collects streamed tokens and hands back whole sentences, so Luna can
 * start talking before the reply is finished.
 */
export class SentenceChunker {
  private buffer = "";

  /** Next complete sentence: [sentence, chars to drop], or null to wait for more. */
  private nextCut(): [string, number] | null {
    let from = 0;
    for (;;) {
      const re = /[.!?…](\s+)|\n{2,}/g;
      re.lastIndex = from;
      const m = re.exec(this.buffer);
      if (!m) return null;
      const end = m[0].startsWith("\n") ? m.index : m.index + 1;
      const head = this.buffer.slice(0, end);
      if ((head.match(/```/g) ?? []).length % 2 === 0) return [head, m.index + m[0].length];
      // That cut would land inside a code block: look past its closing fence.
      const close = this.buffer.indexOf("```", end);
      if (close === -1) return null;
      from = close + 3;
    }
  }

  push(text: string): string[] {
    this.buffer += text;
    const out: string[] = [];
    for (let cut = this.nextCut(); cut; cut = this.nextCut()) {
      const sentence = cut[0].trim();
      this.buffer = this.buffer.slice(cut[1]);
      if (sentence) out.push(sentence);
    }
    return out;
  }

  flush(): string[] {
    const rest = this.buffer.trim();
    this.buffer = "";
    return rest ? [rest] : [];
  }

  get pending(): boolean {
    return this.buffer.trim().length > 0;
  }
}

// --- Speech synthesis -------------------------------------------------------

const PREFERRED_VOICES = [
  "Google UK English Female",
  "Microsoft Aria",
  "Microsoft Jenny",
  "Microsoft Libby",
  "Samantha",
  "Serena",
  "Karen",
  "Google US English",
];

function pickVoice(): SpeechSynthesisVoice | null {
  if (typeof speechSynthesis === "undefined") return null;
  const voices = speechSynthesis.getVoices().filter((v) => v.lang.startsWith("en"));
  for (const name of PREFERRED_VOICES) {
    const v = voices.find((voice) => voice.name.includes(name));
    if (v) return v;
  }
  return voices.find((v) => /female/i.test(v.name)) ?? voices[0] ?? null;
}

/** Speak one utterance with the browser's voice; resolves when it ends. */
function browserSay(text: string, onWord: () => void): Promise<void> {
  return new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(text);
    const voice = pickVoice();
    if (voice) u.voice = voice;
    u.rate = 1.04;
    u.pitch = 1.05;
    u.onstart = onWord;
    u.onboundary = onWord;
    u.onend = () => resolve();
    u.onerror = () => resolve();
    speechSynthesis.speak(u);
  });
}

interface Queued {
  text: string;
  /** Piper audio, fetched as soon as the sentence is queued; null = use the browser voice */
  audio: Promise<AudioBuffer | null> | null;
}

/**
 * Luna's voice. Two modes:
 *  - "audio": each sentence is synthesized by the server (Piper, /api/tts)
 *    and played through an AnalyserNode, so the core follows the real
 *    sound: loudness, spectrum, syllables.
 *  - "browser": speechSynthesis. It exposes no audio, so sample() fakes an
 *    envelope from word boundaries.
 * Sentences play strictly in order; the next one is fetched while the
 * current one plays, so there's no gap.
 */
export class Speaker {
  enabled = true;
  mode: "audio" | "browser" = "browser";
  ttsUrl = "/api/tts";
  onStart?: () => void;
  onEnd?: () => void;

  private queue: Queued[] = [];
  private playing = false;
  private active = false;
  /** bumped by stop(): anything from an older generation is dropped */
  private gen = 0;
  private failures = 0;
  private ctx: AudioContext | null = null;
  private analyser: VoiceAnalyser | null = null;
  private source: AudioBufferSourceNode | null = null;
  // Fallback envelope for browser speech.
  private fake = emptyFrame();
  private wordAt = 0;
  private browserTalking = false;

  get supported(): boolean {
    return typeof speechSynthesis !== "undefined" || typeof AudioContext !== "undefined";
  }

  get speaking(): boolean {
    return this.playing || this.queue.length > 0;
  }

  /** True while the real-audio path is in use (vs. the browser fallback). */
  get realAudio(): boolean {
    return this.source !== null;
  }

  /** Create/resume the AudioContext. Call from a click or key handler. */
  unlock(): void {
    if (typeof AudioContext === "undefined") return;
    if (!this.ctx) {
      this.ctx = new AudioContext();
      const node = this.ctx.createAnalyser();
      node.connect(this.ctx.destination);
      this.analyser = new VoiceAnalyser(node, 4);
    }
    void this.ctx.resume();
  }

  speak(raw: string): void {
    const text = cleanForSpeech(raw);
    if (!text || !this.enabled) return;
    const useAudio = this.mode === "audio" && this.failures < 3 && typeof AudioContext !== "undefined";
    if (useAudio) this.unlock();
    this.queue.push({ text, audio: useAudio ? this.fetchAudio(text) : null });
    if (!this.active) {
      this.active = true;
      this.onStart?.();
    }
    if (!this.playing) void this.pump();
  }

  stop(): void {
    this.gen += 1;
    this.queue = [];
    try {
      this.source?.stop();
    } catch {
      /* already stopped */
    }
    this.source = null;
    this.playing = false;
    this.browserTalking = false;
    if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
    this.finish();
  }

  /** This frame's voice features: measured from audio, or faked for browser speech. */
  sample(bins: Float32Array, now: number): VoiceFrame {
    if (this.source && this.analyser) return this.analyser.sample(bins, now);
    const f = this.fake;
    if (!this.browserTalking) {
      f.level *= 0.85;
      f.low = f.mid = f.high = f.level;
      return f;
    }
    const sinceWord = (now - this.wordAt) / 1000;
    const syllable = 0.5 + 0.5 * Math.sin(now / 55) * Math.sin(now / 131);
    const target = Math.max(0.15, Math.exp(-sinceWord * 3) * 0.9) * (0.55 + 0.45 * syllable);
    f.level += (target - f.level) * 0.35;
    f.low = f.level;
    f.mid = f.level * 0.8;
    f.high = f.level * (0.3 + 0.3 * Math.abs(Math.sin(now / 37)));
    for (let i = 0; i < bins.length; i++) {
      bins[i] = f.level * (0.45 + 0.55 * Math.abs(Math.sin(i * 0.61 + now / 90) * Math.cos(i * 0.23 - now / 160)));
    }
    return f;
  }

  private async fetchAudio(text: string): Promise<AudioBuffer | null> {
    try {
      const response = await fetch(this.ttsUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!response.ok) throw new Error(`tts ${response.status}`);
      const buffer = await this.ctx!.decodeAudioData(await response.arrayBuffer());
      this.failures = 0;
      return buffer;
    } catch {
      this.failures += 1; // after 3 in a row, stop asking the server
      return null;
    }
  }

  private async pump(): Promise<void> {
    const gen = this.gen;
    this.playing = true;
    while (this.queue.length > 0) {
      const item = this.queue[0];
      const buffer = item.audio ? await item.audio : null;
      if (gen !== this.gen) return; // stop() was called meanwhile
      this.queue.shift();
      if (buffer) await this.play(buffer);
      else if (typeof speechSynthesis !== "undefined") await this.sayInBrowser(item.text);
      if (gen !== this.gen) return;
    }
    this.playing = false;
    this.finish();
  }

  private play(buffer: AudioBuffer): Promise<void> {
    return new Promise((resolve) => {
      const ctx = this.ctx!;
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(this.analyser!.node);
      source.onended = () => {
        if (this.source === source) this.source = null;
        resolve();
      };
      this.source = source;
      source.start();
    });
  }

  private async sayInBrowser(text: string): Promise<void> {
    this.browserTalking = true;
    await browserSay(text, () => (this.wordAt = performance.now()));
    this.browserTalking = false;
  }

  private finish(): void {
    if (this.active && !this.speaking) {
      this.active = false;
      this.onEnd?.();
    }
  }
}

// --- Speech recognition -----------------------------------------------------

// Minimal typing for the (still prefixed) Web Speech recognition API.
interface RecognitionResultEvent {
  resultIndex: number;
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
}
interface Recognition {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: RecognitionResultEvent) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type RecognitionCtor = new () => Recognition;

function recognitionCtor(): RecognitionCtor | null {
  const w = globalThis as unknown as Record<string, RecognitionCtor | undefined>;
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export class Listener {
  onInterim?: (text: string) => void;
  onFinal?: (text: string) => void;
  onEnd?: () => void;
  onError?: (error: string) => void;
  private rec: Recognition | null = null;

  static get supported(): boolean {
    return recognitionCtor() !== null;
  }

  get active(): boolean {
    return this.rec !== null;
  }

  start(lang = navigator.language || "en-US"): void {
    const Ctor = recognitionCtor();
    if (!Ctor || this.rec) return;
    const rec = new Ctor();
    rec.lang = lang;
    rec.interimResults = true;
    rec.continuous = false;
    let finalText = "";
    rec.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += r[0].transcript;
        else interim += r[0].transcript;
      }
      this.onInterim?.((finalText + interim).trim());
    };
    rec.onerror = (e) => {
      if (e.error !== "no-speech" && e.error !== "aborted") this.onError?.(e.error);
    };
    rec.onend = () => {
      this.rec = null;
      const text = finalText.trim();
      if (text) this.onFinal?.(text);
      this.onEnd?.();
    };
    this.rec = rec;
    try {
      rec.start();
    } catch {
      this.rec = null;
    }
  }

  /** Stop listening; whatever was heard so far is still delivered. */
  stop(): void {
    this.rec?.stop();
  }

  /** Stop and throw away what was heard. */
  abort(): void {
    const rec = this.rec;
    if (!rec) return;
    rec.onresult = null;
    rec.abort();
  }
}
