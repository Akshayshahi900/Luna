/**
 * RoutineScheduler — run routines when they are due, inside luna-web.
 *
 * BEGINNER MAP
 * ------------
 * luna-web starts one scheduler (server.ts). Every TICK_SECONDS it asks the
 * store which enabled routines are due and runs them one after the other
 * (one at a time keeps API usage predictable):
 *
 *   builtin → builtin.runBuiltin      (calls one read-only MCP tool, no LLM)
 *   agent   → agent.runAgentRoutine   (runs the prompt on the current agent)
 *
 * After each run it stores the result, schedules the next run, and calls
 * `notify` with a {"type": "routine_result", ...} event, which luna-web
 * sends to every open tab so the HUD widgets update.
 *
 * "Run now" in the Control Center calls runNow(), which uses the same path.
 * A routine that is still running is never started twice.
 *
 * Routines only run while luna-web runs; a run missed while it was off is
 * NOT made up later: the next run is simply scheduled from now (D35).
 *
 * Read next: web/control.ts
 */

import { type Result, runBuiltin } from "./builtin.ts";
import type { Routine, RoutineStore, Run } from "./store.ts";

export const TICK_SECONDS = 30;

/** routine → [status, summary, data] */
export type Executor = (routine: Routine, signal: AbortSignal) => Promise<Result>;

/** The usual executor: built-ins call tools, agent routines run the agent. */
export function makeExecutor(
  getTools: () => Record<string, { invoke(args: Record<string, unknown>): Promise<unknown> }>,
  runAgent: ((routine: Routine, signal: AbortSignal) => Promise<Result>) | null,
  store: RoutineStore,
): Executor {
  return async (routine, signal) => {
    if (routine.kind === "builtin") return runBuiltin(routine.builtin!, getTools(), store.localNow());
    if (!runAgent) throw new Error("Agent routines aren't available here.");
    return runAgent(routine, signal);
  };
}

/** Runs due routines in the background; see the module comment. */
export class RoutineScheduler {
  readonly store: RoutineStore;
  readonly execute: Executor;
  readonly notify: ((event: Record<string, unknown>) => void) | null;
  readonly tickSeconds: number;
  readonly running = new Set<number>();
  #timer: NodeJS.Timeout | null = null;
  #stopped = true;
  #queue: Promise<unknown> = Promise.resolve(); // one routine at a time
  #controller = new AbortController();

  constructor(store: RoutineStore, execute: Executor, notify: RoutineScheduler["notify"] = null, tick = TICK_SECONDS) {
    this.store = store;
    this.execute = execute;
    this.notify = notify;
    this.tickSeconds = tick;
  }

  /** True while the background loop is running. */
  get active(): boolean {
    return !this.#stopped;
  }

  /** Start the background loop (idempotent). */
  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#controller = new AbortController();
    const loop = async () => {
      try {
        await this.tick();
      } catch (error) {
        // keep the scheduler alive
        if (!this.#stopped) console.error(`Warning: routine scheduler tick failed (${(error as Error).message}).`);
      }
      if (!this.#stopped) this.#timer = setTimeout(loop, this.tickSeconds * 1000);
    };
    this.#timer = setTimeout(loop, 0);
  }

  /** Stop the loop; a run in progress is told to stop. */
  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#controller.abort();
    await this.#queue.catch(() => undefined);
  }

  /** Run every routine that is due now; returns their run records. */
  async tick(): Promise<Run[]> {
    const done: Run[] = [];
    for (const routine of this.store.due()) {
      if (this.running.has(routine.id)) continue;
      // Schedule the next run first, so a slow or failing run isn't repeated.
      this.store.scheduleNext(routine.id);
      done.push(await this.run(routine));
    }
    return done;
  }

  /** Run one routine immediately (the "Run now" button). */
  async runNow(routineId: number): Promise<Run> {
    const routine = this.store.get(routineId);
    if (this.running.has(routineId)) throw new Error("That routine is already running.");
    return this.run(routine);
  }

  /** Run one routine, store the result and tell the browser tabs. */
  async run(routine: Routine): Promise<Run> {
    this.running.add(routine.id);
    let record: Run;
    try {
      const job = this.#queue.then(() => this.#runOne(routine));
      this.#queue = job.catch(() => undefined);
      record = await job;
    } finally {
      this.running.delete(routine.id);
    }
    this.notify?.({
      type: "routine_result",
      routine: { id: routine.id, name: routine.name, kind: routine.kind, builtin: routine.builtin ?? null, notify: routine.notify ?? true },
      run: record,
    });
    return record;
  }

  async #runOne(routine: Routine): Promise<Run> {
    const runId = this.store.startRun(routine.id);
    const signal = this.#controller.signal;
    let status: string;
    let summary: string;
    let data: unknown;
    let error: string | null;
    try {
      [status, summary, data] = await this.execute(routine, signal);
      error = status === "error" ? summary : null;
    } catch (e) {
      if (signal.aborted) return this.store.finishRun(runId, "error", "Stopped.", null, "Stopped");
      // recorded on the run, shown in the UI
      const message = (e as Error)?.message || (e as Error)?.name || String(e);
      [status, summary, data, error] = ["error", message, null, message];
    }
    return this.store.finishRun(runId, status, summary, data, error);
  }
}
