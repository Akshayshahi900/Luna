/**
 * Task budget — one model-call allowance shared by the main agent and all subagents.
 *
 * BEGINNER MAP
 * ------------
 * Each agent already has its own loop limit (e.g. main 10, researcher 5).
 * But the main agent can call several subagents, each using its full limit,
 * so the worst case multiplies. The task budget caps the TOTAL number of
 * model calls for one user message, across every agent.
 *
 * How it works:
 *   1. runTask() (agent/runner.ts) creates a TaskBudget for the message and
 *      runs the agent inside `currentBudget.run(budget, ...)`.
 *   2. Every agent (main + subagents) has taskBudgetMiddleware(). Before each
 *      model call it takes one unit from the shared budget.
 *   3. When the budget is empty, the agent stops with a short message instead
 *      of calling the model again.
 *
 * AsyncLocalStorage (Node's version of Python's context variables) follows
 * every promise and callback started inside run(), so parallel subagents all
 * see — and draw from — the same TaskBudget object.
 */

import { AsyncLocalStorage } from "node:async_hooks";

import { AIMessage } from "@langchain/core/messages";
import { createMiddleware } from "langchain";

// Text the stop message starts with (subagents look for it to mark partial results).
export const BUDGET_MESSAGE_PREFIX = "Task budget exhausted";

/** How many model calls one user message may use, across all agents. */
export class TaskBudget {
  limit: number;
  used = 0;
  // Long-term memory suggestions made for this message (agent/longterm.ts).
  memorySuggestions = 0;

  constructor(limit: number) {
    this.limit = limit;
  }

  /** Model calls still allowed for this user message. */
  get remaining(): number {
    return Math.max(this.limit - this.used, 0);
  }
}

export const currentBudget = new AsyncLocalStorage<TaskBudget>();

/**
 * Take one unit from the current TaskBudget before every model call.
 *
 * Without an active budget (e.g. an agent invoked directly in a test) it
 * does nothing, so agents still work outside runTask().
 */
export function taskBudgetMiddleware() {
  return createMiddleware({
    name: "TaskBudgetMiddleware",
    beforeModel: {
      canJumpTo: ["end"],
      hook: () => {
        const budget = currentBudget.getStore();
        if (!budget) return undefined;
        if (budget.used >= budget.limit) {
          const message = `${BUDGET_MESSAGE_PREFIX} (${budget.limit} model calls for this task).`;
          return { jumpTo: "end", messages: [new AIMessage(message)] };
        }
        budget.used += 1;
        return undefined;
      },
    },
  });
}
