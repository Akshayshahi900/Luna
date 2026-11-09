/**
 * Per-message loop limits that really reset every message.
 *
 * LangChain JS's modelCallLimitMiddleware resets its run counter in
 * afterAgent, which a run that *ends at the limit* skips (it jumps straight
 * to the end), and toolCallLimitMiddleware never resets its run counter. With
 * a checkpointer both counters would then carry over into the next user
 * message, so after one runaway message every later one would stop at once.
 *
 * resetRunLimitsMiddleware() runs first, before every new message (a
 * beforeAgent hook), and zeroes both run counters. A resume after an
 * approval pause continues the same message, so it doesn't reset.
 */

import { createMiddleware } from "langchain";
import * as z from "zod";

export function resetRunLimitsMiddleware() {
  return createMiddleware({
    name: "ResetRunLimitsMiddleware",
    stateSchema: z.object({
      runModelCallCount: z.number().default(0),
      runToolCallCount: z.record(z.string(), z.number()).default({}),
    }),
    beforeAgent: () => ({ runModelCallCount: 0, runToolCallCount: {} }),
  });
}
