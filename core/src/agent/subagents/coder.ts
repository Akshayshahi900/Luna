/**
 * Coder subagent — read code, edit it, and run commands (tests, builds).
 *
 * Why a subagent (spec2 rules 1 and 3): coding is long and noisy (reading
 * files, test output), and running commands needs the strictest permissions.
 *
 * Always enabled. Uses the same workspace folders as the files helper.
 * write_file, edit_file and run_command ask for approval unless listed in
 * LUNA_AUTO_APPROVE. It also gets write_todos to plan multi-step changes.
 */

import { mkdirSync } from "node:fs";

import { todoListMiddleware } from "langchain";

import type { Settings } from "../../config/settings.ts";
import { makeFsTools } from "../../tools/fs.ts";
import { makeRunCommand } from "../../tools/shell.ts";
import { needsApproval, type SubagentSpec, subagentSpec } from "./base.ts";
import { WRITE_TOOLS, withRoots } from "./files.ts";

export const CODER_PROMPT = `
You are Luna's coding helper. You can only use these folders:
{roots}
Relative paths start at {first}.

- Explore first: list_dir, search_files and read_file before changing anything.
  Every step costs an API request, so read several files in the same step.
- For multi-step changes, plan with write_todos and keep it updated.
- Make small, focused edits with edit_file; match the existing code style.
- After changing code, run the relevant tests or checks with run_command.
  Run commands directly; never write wrapper scripts just to execute something.
- Writes and commands may need the user's approval. If the user rejects one,
  do not retry it; explain what you wanted to do instead.
- Reply in at most 300 words: what you changed (file paths), what you ran and
  the result, and anything left to do.
`.trim();

const DESCRIPTION =
  "Coding help in the workspace: understand a codebase, fix bugs, write or change " +
  "code, and run tests, scripts or any other shell command. Use this (not " +
  "ask_files) whenever something has to be executed. Edits and commands ask the " +
  "user for approval.";

/** The coder helper: file tools plus run_command, writes and commands need approval. */
export function coderSpec(settings: Settings): SubagentSpec {
  const roots = settings.workspace_dirs;
  mkdirSync(roots[0], { recursive: true });
  return subagentSpec({
    name: "ask_coder",
    description: DESCRIPTION,
    systemPrompt: withRoots(CODER_PROMPT, roots),
    tools: [...makeFsTools(roots), makeRunCommand(roots)],
    interruptOn: needsApproval([...WRITE_TOOLS, "run_command"], settings.auto_approve),
    middleware: [todoListMiddleware()],
    maxModelCalls: 10,
    timeoutSeconds: 600,
  });
}
