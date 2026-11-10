/**
 * run_command — run a shell command inside the workspace.
 *
 * BEGINNER MAP
 * ------------
 * The command runs with a workspace folder as its working directory, a time
 * limit, and its output (stdout + stderr) cut to a readable size.
 *
 * A shell command can still reach outside the workspace (`cd /`, `rm`),
 * so the folder check is a convenience, NOT a security boundary. The real
 * safeguard is approval: the coder subagent always asks before running a
 * command unless you list run_command in LUNA_AUTO_APPROVE (not recommended).
 */

import { spawn } from "node:child_process";
import { statSync } from "node:fs";

import { tool } from "@langchain/core/tools";
import * as z from "zod";

import { SandboxError, Workspace } from "./fs.ts";
import type { AnyTool } from "./registry.ts";

const MAX_TIMEOUT = 600;
const HEAD_CHARS = 2000; // keep the start (the command's first errors)…
const TAIL_CHARS = 6000; // …and the end (test summaries, final errors)

export function trimOutput(output: string): string {
  if (output.length <= HEAD_CHARS + TAIL_CHARS) return output;
  const dropped = output.length - HEAD_CHARS - TAIL_CHARS;
  return `${output.slice(0, HEAD_CHARS)}\n…[${dropped} characters omitted]…\n${output.slice(-TAIL_CHARS)}`;
}

/** Kill the command and everything it started (its own process group). */
function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // already gone
  }
}

/** Build run_command for these workspace folders. */
export function makeRunCommand(roots: string[]): AnyTool {
  const ws = new Workspace(roots);

  return tool(
    async ({ command, cwd = ".", timeout_seconds = 60 }, config) => {
      let folder: string;
      try {
        folder = ws.resolve(cwd);
      } catch (error) {
        return `Error: ${(error as SandboxError).message}`;
      }
      try {
        if (!statSync(folder).isDirectory()) return `Error: '${cwd}' is not a folder`;
      } catch {
        return `Error: '${cwd}' is not a folder`;
      }
      const timeout = Math.min(Math.max(timeout_seconds, 1), MAX_TIMEOUT);
      const signal = config?.signal;

      return await new Promise<string>((resolve, reject) => {
        const child = spawn(command, {
          cwd: folder,
          shell: true,
          stdio: ["ignore", "pipe", "pipe"],
          detached: true, // own process group, so a timeout kills children too
        });
        const chunks: Buffer[] = [];
        child.stdout.on("data", (c: Buffer) => chunks.push(c));
        child.stderr.on("data", (c: Buffer) => chunks.push(c));
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          killGroup(child.pid);
        }, timeout * 1000);
        // The user cancelled the task (web UI "cancel"): don't leave it running.
        const onAbort = () => {
          killGroup(child.pid);
          reject(signal?.reason ?? new Error("Aborted"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        child.on("error", (error) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          resolve(`$ ${command}\nError: ${error.message}`);
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          if (timedOut) return resolve(`$ ${command}\nTimed out after ${timeout}s (killed).`);
          const output = trimOutput(Buffer.concat(chunks).toString("utf8")).trimEnd();
          resolve(`$ ${command}\n(exit code ${code})\n${output || "(no output)"}`);
        });
      });
    },
    {
      name: "run_command",
      description: "Run a shell command and return its exit code and output.",
      schema: z.object({
        command: z.string().describe("The command line, e.g. 'pnpm test' or 'ls -la'."),
        cwd: z.string().default(".").describe("Folder to run in, relative to the workspace."),
        timeout_seconds: z.number().int().default(60).describe("Kill the command after this many seconds (max 600)."),
      }),
    },
  ) as unknown as AnyTool;
}
