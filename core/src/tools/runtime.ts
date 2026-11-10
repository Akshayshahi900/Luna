/**
 * What a tool learns about the call it runs in.
 *
 * Inside an agent, LangChain passes a second argument to every tool
 * function: the tool runtime (with the tool call id and the run config). A
 * test that calls tool.invoke({...}) directly gets a plain config instead,
 * so these helpers read both shapes and return undefined when a value is
 * missing.
 */

type RuntimeLike = {
  toolCallId?: string;
  toolCall?: { id?: string };
  config?: { configurable?: Record<string, unknown> };
  configurable?: Record<string, unknown>;
};

/** The id of the tool call being run (undefined outside an agent). */
export function toolCallIdOf(runtime: unknown): string | undefined {
  const r = runtime as RuntimeLike | undefined;
  return r?.toolCallId || r?.toolCall?.id || undefined;
}

/** The thread id of the run (undefined outside an agent). */
export function threadIdOf(runtime: unknown): string | undefined {
  const r = runtime as RuntimeLike | undefined;
  const id = r?.config?.configurable?.thread_id ?? r?.configurable?.thread_id;
  return id === undefined || id === null ? undefined : String(id);
}
