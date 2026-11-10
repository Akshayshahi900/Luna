/**
 * runTask — run one step of a task and report any pauses.
 *
 * BEGINNER MAP
 * ------------
 * A "task" is one user message plus everything the agents do for it. It may
 * pause several times for human approval or a question (`interrupt()`);
 * each pause ends the current run, and the task continues with a new run
 * that passes `new Command({ resume: ... })`.
 *
 * runTask() does one of those runs:
 *   - activates the shared TaskBudget (pass the SAME budget for every run of
 *     one task so resumes don't get a fresh allowance)
 *   - streams every event to `onEvent` (the CLI prints them; the web server
 *     forwards them to the browser)
 *   - returns the pauses waiting for an answer ([] means the task is done)
 *
 * To answer pauses, build `{[interrupt.id]: answer}` for each one and call
 * runTask again with `new Command({ resume: thatObject })`.
 */

import { type TaskBudget, currentBudget } from "./budget.ts";
import { type Interrupt, type LunaAgent, snapshotInterrupts } from "./types.ts";

/** (namespace, stream mode, payload) — see streamMode in agent.stream(). */
export type EventHandler = (namespace: string[], mode: string, data: any) => void;

export interface RunOptions {
  budget?: TaskBudget | null;
  onEvent?: EventHandler | null;
  /** Abort the run (the web UI's cancel / Esc). */
  signal?: AbortSignal;
}

/**
 * Run the agent until it finishes or pauses; return pending pauses.
 *
 * `payload` is either the normal input (`{messages: [...]}`) or a
 * `Command({resume})` answering earlier pauses.
 */
export async function runTask(
  agent: LunaAgent,
  payload: unknown,
  config: Record<string, any>,
  options: RunOptions = {},
): Promise<Interrupt[]> {
  const run = async () => {
    const stream = await agent.stream(payload, {
      ...config,
      streamMode: ["messages", "updates"],
      subgraphs: true,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    for await (const [namespace, mode, data] of stream) options.onEvent?.(namespace, mode, data);
  };
  // Everything started inside run() — subagents included — sees this budget.
  if (options.budget) await currentBudget.run(options.budget, run);
  else await currentBudget.exit(run);

  if (!agent.checkpointer) return []; // without a checkpointer the graph can't pause
  const state = await agent.getState(config);
  // Includes pauses raised inside subagents, each with its own id.
  return snapshotInterrupts(state);
}
