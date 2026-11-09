// The built-in helpers: researcher, files and coder (specs, approval, tools).
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

import { tool } from "@langchain/core/tools";
import { expect, test } from "vitest";
import * as z from "zod";

import { coderSpec } from "../src/agent/subagents/coder.ts";
import { filesSpec } from "../src/agent/subagents/files.ts";
import { getSubagentSpecs, makeDelegateTool } from "../src/agent/subagents/index.ts";
import { researcherSpec } from "../src/agent/subagents/researcher.ts";
import { loadSettings, type Settings } from "../src/config/settings.ts";
import { capOutput } from "../src/tools/limits.ts";
import type { AnyTool } from "../src/tools/registry.ts";
import { makeRunCommand } from "../src/tools/shell.ts";
import { fakeModel, tmpDir, toolCall } from "./helpers.ts";

const settings = (dir: string, overrides: Partial<Settings> = {}) =>
  loadSettings({ envFile: null, env: {}, overrides: { openrouter_api_key: "test", workspace_dirs: [dir], ...overrides } });
const names = (tools: { name: string }[]) => new Set(tools.map((t) => t.name));

// --- researcher ---------------------------------------------------------------------

test("the researcher is off without a Tavily key", () => {
  const s = settings(tmpDir(), { tavily_api_key: null });
  expect(researcherSpec(s)).toBeNull();
  expect(names(getSubagentSpecs(s))).not.toContain("ask_researcher");
});

test("the researcher is on with a key", () => {
  const s = settings(tmpDir(), { tavily_api_key: "tvly-test" });
  const spec = researcherSpec(s)!;
  expect(spec.name).toBe("ask_researcher");
  expect(names(spec.tools)).toEqual(new Set(["tavily_search", "tavily_extract", "calculator"]));
  expect(spec.interruptOn).toEqual({}); // read-only: never asks for approval
  expect(names(getSubagentSpecs(s))).toContain("ask_researcher");
});

test("the researcher answers from search results", async () => {
  const fakeSearch = tool(async () => ({ results: [{ url: "https://example.com/langgraph", content: "v2 released" }] }), {
    name: "tavily_search", description: "Search the web.", schema: z.object({ query: z.string() }),
  });
  const model = fakeModel(
    toolCall("tavily_search", "c1", { query: "langgraph release" }),
    "LangGraph v2 was released.\n\nSources:\n- https://example.com/langgraph",
  );
  const spec = { ...researcherSpec(settings(tmpDir(), { tavily_api_key: "tvly-test" }))!, tools: [fakeSearch as unknown as AnyTool], model: model as never };
  const answer = await makeDelegateTool(spec, null).invoke({ task: "What's new in LangGraph?" });
  expect(answer).toContain("https://example.com/langgraph");
  // The search result was shown to the researcher's model, not returned raw.
  expect(model.inputs[1].some((t) => t.includes("v2 released"))).toBe(true);
});

test("capOutput truncates long results and serialises objects", async () => {
  const big = tool(async ({ n }) => "x".repeat(n), { name: "big", description: "Return n characters.", schema: z.object({ n: z.number() }) });
  const capped = capOutput(big as unknown as AnyTool, 10);
  expect([capped.name, capped.description]).toEqual(["big", big.description]);
  expect(await capped.invoke({ n: 5 })).toBe("xxxxx");
  const out = (await capped.invoke({ n: 25 })) as string;
  expect(out.startsWith("x".repeat(10))).toBe(true);
  expect(out).toContain("truncated 15 characters");
  const data = tool(async () => ({ a: 1 }), { name: "data", description: "Return a dict.", schema: z.object({}) });
  expect(await capOutput(data as unknown as AnyTool).invoke({})).toBe('{"a":1}');
});

// --- files --------------------------------------------------------------------------

test("files: writes need approval by default; auto-approve removes the prompt", () => {
  const dir = tmpDir();
  const spec = filesSpec(settings(dir));
  expect(spec.interruptOn).toEqual({ write_file: true, edit_file: true });
  expect(spec.systemPrompt).toContain(dir);
  expect(filesSpec(settings(dir, { auto_approve: ["write_file"] })).interruptOn).toEqual({ edit_file: true });
});

// --- coder / run_command ------------------------------------------------------------

test("the coder asks before writes and commands, and can plan", () => {
  const spec = coderSpec(settings(tmpDir()));
  expect(spec.interruptOn).toEqual({ write_file: true, edit_file: true, run_command: true });
  expect((spec.middleware as { name: string }[]).map((m) => m.name)).toContain("todoListMiddleware");
});

test("run_command reports the exit code and output", async () => {
  const out = (await makeRunCommand([tmpDir()]).invoke({ command: "echo hello && exit 3" })) as string;
  expect(out).toContain("(exit code 3)");
  expect(out).toContain("hello");
});

test("run_command runs in the workspace and refuses a cwd outside", async () => {
  const dir = tmpDir();
  mkdirSync(path.join(dir, "sub"));
  expect(await makeRunCommand([dir]).invoke({ command: "pwd", cwd: "sub" })).toContain(path.join(dir, "sub"));
  expect(await makeRunCommand([dir]).invoke({ command: "ls", cwd: "/" })).toMatch(/^Error:/);
});

test("a run_command timeout kills the process", async () => {
  const start = performance.now();
  const out = await makeRunCommand([tmpDir()]).invoke({ command: "sleep 30 & sleep 30", timeout_seconds: 1 });
  expect(out).toContain("Timed out after 1s");
  expect(performance.now() - start).toBeLessThan(5000);
});

test("run_command trims long output", async () => {
  const out = (await makeRunCommand([tmpDir()]).invoke({
    command: `node -e "console.log('A'.repeat(3000) + 'B'.repeat(10000) + 'END')"`,
  })) as string;
  expect(out).toContain("characters omitted");
  expect(out.trimEnd().endsWith("END")).toBe(true);
  expect(out.length).toBeLessThan(9000);
});

test("run_command is killed when the task is cancelled", async () => {
  const dir = tmpDir();
  const marker = path.join(dir, "still_running");
  const controller = new AbortController();
  const run = makeRunCommand([dir]).invoke({ command: `sleep 1.5 && touch ${marker}` }, { signal: controller.signal });
  await new Promise((r) => setTimeout(r, 300));
  controller.abort();
  await expect(run).rejects.toThrow();
  await new Promise((r) => setTimeout(r, 2000));
  expect(existsSync(marker)).toBe(false);
});
