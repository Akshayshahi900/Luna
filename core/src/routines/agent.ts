/**
 * Agent routines: a prompt the agent runs on a schedule, with nobody watching.
 *
 * BEGINNER MAP
 * ------------
 * An agent routine is like typing the prompt into Luna yourself, except:
 *
 *   - it runs on its own thread, "routine-<id>", so it doesn't mix with your
 *     conversations (you can still open that thread in the transcript)
 *   - it gets the usual TaskBudget, so a routine can't burn more model calls
 *     than one normal message
 *   - nobody is there to approve risky tools, so every approval pause is
 *     REJECTED ("No one was there to approve this"). Tools you listed in
 *     LUNA_AUTO_APPROVE never pause, so they still run. A question
 *     (ask_user) gets "The user is away" and the agent carries on.
 *
 * This keeps D9 (risky actions need a human) intact: routines can read and
 * summarize, but only change things you already allowed without asking.
 *
 * The final reply of the agent becomes the run summary.
 *
 * Read next: routines/scheduler.ts
 */

import type { BaseMessage } from "@langchain/core/messages";
import { Command } from "@langchain/langgraph";

import { TaskBudget } from "../agent/budget.ts";
import { recursionLimit } from "../agent/builder.ts";
import { type EventHandler, runTask } from "../agent/runner.ts";
import type { LunaAgent } from "../agent/types.ts";
import type { Settings } from "../config/settings.ts";
import { buildAnswer, describePause, type Pause } from "../web/events.ts";
import type { Result } from "./builtin.ts";
import type { Routine } from "./store.ts";

// Pauses answered automatically before the routine gives up.
export const MAX_RESUMES = 5;
export const REJECTED = "No one was there to approve this (scheduled routine). Don't retry; report what you would have done.";
export const AWAY = "The user is away (this is a scheduled routine). Carry on without asking, or say what you need.";
const SUMMARY_CHARS = 600;

/** The thread an agent routine runs on. */
export function routineThread(routineId: number): string {
  return `routine-${routineId}`;
}

/** The browser-format reply for a pause nobody is there to answer. */
export function autoAnswer(pause: Pause): unknown {
  if (pause.kind === "approval") return { decisions: pause.actions.map(() => ({ type: "reject", message: REJECTED })) };
  return { answer: AWAY };
}

function finalText(messages: BaseMessage[]): string {
  const last = [...messages].reverse().find((m) => m.type === "ai" && m.text);
  const text = (last?.text ?? "").split(/\s+/).filter(Boolean).join(" ");
  return [...text].length <= SUMMARY_CHARS ? text : [...text].slice(0, SUMMARY_CHARS - 1).join("") + "…";
}

/**
 * Run the routine's prompt to the end; returns [status, summary, data].
 * data = {thread, rejected: [tool names refused for lack of approval]}.
 */
export async function runAgentRoutine(
  agent: LunaAgent,
  routine: Pick<Routine, "id" | "prompt">,
  settings: Settings,
  onEvent: EventHandler | null = null,
  signal?: AbortSignal,
): Promise<Result> {
  const thread = routineThread(routine.id);
  const config = { configurable: { thread_id: thread }, recursionLimit: recursionLimit(settings) };
  const budget = new TaskBudget(settings.task_budget);
  let payload: unknown = { messages: [{ role: "user", content: routine.prompt }] };
  const rejected: string[] = [];
  let finished = false;
  for (let i = 0; i <= MAX_RESUMES; i++) {
    const interrupts = await runTask(agent, payload, config, { budget, onEvent, signal });
    if (!interrupts.length) {
      finished = true;
      break;
    }
    const pauses = interrupts.map(describePause);
    for (const pause of pauses) if (pause.kind === "approval") rejected.push(...pause.actions.map((a) => a.name));
    payload = new Command({ resume: Object.fromEntries(pauses.map((p) => [p.id, buildAnswer(p, autoAnswer(p))])) });
  }
  if (!finished) return ["error", "Gave up: the routine kept asking for approval.", { thread, rejected }];

  let summary = "(no reply)";
  if (agent.checkpointer) {
    const state = await agent.getState(config);
    summary = finalText((state.values?.messages ?? []) as BaseMessage[]) || summary;
  }
  return ["ok", summary, { thread, rejected }];
}
