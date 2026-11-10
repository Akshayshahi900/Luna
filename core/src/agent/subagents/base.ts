/**
 * Subagents — helper agents the main agent can hand a task to.
 *
 * BEGINNER MAP
 * ------------
 * A subagent is just another tool. From the main agent's point of view,
 * `ask_researcher(task)` looks exactly like `calculator(expression)`: it
 * picks it when the tool description says it fits, and gets text back.
 *
 * Inside, the tool runs a *separate* agent with:
 *   - its own tools and system prompt (and optionally a different model)
 *   - a fresh, empty conversation on every call (it only sees `task` + `context`)
 *   - its own loop limit and timeout, plus the shared task budget
 *   - optional human approval for risky tools (`interruptOn`)
 *
 * Only the final answer goes back to the main agent, so noisy multi-step
 * work (searching, reading big files) never clutters the main chat history.
 *
 * Subagents cannot delegate further: their tools may not include other
 * delegate tools (one level only keeps cost and debugging manageable).
 *
 * When to add a subagent (see spec/spec2.md): the work is noisy and
 * multi-step, the main agent has too many / look-alike tools, it needs a
 * different model/prompt/permissions, or the pieces can run in parallel.
 * Otherwise keep it as a plain tool.
 *
 * To add one: write a `<name>Spec(settings)` function in a new module in
 * this folder and list it in `getSubagentSpecs()` (`index.ts`).
 */

import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { createAgent, humanInTheLoopMiddleware, modelCallLimitMiddleware } from "langchain";
import * as z from "zod";

import type { AnyTool } from "../../tools/registry.ts";
import { toolCallIdOf } from "../../tools/runtime.ts";
import { BUDGET_MESSAGE_PREFIX, taskBudgetMiddleware } from "../budget.ts";
import { resetRunLimitsMiddleware } from "../limits.ts";

// Marks a tool as a delegate so subagents can't be nested.
const DELEGATE_FLAG = "luna_delegate";
// Final-message prefixes that mean "stopped early" rather than a real answer:
// modelCallLimitMiddleware's limit message and the task-budget message.
const STOP_PREFIXES = ["Model call limits exceeded", BUDGET_MESSAGE_PREFIX];
// Run metadata key holding the ask_* tool call id a subagent run belongs to.
// It shows up in the subagent's streamed "messages" events, so the web UI can
// nest the helper's steps under the right delegation (web/events.ts).
export const PARENT_CALL_METADATA = "luna_parent_call";

export type InterruptOn = Record<string, boolean>;

/** Everything needed to build one subagent. */
export interface SubagentSpec {
  /** Tool name the main agent sees, e.g. "ask_researcher". */
  name: string;
  /** Tells the main agent WHEN to delegate. Write it like a tool description. */
  description: string;
  /** Instructions for the subagent itself. */
  systemPrompt: string;
  /** The subagent's own tools (not visible to the main agent). */
  tools: AnyTool[];
  /** Optional different model; undefined reuses the main agent's model. */
  model?: BaseChatModel | null;
  maxModelCalls: number;
  timeoutSeconds: number;
  /** Tools that need human approval before running, e.g. {write_file: true}. */
  interruptOn: InterruptOn;
  /** Extra middleware for this subagent (e.g. todoListMiddleware()). */
  middleware: unknown[];
}

/** A spec with the usual defaults filled in. */
export function subagentSpec(spec: Partial<SubagentSpec> & Pick<SubagentSpec, "name" | "description" | "systemPrompt">): SubagentSpec {
  return { tools: [], model: null, maxModelCalls: 6, timeoutSeconds: 120, interruptOn: {}, middleware: [], ...spec };
}

/** `interruptOn` for these tools, minus the ones the user auto-approves. */
export function needsApproval(toolNames: string[], autoApprove: string[]): InterruptOn {
  const trusted = new Set(autoApprove);
  return Object.fromEntries(toolNames.filter((n) => !trusted.has(n)).map((n) => [n, true]));
}

export function isDelegate(t: unknown): boolean {
  return Boolean((t as { metadata?: Record<string, unknown> })?.metadata?.[DELEGATE_FLAG]);
}

const startsWithStop = (text: string) => STOP_PREFIXES.some((p) => text.startsWith(p));

class Timeout extends Error {}

/** Wrap a subagent as a tool the main agent can call. */
export function makeDelegateTool(spec: SubagentSpec, defaultModel: BaseChatModel | null): AnyTool {
  const nested = spec.tools.filter(isDelegate).map((t) => t.name);
  if (nested.length) throw new Error(`Subagent '${spec.name}' may not use other subagents (${nested.join(", ")})`);

  const middleware: unknown[] = [
    resetRunLimitsMiddleware(),
    taskBudgetMiddleware(),
    modelCallLimitMiddleware({ runLimit: spec.maxModelCalls, exitBehavior: "end" }),
    ...spec.middleware,
  ];
  if (Object.keys(spec.interruptOn).length) middleware.push(humanInTheLoopMiddleware({ interruptOn: spec.interruptOn }));

  const agent = createAgent({
    model: (spec.model ?? defaultModel) as never,
    tools: spec.tools as never,
    systemPrompt: spec.systemPrompt,
    middleware: middleware as never,
    // No checkpointer of its own = use the main agent's. Needed so an approval
    // pause inside the subagent can resume where it stopped. Each call still
    // starts with an empty conversation: LangGraph gives every tool call its
    // own namespace.
    name: spec.name,
  });

  const delegate = tool(
    async ({ task, context = "" }, runtime) => {
      const prompt = context.trim() ? `${task}\n\nContext:\n${context}` : task;
      const callId = toolCallIdOf(runtime);
      const controller = new AbortController();
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Timeout());
        }, spec.timeoutSeconds * 1000);
      });
      let messages: BaseMessage[];
      try {
        const result = (await Promise.race([
          agent.invoke({ messages: [{ role: "user", content: prompt }] } as never, {
            recursionLimit: spec.maxModelCalls * 10 + 20,
            signal: controller.signal,
            ...(callId ? { metadata: { [PARENT_CALL_METADATA]: callId } } : {}),
          } as never),
          timeout,
        ])) as { messages?: BaseMessage[] };
        messages = result.messages ?? [];
      } catch (error) {
        if (error instanceof Timeout) return `[${spec.name} stopped: timed out after ${spec.timeoutSeconds}s]`;
        throw error;
      } finally {
        clearTimeout(timer);
      }

      const final = messages.length ? messages.at(-1)!.text : "";
      if (!startsWithStop(final)) return final || "(no answer)";

      // Stopped early (own limit or task budget): hand back the last real
      // answer text, if any, clearly marked as partial so the main agent knows.
      const partial =
        messages
          .slice(0, -1)
          .reverse()
          .find((m) => m.type === "ai" && m.text && !startsWithStop(m.text))?.text ?? "";
      const note = final.startsWith(BUDGET_MESSAGE_PREFIX)
        ? `[${spec.name} stopped: the task budget ran out]`
        : `[${spec.name} stopped at its limit of ${spec.maxModelCalls} steps]`;
      return partial ? `${note}\n${partial}` : note;
    },
    {
      name: spec.name,
      description: spec.description,
      schema: z.object({
        task: z
          .string()
          .describe(
            "A complete, self-contained description of the task. " +
              "The helper cannot see this conversation, so include every detail it needs.",
          ),
        context: z
          .string()
          .default("")
          .describe("Optional facts the helper needs: relevant notes, earlier results, file paths, user preferences."),
      }),
    },
  );
  delegate.metadata = { [DELEGATE_FLAG]: true };
  return delegate as unknown as AnyTool;
}
