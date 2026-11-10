/**
 * The parts of a LangGraph agent Luna uses, as one TypeScript type.
 *
 * createAgent() returns a ReactAgent whose state methods (getState,
 * updateState) are typed `never` on purpose by LangChain (they are "internal"
 * there). Luna needs them for pauses, sessions and cancel repair, so this
 * interface names exactly what we call.
 */

import type { BaseCheckpointSaver, StateSnapshot } from "@langchain/langgraph";

export interface Interrupt {
  id?: string;
  value?: unknown;
}

export interface LunaAgent {
  name?: string;
  checkpointer?: BaseCheckpointSaver | boolean;
  invoke(input: unknown, config?: Record<string, unknown>): Promise<Record<string, any>>;
  stream(input: unknown, config?: Record<string, unknown>): Promise<AsyncIterable<any>>;
  getState(config: Record<string, unknown>, options?: { subgraphs?: boolean }): Promise<StateSnapshot>;
  updateState(config: Record<string, unknown>, values: unknown, asNode?: string): Promise<unknown>;
}

/** Pauses waiting for an answer in a state snapshot (subagent pauses included). */
export function snapshotInterrupts(state: StateSnapshot): Interrupt[] {
  const found: Interrupt[] = [];
  const seen = new Set<string>();
  for (const task of state.tasks ?? []) {
    for (const item of (task.interrupts ?? []) as Interrupt[]) {
      const key = item.id ?? JSON.stringify(item.value);
      if (seen.has(key)) continue;
      seen.add(key);
      found.push(item);
    }
  }
  return found;
}

/**
 * Every tool the agent can call, including ones added by middleware
 * (write_todos, write_note) that aren't in the ToolRegistry. Sorted.
 */
export function agentToolNames(agent: LunaAgent): string[] {
  const options = (agent as { options?: { tools?: { name?: string }[]; middleware?: { tools?: { name?: string }[] }[] } }).options ?? {};
  const tools = [...(options.tools ?? []), ...(options.middleware ?? []).flatMap((m) => m.tools ?? [])];
  return [...new Set(tools.map((t) => t.name).filter((n): n is string => Boolean(n)))].sort();
}
