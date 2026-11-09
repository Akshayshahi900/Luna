/**
 * Read and edit the project's `.env` file in place (used by the Control Center).
 *
 * BEGINNER MAP
 * ------------
 * Settings (settings.ts) only READS `.env`. The Control Center in the web UI
 * also needs to WRITE it, without wrecking the file you edit by hand:
 *
 *   readEnv(path)              → {"LUNA_UNITS": "metric", ...}
 *   updateEnv(path, changes)   → set keys, or remove them with null
 *
 * updateEnv keeps every comment (also a "# note" after a value), blank
 * line and the order of the keys: it only rewrites the lines of the keys it
 * changes and adds new keys at the end. The new file is written next to the
 * old one and renamed over it, so a crash never leaves half a file. A new
 * `.env` is created readable by you only (it holds API keys).
 *
 * Values with newlines are refused: one would turn into a second key.
 *
 * Read next: config/schema.ts (what the UI shows for each setting).
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

// KEY=value, optionally with "export " in front (both are valid .env lines).
const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;
const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Unquoted values may hold these; anything else gets double quotes.
const PLAIN = /^[A-Za-z0-9_./:@,+\-~%]*$/;

/** A change updateEnv refuses (bad key, newline in a value, ...). */
export class EnvFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvFileError";
  }
}

/** The value part of one line, without quotes or a trailing comment. */
export function parseValue(raw: string): string {
  raw = raw.trim();
  if (raw.length >= 2 && raw[0] === raw.at(-1) && (raw[0] === '"' || raw[0] === "'")) {
    let inner = raw.slice(1, -1);
    if (raw[0] === '"') inner = inner.replaceAll('\\"', '"').replaceAll("\\\\", "\\");
    return inner;
  }
  // A quoted value followed by a comment: "abc" # note
  if (raw[0] === '"' || raw[0] === "'") {
    const end = raw.indexOf(raw[0], 1);
    if (end > 0) return parseValue(raw.slice(0, end + 1));
  }
  // Unquoted: " #" starts a comment.
  const hashAt = raw.indexOf(" #");
  return (hashAt >= 0 ? raw.slice(0, hashAt) : raw).trim();
}

/** The " # note" after a value (with its spacing), or "" if there is none. */
export function trailingComment(raw: string): string {
  const stripped = raw.trim();
  if (stripped[0] === '"' || stripped[0] === "'") {
    const end = stripped.indexOf(stripped[0], 1);
    const rest = end > 0 ? stripped.slice(end + 1) : "";
    const at = rest.indexOf("#");
    return at >= 0 ? "  " + rest.slice(at) : "";
  }
  const at = raw.indexOf(" #");
  if (at < 0) return "";
  const valueEnd = raw.slice(0, at).trimEnd().length;
  return raw.slice(valueEnd);
}

/** How a value is written: bare when safe, otherwise double-quoted. */
export function formatValue(value: string): string {
  if (PLAIN.test(value)) return value;
  return '"' + value.replaceAll("\\", "\\\\").replaceAll('"', '\\"') + '"';
}

function splitLines(text: string): string[] {
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/** Every KEY=value in the file (the last one wins). {} if it doesn't exist. */
export function readEnv(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  const values: Record<string, string> = {};
  for (const line of splitLines(readFileSync(file, "utf8"))) {
    if (line.trimStart().startsWith("#")) continue;
    const match = LINE.exec(line);
    if (match) values[match[1]] = parseValue(match[2]);
  }
  return values;
}

function check(changes: Record<string, string | null>): void {
  for (const [key, value] of Object.entries(changes)) {
    if (!KEY.test(key)) throw new EnvFileError(`Invalid key: '${key}'`);
    if (value !== null && /[\r\n\0]/.test(value)) throw new EnvFileError(`${key}: values must be on one line`);
  }
}

/**
 * Set (string) or remove (null) keys, keeping everything else as it was.
 *
 * A key that appears twice is set on its first line and the later
 * duplicates are dropped, so the file can't contradict itself.
 */
export function updateEnv(file: string, changes: Record<string, string | null>): void {
  check(changes);
  const lines = existsSync(file) ? splitLines(readFileSync(file, "utf8")) : [];
  const pending = new Map(Object.entries(changes));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const match = line.trimStart().startsWith("#") ? null : LINE.exec(line);
    const key = match ? match[1] : null;
    if (key === null || !Object.hasOwn(changes, key)) {
      out.push(line);
      continue;
    }
    if (seen.has(key)) continue; // a duplicate of a key we already wrote
    seen.add(key);
    const value = pending.get(key)!;
    pending.delete(key);
    if (value !== null) out.push(`${key}=${formatValue(value)}${trailingComment(match![2])}`);
  }
  for (const [key, value] of pending) {
    if (value !== null) out.push(`${key}=${formatValue(value)}`);
  }

  const text = out.join("\n") + (out.length ? "\n" : "");
  const mode = existsSync(file) ? statSync(file).mode & 0o777 : 0o600;
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  writeFileSync(tmp, text, "utf8");
  chmodSync(tmp, mode);
  renameSync(tmp, file);
}
