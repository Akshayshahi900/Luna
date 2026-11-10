// Voice engines: the pieces of Piper's pipeline (clauses, phoneme ids,
// normalisation) and Whisper's silence gate, offline. The real round trip
// (Piper voice → WAV → Whisper) needs the models on disk and espeak-ng, so
// it only runs with LUNA_VOICE_TESTS=1.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { expect, test } from "vitest";

import { loadSettings } from "../src/config/settings.ts";
import { cleanTranscript, createStt, hasSound, modelId } from "../src/voice/stt.ts";
import { clauses, createTts, floatToPcm, phonemeIds, voiceUrl } from "../src/voice/tts.ts";
import { pcmToFloat, readWav, wavToPcm } from "../src/voice/wav.ts";
import { tmpDir } from "./helpers.ts";

test("clauses keep their punctuation", () => {
  expect(clauses("It's 33 degrees, Sir, with rain!")).toEqual([["It's 33 degrees", ","], ["Sir", ","], ["with rain", "!"]]);
  expect(clauses("no punctuation")).toEqual([["no punctuation", ""]]);
  expect(clauses("Wait... what?!")).toEqual([["Wait", "."], ["what", "!"]]);
  expect(clauses("  ")).toEqual([]);
});

test("phoneme ids follow Piper's rule: ^, phoneme + pad, $", () => {
  const map = { "^": [1], $: [2], _: [0], a: [14], b: [15], ".": [10] };
  expect(phonemeIds("ab.", map)).toEqual([1, 14, 0, 15, 0, 10, 0, 2]);
  expect(phonemeIds("aX", map)).toEqual([1, 14, 0, 2]); // unknown phonemes are skipped
});

test("audio is normalised to full 16-bit range", () => {
  const pcm = floatToPcm(Float32Array.from([0.25, -0.5, 0]));
  expect([pcm.readInt16LE(0), pcm.readInt16LE(2), pcm.readInt16LE(4)]).toEqual([16384, -32767, 0]);
});

test("voice URLs and Whisper model ids", () => {
  expect(voiceUrl("en_US-lessac-medium")).toBe("https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx");
  expect(() => voiceUrl("lessac")).toThrow(/Not a Piper voice/);
  expect(modelId("base.en")).toBe("onnx-community/whisper-base.en");
  expect(modelId("me/my-whisper")).toBe("me/my-whisper");
});

test("silence never reaches Whisper; its notes are removed", () => {
  expect(hasSound(new Float32Array(16000))).toBe(false);
  const tone = Float32Array.from({ length: 16000 }, (_, i) => Math.sin(i / 5) * 0.1);
  expect(hasSound(tone)).toBe(true);
  expect(cleanTranscript(" [BLANK_AUDIO] Hey  Luna (music) ")).toBe("Hey Luna");
});

const voice = process.env.LUNA_VOICE_TESTS === "1";

test.skipIf(!voice)("real round trip: Luna's voice is understood by Whisper", async () => {
  const settings = loadSettings({ envFile: null, env: {} });
  const wav = await createTts(settings)!.synthesize("It's 33 degrees, Sir.");
  expect(readWav(wav).sampleRate).toBe(22050);
  const dir = tmpDir();
  writeFileSync(path.join(dir, "luna.wav"), wav);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", path.join(dir, "luna.wav"), "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", path.join(dir, "16.wav")]);
  const { pcm, samples } = wavToPcm(readFileSync(path.join(dir, "16.wav")));
  expect(hasSound(pcmToFloat(pcm))).toBe(true);
  const stt = createStt(settings)!;
  expect((await stt.transcribe(pcm, samples)).toLowerCase()).toContain("33 degrees");
  await stt.close();
}, 300_000);
