/**
 * Download a model file once (Whisper models, Piper voices).
 *
 * Written to "<file>.part" and renamed when complete, so an interrupted
 * download is never mistaken for a model.
 */

import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export async function downloadOnce(url: string, file: string): Promise<string> {
  if (existsSync(file)) return file;
  mkdirSync(path.dirname(file), { recursive: true });
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}) for ${url}`);
  const part = `${file}.part`;
  try {
    await pipeline(Readable.fromWeb(response.body as never), createWriteStream(part));
    renameSync(part, file);
  } catch (error) {
    rmSync(part, { force: true });
    throw error;
  }
  return file;
}
