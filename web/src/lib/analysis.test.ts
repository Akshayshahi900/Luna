import { describe, expect, it } from "vitest";
import { AutoRange, follow, logBands, loudness, OnsetDetector, rms, stretch } from "./analysis";

describe("logBands", () => {
  it("covers the range low-to-high with more bands at low frequencies", () => {
    const bands = logBands(8, 80, 7000, 48000, 1024); // 46.875 Hz per bin
    expect(bands[0][0]).toBe(1);
    expect(bands.at(-1)![1]).toBeLessThanOrEqual(Math.ceil(7000 / 46.875));
    const widths = bands.map(([a, b]) => b - a + 1);
    expect(widths[0]).toBeLessThan(widths.at(-1)!);
    bands.forEach(([a, b]) => expect(b).toBeGreaterThanOrEqual(a));
  });
});

describe("level helpers", () => {
  it("rms of a full-scale square wave is 1", () => {
    expect(rms(new Float32Array([1, -1, 1, -1]))).toBe(1);
  });
  it("loudness rises smoothly and never reaches 1", () => {
    expect(loudness(0, 4)).toBe(0);
    expect(loudness(0.12, 4)).toBeCloseTo(0.38, 2); // Piper's median
    expect(loudness(0.5, 4)).toBeLessThan(0.9);
  });
  it("stretch rescales and clamps", () => {
    expect(stretch(0.3, 0.1, 0.5)).toBeCloseTo(0.5);
    expect(stretch(0, 0.1, 0.5)).toBe(0);
    expect(stretch(1, 0.1, 0.5)).toBe(1);
  });
  it("follow attacks faster than it releases", () => {
    expect(follow(0, 1, 0.6, 0.2)).toBeCloseTo(0.6);
    expect(follow(1, 0, 0.6, 0.2)).toBeCloseTo(0.8);
  });
});

describe("AutoRange", () => {
  it("is relative to the recent peak, whatever the absolute scale", () => {
    for (const scale of [0.2, 0.8]) {
      const r = new AutoRange();
      expect(r.push(scale)).toBe(1); // new peak
      expect(r.push(scale * 0.45)).toBeCloseTo(0, 1); // well below it
      expect(r.push(scale * 0.725)).toBeCloseTo(0.5, 1);
    }
  });
  it("slowly forgets an old peak", () => {
    const r = new AutoRange(0.05, 0.9);
    r.push(1);
    for (let i = 0; i < 20; i++) r.push(0.1);
    expect(r.push(0.15)).toBe(1); // the old peak of 1 has decayed away
  });
});

describe("OnsetDetector", () => {
  it("fires once per syllable burst, not on steady sound", () => {
    const d = new OnsetDetector(0.1, 140);
    let t = 0;
    const feed = (level: number, frames: number) => {
      let hits = 0;
      for (let i = 0; i < frames; i++) hits += d.push(level, (t += 16)) ? 1 : 0;
      return hits;
    };
    expect(feed(0, 20)).toBe(0); // silence
    expect(feed(0.7, 3)).toBe(1); // a syllable starts
    expect(feed(0.7, 40)).toBe(0); // held vowel
    feed(0.05, 20); // gap
    expect(feed(0.6, 3)).toBe(1); // next syllable
    expect(d.count).toBe(2);
  });
});
