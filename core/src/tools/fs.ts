/**
 * File tools, locked to a set of workspace folders.
 *
 * BEGINNER MAP
 * ------------
 * makeFsTools(roots) builds five tools that can ONLY touch files inside
 * `roots` (LUNA_WORKSPACE_DIRS):
 *
 *   list_dir      what's in a folder
 *   read_file     a file's lines (numbered, in pages)
 *   search_files  regex search across files
 *   write_file    create / overwrite a file      ← asks for approval
 *   edit_file     replace one exact snippet       ← asks for approval
 *
 * Approval is not done here: the subagents that use these tools list
 * write_file / edit_file in `interruptOn` (see agent/subagents/).
 *
 * Every path is resolved (`..` and symlinks included) and refused if it
 * lands outside the roots. Problems come back as "Error: ..." text, so the
 * model can correct itself instead of the run crashing.
 */

import { existsSync, mkdirSync, openSync, readFileSync, readSync, closeSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { tool } from "@langchain/core/tools";
import * as z from "zod";

import type { AnyTool } from "./registry.ts";

// Folders that are almost never what the user means and are huge.
const SKIP_DIRS = new Set([".git", ".venv", "venv", "node_modules", "__pycache__", ".mypy_cache", ".pytest_cache"]);
const MAX_LIST = 200;
const MAX_MATCHES = 100;
const MAX_READ_LINES = 400;
const MAX_FILE_BYTES = 2_000_000; // don't read or search files bigger than this

/** A path outside the workspace, or another refused file operation. */
export class SandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxError";
  }
}

/** Like Python's Path.resolve(): follow symlinks as far as the path exists. */
export function resolveLoose(target: string): string {
  let current = path.resolve(target);
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(realpathSync(current), ...rest);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.join(current, ...rest);
      rest.unshift(path.basename(current));
      current = parent;
    }
  }
}

function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") ? path.join(homedir(), p.slice(1)) : p;
}

function isInside(child: string, root: string): boolean {
  const rel = path.relative(root, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** The folders file tools may use. Relative paths start at the first root. */
export class Workspace {
  readonly roots: string[];

  constructor(roots: string[]) {
    if (!roots.length) throw new Error("At least one workspace folder is required");
    this.roots = roots.map((r) => resolveLoose(expandHome(r)));
  }

  /** Absolute, symlink-free path, or SandboxError if outside every root. */
  resolve(p: string): string {
    let candidate = expandHome(p);
    if (!path.isAbsolute(candidate)) candidate = path.join(this.roots[0], candidate);
    const resolved = resolveLoose(candidate);
    if (!this.roots.some((root) => isInside(resolved, root))) {
      throw new SandboxError(`'${p}' is outside the workspace (${this.roots.join(", ")})`);
    }
    return resolved;
  }

  /** Path relative to the first root when possible (shorter for the model). */
  display(p: string): string {
    return isInside(p, this.roots[0]) ? path.relative(this.roots[0], p) || "." : p;
  }
}

function isText(file: string): boolean {
  try {
    const fd = openSync(file, "r");
    try {
      const buffer = Buffer.alloc(4096);
      const n = readSync(fd, buffer, 0, 4096, 0);
      return !buffer.subarray(0, n).includes(0);
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}

/** Python's str.splitlines() for the usual line endings. */
export function splitLines(text: string): string[] {
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function errorText(error: unknown): string {
  if (error instanceof SandboxError) return `Error: ${error.message}`;
  const e = error as NodeJS.ErrnoException;
  return `Error: ${e?.code ? `[${e.code}] ` : ""}${e?.message ?? String(error)}`;
}

/** fnmatch-style glob → RegExp (`*`, `?`, `[abc]`). */
export function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") out += glob[i + 1] === "*" ? ((i += 1), ".*") : "[^/]*";
    else if (c === "?") out += "[^/]";
    else if (c === "[") {
      const end = glob.indexOf("]", i + 1);
      if (end < 0) out += "\\[";
      else {
        let body = glob.slice(i + 1, end);
        if (body.startsWith("!")) body = "^" + body.slice(1);
        out += `[${body.replaceAll("\\", "\\\\")}]`;
        i = end;
      }
    } else out += c.replace(/[.+^${}()|\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

/** Every path under `folder` (not following symlinked folders), sorted like Python's sorted(rglob). */
function walk(folder: string): string[][] {
  const found: string[][] = [];
  const visit = (dir: string, parts: string[]) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = [...parts, entry.name];
      found.push(rel);
      if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) visit(path.join(dir, entry.name), rel);
    }
  };
  visit(folder, []);
  return found.sort((a, b) => {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    }
    return a.length - b.length;
  });
}

/** Build the file tools for these workspace folders. */
export function makeFsTools(roots: string[]): AnyTool[] {
  const ws = new Workspace(roots);

  const listDir = tool(
    async ({ path: p = "." }) => {
      let entries: { name: string; dir: boolean }[];
      try {
        const folder = ws.resolve(p);
        if (!isDir(folder)) return `Error: '${p}' is not a folder`;
        entries = readdirSync(folder).map((name) => ({ name, dir: isDir(path.join(folder, name)) }));
      } catch (error) {
        return errorText(error);
      }
      entries.sort((a, b) => {
        if (a.dir !== b.dir) return a.dir ? -1 : 1;
        const x = a.name.toLowerCase();
        const y = b.name.toLowerCase();
        return x < y ? -1 : x > y ? 1 : 0;
      });
      const lines = entries.slice(0, MAX_LIST).map((e) => (e.dir ? `${e.name}/` : e.name));
      if (entries.length > MAX_LIST) lines.push(`…and ${entries.length - MAX_LIST} more`);
      return lines.join("\n") || "(empty folder)";
    },
    {
      name: "list_dir",
      description: "List files and folders (folders end with '/').",
      schema: z.object({
        path: z.string().default(".").describe("Folder to list, relative to the workspace. Defaults to its top."),
      }),
    },
  );

  const readFile = tool(
    async ({ path: p, start_line = 1, max_lines = MAX_READ_LINES }) => {
      let lines: string[];
      try {
        const file = ws.resolve(p);
        if (!isFile(file)) return `Error: '${p}' is not a file`;
        if (statSync(file).size > MAX_FILE_BYTES || !isText(file)) return `Error: '${p}' is too large or not a text file`;
        lines = splitLines(readFileSync(file, "utf8"));
      } catch (error) {
        return errorText(error);
      }
      const start = Math.max(start_line, 1);
      const count = Math.min(Math.max(max_lines, 1), MAX_READ_LINES);
      const chunk = lines.slice(start - 1, start - 1 + count);
      let body = chunk.map((text, i) => `${String(start + i).padStart(5)}  ${text}`).join("\n");
      const end = start + chunk.length - 1;
      if (end < lines.length) body += `\n…lines ${start}-${end} of ${lines.length}; use start_line=${end + 1} for more`;
      return body || "(empty file)";
    },
    {
      name: "read_file",
      description: "Read a text file. Lines are numbered; long files come in pages.",
      schema: z.object({
        path: z.string().describe("File to read, relative to the workspace."),
        start_line: z.number().int().default(1).describe("First line to show (1-based)."),
        max_lines: z.number().int().default(MAX_READ_LINES).describe("How many lines to show (at most 400)."),
      }),
    },
  );

  const searchFiles = tool(
    async ({ pattern, path: p = ".", glob = "*" }) => {
      let regex: RegExp;
      let folder: string;
      try {
        regex = new RegExp(pattern);
      } catch (error) {
        return `Error: invalid pattern (${(error as Error).message})`;
      }
      try {
        folder = ws.resolve(p);
      } catch (error) {
        return errorText(error);
      }
      const nameMatch = globToRegExp(glob);
      const matches: string[] = [];
      for (const parts of walk(folder)) {
        if (matches.length >= MAX_MATCHES) break;
        const rel = parts.join("/");
        if (!(glob.includes("/") ? nameMatch.test(rel) : nameMatch.test(parts.at(-1)!))) continue;
        if (parts.some((part) => SKIP_DIRS.has(part))) continue;
        const file = path.join(folder, ...parts);
        if (!isFile(file) || statSync(file).size > MAX_FILE_BYTES || !isText(file)) continue;
        let text: string;
        try {
          ws.resolve(file); // symlinks pointing outside are skipped
          text = readFileSync(file, "utf8");
        } catch {
          continue;
        }
        const lines = splitLines(text);
        for (let n = 0; n < lines.length; n++) {
          if (regex.test(lines[n])) {
            matches.push(`${ws.display(file)}:${n + 1}: ${lines[n].trim().slice(0, 200)}`);
            if (matches.length >= MAX_MATCHES) break;
          }
        }
      }
      if (!matches.length) return "No matches.";
      const suffix = matches.length >= MAX_MATCHES ? `\n…stopped at ${MAX_MATCHES} matches` : "";
      return matches.join("\n") + suffix;
    },
    {
      name: "search_files",
      description: "Search text files for a regular expression; returns 'file:line: text'.",
      schema: z.object({
        pattern: z.string().describe("JavaScript regular expression, e.g. 'function main' or 'TODO|FIXME'."),
        path: z.string().default(".").describe("Folder to search in, relative to the workspace."),
        glob: z.string().default("*").describe("Only files whose name matches, e.g. '*.ts' or '*.md'."),
      }),
    },
  );

  const writeFile = tool(
    async ({ path: p, content }) => {
      let file: string;
      let existed: boolean;
      try {
        file = ws.resolve(p);
        existed = existsSync(file);
        if (isDir(file)) return `Error: '${p}' is a folder`;
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, content, "utf8");
      } catch (error) {
        return errorText(error);
      }
      return `${existed ? "Overwrote" : "Created"} ${ws.display(file)} (${[...content].length} characters)`;
    },
    {
      name: "write_file",
      description: "Create a file, or replace its whole content. Creates missing folders.",
      schema: z.object({
        path: z.string().describe("File to write, relative to the workspace."),
        content: z.string().describe("The complete new file content."),
      }),
    },
  );

  const editFile = tool(
    async ({ path: p, old_text, new_text }) => {
      let file: string;
      let text: string;
      try {
        file = ws.resolve(p);
        if (!isFile(file)) return `Error: '${p}' is not a file`;
        text = readFileSync(file, "utf8");
      } catch (error) {
        return errorText(error);
      }
      const count = old_text ? text.split(old_text).length - 1 : 0;
      if (count !== 1) {
        const found = count === 0 ? "not found" : `found ${count} times`;
        return `Error: old_text ${found}; it must appear exactly once`;
      }
      const at = text.indexOf(old_text);
      writeFileSync(file, text.slice(0, at) + new_text + text.slice(at + old_text.length), "utf8");
      return `Edited ${ws.display(file)}`;
    },
    {
      name: "edit_file",
      description: "Replace one exact snippet in a file. Read the file first.",
      schema: z.object({
        path: z.string().describe("File to edit, relative to the workspace."),
        old_text: z.string().describe("Text to replace; must appear exactly once in the file."),
        new_text: z.string().describe("Replacement text."),
      }),
    },
  );

  return [listDir, readFile, searchFiles, writeFile, editFile] as unknown as AnyTool[];
}
