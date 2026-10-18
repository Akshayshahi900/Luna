import { describe, expect, it } from "vitest";
import { downsample, encodeWav, Segmenter } from "./vad";

const RATE = 48000;
const FRAME = 1024; // ≈ 21.3 ms
const tone = (amp: number) => Float32Array.from({ length: FRAME }, (_, i) => amp * Math.sin(i / 3));
const noise = (amp: number) => Float32Array.from({ length: FRAME }, () => (Math.random() * 2 - 1) * amp);

function feed(seg: Segmenter, frames: Float32Array[]) {
  return frames.map((f) => seg.push(f)).filter(Boolean);
}
const repeat = (n: number, make: () => Float32Array) => Array.from({ length: n }, make);

describe("Segmenter", () => {
  it("finds one utterance between quiet stretches", () => {
    const seg = new Segmenter(RATE, FRAME);
    expect(feed(seg, repeat(50, () => noise(0.002)))).toEqual([]); // room noise
    const events = feed(seg, [...repeat(40, () => tone(0.2)), ...repeat(45, () => noise(0.002))]);
    expect(events).toEqual(["start", "end"]);
    const audio = seg.take();
    // pre-roll (~500 ms) + speech (~850 ms) + kept tail (~200 ms)
    expect(audio.length / RATE).toBeGreaterThan(1.3);
    expect(audio.length / RATE).toBeLessThan(1.8);
    expect(seg.take().length).toBe(0); // taken once
  });

  it("ignores clicks and drops too-short sounds", () => {
    const seg = new Segmenter(RATE, FRAME);
    feed(seg, repeat(30, () => noise(0.002)));
    expect(feed(seg, [tone(0.3), ...repeat(20, () => noise(0.002))])).toEqual([]); // one-frame click
    expect(feed(seg, [...repeat(5, () => tone(0.3)), ...repeat(45, () => noise(0.002))])).toEqual(["start", "discard"]);
  });

  it("adapts to a noisier room", () => {
    const seg = new Segmenter(RATE, FRAME);
    // Steady fan noise well above the starting floor should not count as speech forever.
    const events = feed(seg, repeat(600, () => noise(0.01)));
    expect(events.filter((e) => e === "start").length).toBeLessThanOrEqual(1);
    expect(feed(seg, repeat(10, () => noise(0.01)))).toEqual([]);
  });

  it("flush ends an utterance early; max length cuts long ones", () => {
    const seg = new Segmenter(RATE, FRAME, { maxMs: 1000 });
    feed(seg, repeat(20, () => noise(0.002)));
    // Cut at 1 s; the talking that continues becomes the next utterance.
    expect(feed(seg, repeat(60, () => tone(0.2)))).toEqual(["start", "end", "start"]);
    expect(seg.take().length / RATE).toBeCloseTo(1, 0);
    expect(seg.flush()).toBe("end");
    expect(seg.flush()).toBeNull();
  });

  it("is harder to trigger with higher sensitivity", () => {
    const seg = new Segmenter(RATE, FRAME);
    feed(seg, repeat(30, () => noise(0.002)));
    seg.sensitivity = 20;
    expect(feed(seg, repeat(20, () => tone(0.05)))).toEqual([]);
  });
});

describe("downsample + encodeWav", () => {
  it("resamples 48 kHz to 16 kHz", () => {
    const out = downsample(new Float32Array(48000).fill(0.5), 48000, 16000);
    expect(out.length).toBe(16000);
    expect(out[100]).toBeCloseTo(0.5);
  });

  it("writes a valid 16 kHz mono 16-bit WAV header", () => {
    const buf = encodeWav(new Float32Array([0, 1, -1]), 16000);
    const v = new DataView(buf);
    const tag = (at: number) => String.fromCharCode(...new Uint8Array(buf, at, 4));
    expect([tag(0), tag(8), tag(12), tag(36)]).toEqual(["RIFF", "WAVE", "fmt ", "data"]);
    expect(v.getUint16(22, true)).toBe(1);
    expect(v.getUint32(24, true)).toBe(16000);
    expect(v.getUint16(34, true)).toBe(16);
    expect(v.getUint32(40, true)).toBe(6);
    expect([v.getInt16(44, true), v.getInt16(46, true), v.getInt16(48, true)]).toEqual([0, 32767, -32768]);
  });
});
