/**
 * Files subagent — read, search and write files in the workspace.
 *
 * Why a subagent (spec2 rules 1 and 3): reading and searching files fills
 * the context with noise, and writing needs tighter permissions. The main
 * agent gets a short summary (and file paths), never whole files.
 *
 * Always enabled. Tools only reach LUNA_WORKSPACE_DIRS (default ./workspace).
 * write_file and edit_file ask for approval unless listed in LUNA_AUTO_APPROVE.
 */

import { mkdirSync } from "node:fs";

import type { Settings } from "../../config/settings.ts";
import { makeFsTools } from "../../tools/fs.ts";
import { needsApproval, type SubagentSpec, subagentSpec } from "./base.ts";

export const WRITE_TOOLS = ["write_file", "edit_file"];

export const FILES_PROMPT = `
You are Luna's files helper. You can only use these folders:
{roots}
Relative paths start at {first}.

- Look before you act: list_dir / search_files to find things, read_file before edit_file.
- Every step costs an API request: call independent tools together in one step,
  and answer as soon as you have what the task needs.
- Prefer edit_file for small changes; write_file for new files or full rewrites.
- write_file and edit_file may need the user's approval. If the user rejects an
  action, do not retry it; report what you were going to do instead.
- You cannot run commands or programs. Never write scripts as a way to "run"
  something. If the task needs something executed, do the file part and say
  that running it needs the coding helper.
- Reply in at most 300 words. For long results, save them to a file and give the path.
`.trim();

const DESCRIPTION =
  "Work with the user's documents and notes: find, read, summarise, create or " +
  "edit files in the workspace folders. Cannot run commands or programs; for " +
  "code changes, tests or anything that must be executed, use ask_coder. " +
  "Writes ask the user for approval.";

/** Fill {roots} and {first} in a helper prompt. */
export function withRoots(prompt: string, roots: string[]): string {
  return prompt.replace("{roots}", roots.map((r) => `- ${r}`).join("\n")).replace("{first}", roots[0]);
}

/** The files helper: read, search and (with approval) write in the workspace. */
export function filesSpec(settings: Settings): SubagentSpec {
  const roots = settings.workspace_dirs;
  mkdirSync(roots[0], { recursive: true });
  return subagentSpec({
    name: "ask_files",
    description: DESCRIPTION,
    systemPrompt: withRoots(FILES_PROMPT, roots),
    tools: makeFsTools(roots),
    interruptOn: needsApproval(WRITE_TOOLS, settings.auto_approve),
    maxModelCalls: 6,
    timeoutSeconds: 180,
  });
}
