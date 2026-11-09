import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import { beforeEach, expect, test } from "vitest";

import { capOutput } from "../src/tools/limits.ts";
import { makeFsTools, SandboxError, Workspace } from "../src/tools/fs.ts";
import type { AnyTool } from "../src/tools/registry.ts";
import { tmpDir } from "./helpers.ts";

let root: string;
let tools: Record<string, AnyTool>;
const run = async (name: string, args: Record<string, unknown> = {}) => (await tools[name].invoke(args)) as string;

beforeEach(() => {
  root = tmpDir();
  mkdirSync(path.join(root, "notes"));
  writeFileSync(path.join(root, "notes", "todo.md"), "buy milk\ncall mum\nTODO: taxes\n");
  writeFileSync(path.join(root, "app.py"), "def main():\n    return 1\n");
  mkdirSync(path.join(root, ".git"));
  writeFileSync(path.join(root, ".git", "config"), "TODO: ignored\n");
  tools = Object.fromEntries(makeFsTools([root]).map((t) => [t.name, t]));
});

test("list_dir", async () => {
  expect((await run("list_dir")).split("\n")).toEqual([".git/", "notes/", "app.py"]);
  expect(await run("list_dir", { path: "notes" })).toBe("todo.md");
});

test("read_file numbers and pages", async () => {
  const out = await run("read_file", { path: "notes/todo.md", max_lines: 2 });
  expect(out).toContain("    1  buy milk");
  expect(out).toContain("    2  call mum");
  expect(out).toContain("use start_line=3");
  expect(await run("read_file", { path: "notes/todo.md", start_line: 3 })).toContain("taxes");
});

test("search skips VCS folders", async () => {
  expect(await run("search_files", { pattern: "TODO" })).toBe("notes/todo.md:3: TODO: taxes");
  expect(await run("search_files", { pattern: "def", glob: "*.md" })).toBe("No matches.");
  expect(await run("search_files", { pattern: "(" })).toMatch(/^Error: invalid pattern/);
});

test("write and edit", async () => {
  expect(await run("write_file", { path: "new/a.txt", content: "one two" })).toMatch(/^Created/);
  expect(await run("edit_file", { path: "new/a.txt", old_text: "two", new_text: "2" })).toBe("Edited new/a.txt");
  expect(readFileSync(path.join(root, "new", "a.txt"), "utf8")).toBe("one 2");
  expect(await run("edit_file", { path: "new/a.txt", old_text: "zzz", new_text: "" })).toContain("not found");
  await run("write_file", { path: "dup.txt", content: "x x" });
  expect(await run("edit_file", { path: "dup.txt", old_text: "x", new_text: "y" })).toContain("found 2 times");
});

test.each(["../outside.txt", "/etc/passwd", "notes/../../x", "~/x"])("paths outside the workspace are refused: %s", async (p) => {
  for (const [name, args] of [
    ["read_file", { path: p }],
    ["write_file", { path: p, content: "x" }],
    ["list_dir", { path: p }],
  ] as const) {
    expect(await run(name, args)).toMatch(/^Error:/);
  }
});

test("a symlink escape is refused", async () => {
  const base = tmpDir();
  const outside = path.join(base, "outside");
  mkdirSync(outside);
  writeFileSync(path.join(outside, "secret.txt"), "secret");
  const inner = path.join(base, "root");
  mkdirSync(inner);
  symlinkSync(outside, path.join(inner, "link"));
  const t = Object.fromEntries(makeFsTools([inner]).map((x) => [x.name, x]));
  expect(await t.read_file.invoke({ path: "link/secret.txt" })).toMatch(/^Error:/);
  expect(await t.search_files.invoke({ pattern: "secret", path: "." })).toBe("No matches.");
});

test("multiple roots", () => {
  const base = tmpDir();
  const a = path.join(base, "a");
  const b = path.join(base, "b");
  mkdirSync(a);
  mkdirSync(b);
  writeFileSync(path.join(b, "f.txt"), "in b");
  const ws = new Workspace([a, b]);
  expect(ws.resolve("x.txt")).toBe(path.join(a, "x.txt")); // relative → first root
  expect(ws.resolve(path.join(b, "f.txt"))).toBe(path.join(b, "f.txt")); // absolute in another root is fine
  expect(() => ws.resolve(path.join(base, "c.txt"))).toThrow(SandboxError);
});

test("capOutput cuts long results and keeps the tool's name", async () => {
  writeFileSync(path.join(root, "big.txt"), "x".repeat(50));
  const capped = capOutput(tools.read_file, 20);
  expect(capped.name).toBe("read_file");
  expect(await capped.invoke({ path: "big.txt" })).toMatch(/…\[truncated \d+ characters\]$/);
});
