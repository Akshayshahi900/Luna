/**
 * Tiny WAV helpers: read the browser's 16 kHz utterances, wrap raw PCM.
 *
 * Only the plain PCM form is handled (RIFF / WAVE / "fmt " / "data"), which
 * is what the browser (web/src/lib/voiceInput.ts) and Piper produce.
 */

export const SAMPLE_RATE = 16_000;
// Longer than any spoken command; stops huge uploads.
export const MAX_SECONDS = 30;

export interface WavInfo {
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  /** The PCM bytes (little-endian). */
  data: Buffer;
}

/** Parse a PCM WAV file. Throws on anything else. */
export function readWav(buffer: Buffer): WavInfo {
  if (buffer.length < 12 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("not a WAV file (no RIFF/WAVE header)");
  }
  let offset = 12;
  let fmt: Omit<WavInfo, "data"> | null = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      if (buffer.readUInt16LE(body) !== 1) throw new Error("not a WAV file (only PCM is supported)");
      fmt = { channels: buffer.readUInt16LE(body + 2), sampleRate: buffer.readUInt32LE(body + 4), bitsPerSample: buffer.readUInt16LE(body + 14) };
    } else if (id === "data") {
      if (!fmt) throw new Error("not a WAV file (data before fmt)");
      return { ...fmt, data: buffer.subarray(body, Math.min(body + size, buffer.length)) };
    }
    offset = body + size + (size % 2);
  }
  throw new Error("not a WAV file (no data chunk)");
}

/** 16 kHz mono 16-bit WAV → its PCM bytes and sample count. Throws with a short reason. */
export function wavToPcm(buffer: Buffer): { pcm: Buffer; samples: number } {
  const wav = readWav(buffer);
  if (wav.channels !== 1 || wav.bitsPerSample !== 16 || wav.sampleRate !== SAMPLE_RATE) {
    throw new Error("audio must be 16 kHz mono 16-bit WAV");
  }
  const samples = Math.floor(wav.data.length / 2);
  if (samples > SAMPLE_RATE * MAX_SECONDS) throw new Error(`audio longer than ${MAX_SECONDS} s`);
  return { pcm: wav.data.subarray(0, samples * 2), samples };
}

/** 16-bit PCM samples → float32 in -1..1 (what Whisper models take). */
export function pcmToFloat(pcm: Buffer): Float32Array {
  const out = new Float32Array(Math.floor(pcm.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = pcm.readInt16LE(i * 2) / 32768;
  return out;
}

/** Wrap raw 16-bit mono PCM in a WAV header. */
export function pcmToWav(pcm: Buffer, sampleRate: number, channels = 1): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
