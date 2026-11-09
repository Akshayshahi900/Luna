/**
 * Task scratchpad — short-term working memory for the task in progress.
 *
 * BEGINNER MAP
 * ------------
 * The message history is a log of what was said. A scratchpad is different:
 * it is the agent's *current* view of the task, which it rewrites as it goes.
 *
 * Two parts, both stored in the agent's state (saved by the checkpointer):
 *   - todos  — the plan, managed by LangChain's todoListMiddleware (write_todos)
 *   - notes  — key → text facts the agent wants to keep (write_note, below)
 *
 * Every model call gets both rendered into the system prompt. That matters:
 *   - summarization only rewrites *messages*, so notes and todos survive it
 *   - they also survive a pause for human approval and the resume after it
 *
 * Subagent results come back as tool messages; the main agent copies the
 * important bits into notes so they stay visible for the rest of the task.
 */

import { SystemMessage, ToolMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { Command, ReducedValue, StateSchema } from "@langchain/langgraph";
import { createMiddleware } from "langchain";
import * as z from "zod";

import { toolCallIdOf } from "../tools/runtime.ts";

export const SCRATCHPAD_PROMPT = `
## Task scratchpad

Use \`write_note\` to keep facts you will need later in this task (results from
helpers, decisions, file paths, numbers). Notes stay visible to you even after
old messages are summarized. Keep each note short. Write an empty note to
delete it once it is no longer needed.
`.trim();

export type Notes = Record<string, string>;

/**
 * Reducer: apply partial updates. null or empty text deletes a note.
 *
 * Merging (instead of replacing the whole object) means two write_note calls
 * in the same step don't overwrite each other.
 */
export function mergeNotes(current: Notes | null | undefined, update: Record<string, string | null> | undefined): Notes {
  const merged: Notes = { ...(current ?? {}) };
  for (const [key, value] of Object.entries(update ?? {})) {
    if (value) merged[key] = value;
    else delete merged[key];
  }
  return merged;
}

export const ScratchpadState = new StateSchema({
  notes: new ReducedValue(z.record(z.string(), z.string()).default(() => ({})), {
    // Optional: a run's input never carries notes (Python: OmitFromInput).
    inputSchema: z.record(z.string(), z.string().nullable()).optional(),
    reducer: mergeNotes,
  }),
});

export const writeNote = tool(
  async ({ key, content }, runtime) => {
    const text = content.trim();
    const action = text ? "Saved" : "Deleted";
    return new Command({
      update: {
        notes: { [key]: text || null },
        messages: [new ToolMessage({ content: `${action} note '${key}'.`, tool_call_id: toolCallIdOf(runtime) ?? "" })],
      },
    });
  },
  {
    name: "write_note",
    description: "Save or update a note in your task scratchpad.",
    schema: z.object({
      key: z.string().describe("Short name for the note, e.g. 'flight_options' or 'user_budget'."),
      content: z.string().describe("The note text. Use an empty string to delete the note."),
    }),
  },
);

interface Todo {
  content?: string;
  status?: string;
}

/** Current todos + notes as prompt text ('' when both are empty). */
export function renderScratchpad(state: { todos?: Todo[]; notes?: Notes }): string {
  const parts: string[] = [];
  const todos = state.todos ?? [];
  if (todos.length) {
    parts.push("Current todos:\n" + todos.map((t) => `- [${t.status ?? "pending"}] ${t.content ?? ""}`).join("\n"));
  }
  const notes = state.notes ?? {};
  if (Object.keys(notes).length) {
    parts.push("Your notes:\n" + Object.entries(notes).map(([k, v]) => `- ${k}: ${v}`).join("\n"));
  }
  return parts.join("\n\n");
}

/** Add a text block to the end of the request's system message. */
export function appendSystemText(system: SystemMessage | undefined, text: string): SystemMessage {
  const blocks = system ? system.contentBlocks : [];
  return new SystemMessage({ content: [...blocks, { type: "text", text: `\n\n${text}` }] as never });
}

/** Adds the notes state + write_note tool, and shows the scratchpad each call. */
export function scratchpadMiddleware() {
  return createMiddleware({
    name: "ScratchpadMiddleware",
    stateSchema: ScratchpadState,
    tools: [writeNote],
    wrapModelCall: async (request, handler) => {
      let text = SCRATCHPAD_PROMPT;
      const current = renderScratchpad(request.state as { todos?: Todo[]; notes?: Notes });
      if (current) text += "\n\n" + current;
      return handler({ ...request, systemMessage: appendSystemText(request.systemMessage, text) });
    },
  });
}
