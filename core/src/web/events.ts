/**
 * Translate agent events and pauses into JSON for the browser.
 *
 * BEGINNER MAP
 * ------------
 * runTask() calls `onEvent(namespace, mode, payload)` for every streamed
 * event (see cli/chat.ts for the terminal version). The browser can't read
 * LangChain message objects, so EventTranslator turns each event into zero
 * or more plain objects:
 *
 *   {"type": "token",       "text": "..."}                        main agent's reply text
 *   {"type": "tool_call",   "name": ..., "args": {...}, "depth": n}
 *   {"type": "tool_result", "name": ..., "preview": "...", "depth": n}
 *   {"type": "notice",      "text": "...", "depth": n}            e.g. limit reached
 *
 * depth 0 = the main agent, 1 = a helper (subagent) running inside ask_*.
 * Helper events (depth >= 1) also carry "parent": the id of the ask_* tool
 * call they run under (or null if unknown), so the UI can nest them. The
 * link comes from the run metadata the delegate tool sets
 * (PARENT_CALL_METADATA), which only "messages" events carry: each helper
 * streams its model output before its first update, so the namespace is
 * known by the time its tool calls arrive.
 *
 * LangChain JS differs from Python in two ways handled here:
 *   - the model node is called "model_request" (MODEL_NODE)
 *   - middleware nodes report the whole message list in their "updates",
 *     not only what they added. So every message id is remembered, and
 *     prime() is told the thread's messages before a run: only messages
 *     with a new id become events.
 *
 * Pauses work the other way round: describePause() turns an interrupt into
 * something the UI can show, and buildAnswer() turns the browser's reply
 * back into the exact format the paused tool expects.
 */

import type { BaseMessage } from "@langchain/core/messages";

import { PARENT_CALL_METADATA } from "../agent/subagents/base.ts";
import type { Interrupt } from "../agent/types.ts";

/** The name of the model node in a LangChain JS agent graph. */
export const MODEL_NODE = "model_request";
// Tool results can be long; the UI only shows a glimpse.
export const TOOL_RESULT_PREVIEW = 240;

export type BrowserEvent = Record<string, any> & { type: string };

function short(text: string, limit = TOOL_RESULT_PREVIEW): string {
  const s = text.split(/\s+/).filter(Boolean).join(" ");
  return [...s].length <= limit ? s : [...s].slice(0, limit - 1).join("") + "…";
}

/** A message's content as text (tool results may be objects or blocks). */
export function contentText(message: BaseMessage): string {
  const content = (message as { content: unknown }).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((b) => (typeof b === "string" ? b : String((b as { text?: unknown })?.text ?? JSON.stringify(b)))).join("");
  }
  return JSON.stringify(content);
}

/** Maps one runTask event to a list of JSON-ready objects. */
export class EventTranslator {
  // namespace[0] of a helper run → id of the ask_* call it belongs to
  #parents = new Map<string, string>();
  // message ids already turned into events (or already in the thread)
  #seen = new Set<string>();

  /** Messages already in the thread: never reported again. */
  prime(messages: BaseMessage[]): void {
    for (const m of messages) if (m.id) this.#seen.add(m.id);
  }

  translate(namespace: string[], mode: string, payload: any): BrowserEvent[] {
    if (mode === "messages") {
      const [chunk, metadata] = payload as [BaseMessage, Record<string, unknown>];
      const parent = metadata?.[PARENT_CALL_METADATA];
      if (namespace.length && typeof parent === "string" && !this.#parents.has(namespace[0])) this.#parents.set(namespace[0], parent);
      // Same rule as the CLI: only the main agent's model text is the reply.
      if (namespace.length || metadata?.langgraph_node !== MODEL_NODE) return [];
      const text = chunk?.text ?? "";
      return text ? [{ type: "token", text }] : [];
    }

    const events: BrowserEvent[] = [];
    const depth = namespace.length;
    const extra = namespace.length ? { parent: this.#parents.get(namespace[0]) ?? null } : {};
    for (const [node, update] of Object.entries((payload ?? {}) as Record<string, any>)) {
      if (node === "__interrupt__") continue; // sent as a "pause" after the run, see server.ts
      const messages: BaseMessage[] = update && typeof update === "object" && Array.isArray(update.messages) ? update.messages : [];
      for (const message of messages) {
        if (message.id) {
          if (this.#seen.has(message.id)) continue;
          this.#seen.add(message.id);
        }
        const type = message.type;
        const calls = (message as { tool_calls?: { id?: string; name: string; args?: Record<string, unknown> }[] }).tool_calls ?? [];
        if (type === "ai" && calls.length) {
          for (const call of calls) {
            events.push({ type: "tool_call", id: call.id ?? null, name: call.name, args: call.args ?? {}, depth, ...extra });
          }
        } else if (type === "tool") {
          const tool = message as BaseMessage & { tool_call_id?: string; name?: string };
          events.push({ type: "tool_result", id: tool.tool_call_id ?? null, name: tool.name ?? null, preview: short(contentText(message)), depth, ...extra });
        } else if (type === "ai" && node !== MODEL_NODE && message.text) {
          // Written by middleware, e.g. "Model call limits exceeded".
          events.push({ type: "notice", text: message.text, depth, ...extra });
        }
      }
    }
    return events;
  }
}

/** True when an "updates" event is one model call (any agent). */
export function isModelUpdate(mode: string, payload: unknown): boolean {
  return mode === "updates" && typeof payload === "object" && payload !== null && MODEL_NODE in payload;
}

export interface PauseAction {
  name: string;
  args: Record<string, unknown>;
  description: string | null;
  allowed: string[];
}

export type Pause =
  | { id: string; kind: "question"; question: string }
  | { id: string; kind: "approval"; actions: PauseAction[] }
  | { id: string; kind: "other"; text: string };

/**
 * What the UI needs to show one pause.
 *
 * kind "question" → ask_user; "approval" → humanInTheLoopMiddleware (one
 * entry per tool call waiting for a decision); "other" → anything else.
 */
export function describePause(interrupt: Interrupt): Pause {
  const value = interrupt.value as Record<string, any> | undefined;
  const id = interrupt.id ?? "";
  if (value && typeof value === "object" && value.type === "ask_user") return { id, kind: "question", question: value.question ?? "" };
  if (value && typeof value === "object" && Array.isArray(value.actionRequests)) {
    const configs = new Map<string, any>(((value.reviewConfigs ?? []) as any[]).map((c) => [c.actionName, c]));
    return {
      id,
      kind: "approval",
      actions: (value.actionRequests as any[]).map((action) => ({
        name: action.name,
        args: action.args ?? {},
        description: action.description ?? null,
        allowed: configs.get(action.name)?.allowedDecisions ?? ["approve", "edit", "reject"],
      })),
    };
  }
  return { id, kind: "other", text: typeof value === "string" ? value : JSON.stringify(value) };
}

/** One browser decision → one humanInTheLoopMiddleware decision. */
function decision(action: PauseAction, reply: unknown): Record<string, unknown> {
  const r = (reply && typeof reply === "object" ? reply : { type: String(reply) }) as Record<string, unknown>;
  const kind = r.type as string;
  if (!action.allowed.includes(kind)) throw new Error(`'${kind}' is not allowed for ${action.name}`);
  if (kind === "approve") return { type: "approve" };
  if (kind === "reject") {
    const message = String(r.message ?? "").trim();
    return message ? { type: "reject", message } : { type: "reject" };
  }
  const args = r.args;
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("an edit needs 'args' as an object");
  return { type: "edit", editedAction: { name: action.name, args } };
}

/**
 * Turn the browser's reply to `pause` into the paused tool's resume value.
 *
 * Browser formats:
 *   question → {"answer": "text"} (or a bare string)
 *   approval → {"decisions": [{"type": "approve"} | {"type": "reject", "message"?}
 *                             | {"type": "edit", "args": {...}}, ...]}
 *              one per action, in order; a single decision applies to all
 * Throws for a reply that doesn't fit the pause.
 */
export function buildAnswer(pause: Pause, reply: unknown): unknown {
  if (pause.kind === "approval") {
    let decisions = (reply as { decisions?: unknown } | null)?.decisions;
    if (!Array.isArray(decisions) || !decisions.length) throw new Error("an approval needs a 'decisions' list");
    const actions = pause.actions;
    if (decisions.length === 1 && actions.length > 1) decisions = actions.map(() => (decisions as unknown[])[0]);
    if ((decisions as unknown[]).length !== actions.length) throw new Error(`expected ${actions.length} decisions, got ${(decisions as unknown[]).length}`);
    return { decisions: actions.map((a, i) => decision(a, (decisions as unknown[])[i])) };
  }
  const answer = reply && typeof reply === "object" ? ((reply as { answer?: unknown }).answer ?? "") : reply;
  return String(answer ?? "");
}
