// The microphone, for local speech recognition: an AudioWorklet streams
// frames into the Segmenter (vad.ts); each finished utterance is resampled
// to 16 kHz WAV and handed to onUtterance. The same stream feeds a
// VoiceAnalyser so the core reacts while you talk.
import { VoiceAnalyser } from "./analysis";
import { live, setLive } from "./audio";
import { downsample, encodeWav, Segmenter } from "./vad";

export class VoiceInput {
  onSpeechStart?: () => void;
  /** the utterance ended and is about to be transcribed */
  onUtterance?: (wav: Blob) => void;
  onError?: (message: string) => void;

  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private worklet: AudioWorkletNode | null = null;
  private analyser: VoiceAnalyser | null = null;
  private segmenter: Segmenter | null = null;
  private starting: Promise<boolean> | null = null;

  get open(): boolean {
    return this.worklet !== null;
  }

  /** Someone is talking right now (an utterance is being recorded). */
  get inSpeech(): boolean {
    return this.segmenter?.active ?? false;
  }

  /** Raise the speech threshold, e.g. while Luna's own voice is playing. */
  set sensitivity(value: number) {
    if (this.segmenter) this.segmenter.sensitivity = value;
  }

  start(): Promise<boolean> {
    if (this.open) return Promise.resolve(true);
    this.starting ??= this.open_().finally(() => (this.starting = null));
    return this.starting;
  }

  private async open_(): Promise<boolean> {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        // Echo cancellation keeps Luna's own voice (played by this page) out of
        // the mic. Noise suppression and auto gain stay off: in testing they
        // swallowed the start of an utterance (the "Hey Luna" part), and
        // Whisper handles noise and volume well by itself.
        audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
      });
      this.ctx = new AudioContext();
      await this.ctx.audioWorklet.addModule("/mic-worklet.js");
    } catch (exc) {
      this.stop();
      this.onError?.((exc as Error).name === "NotAllowedError" ? "not-allowed" : String(exc));
      return false;
    }
    const source = this.ctx.createMediaStreamSource(this.stream);
    const node = this.ctx.createAnalyser();
    source.connect(node);
    this.analyser = new VoiceAnalyser(node, 10);
    this.segmenter = new Segmenter(this.ctx.sampleRate, 1024);
    this.worklet = new AudioWorkletNode(this.ctx, "luna-capture");
    this.worklet.port.onmessage = (e: MessageEvent<Float32Array>) => this.onFrame(e.data);
    source.connect(this.worklet);
    // A worklet only runs when connected to the output; a muted gain keeps it silent.
    const mute = this.ctx.createGain();
    mute.gain.value = 0;
    this.worklet.connect(mute).connect(this.ctx.destination);
    return true;
  }

  private onFrame(frame: Float32Array): void {
    const seg = this.segmenter!;
    const event = seg.push(frame);
    if (event === "start") this.onSpeechStart?.();
    if (event === "end") this.emit(seg.take());
  }

  private emit(samples: Float32Array): void {
    const pcm = downsample(samples, this.ctx!.sampleRate, 16000);
    this.onUtterance?.(new Blob([encodeWav(pcm, 16000)], { type: "audio/wav" }));
  }

  /** End the utterance being recorded now (push-to-talk released). */
  flush(): void {
    if (this.segmenter?.flush() === "end") this.emit(this.segmenter.take());
  }

  /** Drop whatever is being recorded. */
  discard(): void {
    this.segmenter?.reset();
  }

  /** Write the mic's current frame into `live` for the core. */
  sample(now: number): void {
    if (this.analyser) setLive(this.analyser.sample(live.bins, now));
  }

  stop(): void {
    this.worklet?.port.close();
    this.worklet?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close();
    this.worklet = null;
    this.analyser = null;
    this.segmenter = null;
    this.stream = null;
    this.ctx = null;
  }
}

/** Send one utterance to the local Whisper endpoint; returns its text ("" if none). */
export async function transcribe(wav: Blob, url = "/api/stt"): Promise<string> {
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "audio/wav" }, body: wav });
  if (!response.ok) throw new Error(`stt ${response.status}`);
  const data = (await response.json()) as { text?: string };
  return (data.text ?? "").trim();
}
