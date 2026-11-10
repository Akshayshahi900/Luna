/**
 * Sessions — saved conversations you can list, resume and delete.
 *
 * BEGINNER MAP
 * ------------
 * A session is a thread: every checkpoint saved under one thread_id
 * (agent/memory.ts). Luna starts a NEW session every time (each CLI
 * start, each browser tab / reload), and you resume an old one on purpose:
 *
 *   CLI   luna --resume [id]   /sessions   /resume <n|id>   /delete <n|id>
 *   Web   transcript drawer → SESSIONS list (resume, delete)
 *
 * A session only exists once something was said in it (a fresh thread has
 * no checkpoint), so opening Luna and closing it again leaves no clutter.
 *
 * There is no separate table of sessions: the list is built from the
 * checkpoints, so it can never disagree with what is actually saved.
 * Titles come from the first thing you said.
 */

import { randomUUID } from "node:crypto";

import type { BaseMessage } from "@langchain/core/messages";
import type { BaseCheckpointSaver, CheckpointTuple } from "@langchain/langgraph";

export const TITLE_CHARS = 60;

export interface SessionInfo {
  id: string;
  title: string;
  updated_at: string;
  turns: number;
}

/** A fresh, unique thread id for a new session. */
export function newSessionId(): string {
  return randomUUID();
}

const isHuman = (m: unknown) => (m as BaseMessage | undefined)?.type === "human";

function title(messages: BaseMessage[]): string {
  const first = messages.find((m) => isHuman(m) && m.text.trim());
  if (!first) return "(no messages)";
  const text = first.text.split(/\s+/).filter(Boolean).join(" ");
  return [...text].length <= TITLE_CHARS ? text : [...text].slice(0, TITLE_CHARS - 1).join("") + "…";
}

/**
 * Every saved session, most recently used first.
 *
 * turns = user messages still in the thread; summarization may have folded
 * older ones.
 */
export async function listSessions(checkpointer: BaseCheckpointSaver): Promise<SessionInfo[]> {
  const latest = new Map<string, CheckpointTuple>(); // thread id → newest main-graph checkpoint
  for await (const item of checkpointer.list({})) {
    const configurable = item.config.configurable ?? {};
    if (configurable.checkpoint_ns) continue; // a helper's checkpoint inside the thread
    const threadId = String(configurable.thread_id);
    const best = latest.get(threadId);
    if (!best || item.checkpoint.ts > best.checkpoint.ts) latest.set(threadId, item);
  }
  const sessions: SessionInfo[] = [];
  for (const [id, item] of latest) {
    const messages = ((item.checkpoint.channel_values ?? {}) as { messages?: BaseMessage[] }).messages ?? [];
    sessions.push({ id, title: title(messages), updated_at: item.checkpoint.ts, turns: messages.filter(isHuman).length });
  }
  return sessions.sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0));
}

/**
 * A session id from what the user typed: a list number (1 = newest), a full
 * id, or the start of one. null when nothing (or several) match.
 */
export function resolveSession(ref: string, sessions: SessionInfo[]): string | null {
  ref = ref.trim();
  if (!ref) return null;
  if (/^\d+$/.test(ref) && Number(ref) >= 1 && Number(ref) <= sessions.length) return sessions[Number(ref) - 1].id;
  if (sessions.some((s) => s.id === ref)) return ref;
  const matches = sessions.filter((s) => s.id.startsWith(ref)).map((s) => s.id);
  return matches.length === 1 ? matches[0] : null;
}

/** Remove every checkpoint of a session (its messages, notes, pauses).
 * Long-term memory is separate and is not touched. */
export async function deleteSession(checkpointer: BaseCheckpointSaver, threadId: string): Promise<void> {
  await checkpointer.deleteThread(threadId);
}
