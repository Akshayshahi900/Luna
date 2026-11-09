/**
 * The agent every tab shares (AgentHost), and one tab's conversation (Session).
 *
 * BEGINNER MAP
 * ------------
 * One browser tab = one WebSocket = one Session. A Session does what
 * cli/chat.ts `runTurn` does, but split across messages because the answer
 * to a pause arrives later from the browser:
 *
 *   browser → {"type": "message", "text": ...}   new task: fresh TaskBudget, runTask
 *   server  → token / tool_call / tool_result / notice ... (streamed, see events.ts)
 *   server  → {"type": "pause", ...}  or  {"type": "done"}
 *   browser → {"type": "resume", "answers": {pause_id: reply}}   same budget, runTask again
 *   browser → {"type": "set_model", "provider": ..., "model": ...}  AgentHost rebuilds the agent
 *
 * Sessions: every socket (a new tab, a reload) starts a NEW session (thread).
 * The browser lists saved ones with {"type": "sessions"}, resumes one with
 * {"type": "thread", "id"} and deletes one with {"type": "delete_session"}
 * (agent/sessions.ts).
 *
 * All tabs share one AgentHost: switching the model switches it for everyone
 * (the memory and MCP connections are reused, so threads carry on). The
 * Telegram bot (channels/telegram.ts) uses the same host.
 *
 * Context meter: on every sync and at the end of every run (just before
 * done / pause / cancelled / error) the server sends
 * {"type": "context", "used", "max"}: the thread history's approximate token
 * count and the point where it gets summarized (summary_trigger_tokens).
 *
 * Long-term memory (agent/longterm.ts): the Memory panel lists, edits and
 * undoes memories and answers Luna's suggestions with memory_* /
 * suggestion_* messages; the server answers with {"type": "memories", ...}
 * and tells every tab the inbox size ({"type": "memory_inbox", "count"}) on
 * sync, after each run and after every memory change.
 *
 * A run happens in the background, so the socket keeps listening: a
 * {"type": "cancel"} aborts it, and cancelCleanup() gives every unanswered
 * tool call a "Cancelled by the user." result so the thread stays valid.
 */

import { type BaseMessage, ToolMessage } from "@langchain/core/messages";
import { Command } from "@langchain/langgraph";
import { countTokensApproximately } from "langchain";

import { TaskBudget } from "../agent/budget.ts";
import { recursionLimit } from "../agent/builder.ts";
import type { LongTermStore } from "../agent/longterm.ts";
import { MemoryRefused } from "../agent/longterm.ts";
import { defaultModel, getProvider, listModels } from "../agent/providers.ts";
import { runTask } from "../agent/runner.ts";
import { deleteSession, listSessions, newSessionId } from "../agent/sessions.ts";
import { type Interrupt, type LunaAgent, snapshotInterrupts } from "../agent/types.ts";
import type { Settings } from "../config/settings.ts";
import type { RoutineScheduler } from "../routines/scheduler.ts";
import type { RoutineStore } from "../routines/store.ts";
import type { AnyTool } from "../tools/registry.ts";
import type { SpeechToText } from "../voice/stt.ts";
import type { TextToSpeech } from "../voice/tts.ts";
import { type BrowserEvent, buildAnswer, describePause, EventTranslator, isModelUpdate, type Pause } from "./events.ts";

// How many past messages to send when a tab connects or switches thread.
export const HISTORY_LIMIT = 40;
// Context meter ceiling when summarization is off (LUNA_SUMMARY_TRIGGER_TOKENS=0).
export const CONTEXT_FALLBACK_TOKENS = 128_000;
export const CANCELLED = "Cancelled by the user.";

/** (provider, model) → a new agent built on the same memory and MCP tools. */
export type Rebuild = (provider: string, model: string) => Promise<LunaAgent>;
export type Send = (event: BrowserEvent) => void;

/** Replaceable in tests (the model list comes from the provider's API). */
export const hooks = { listModels };

export interface Usage {
  runs: number;
  model_calls: number;
  tool_calls: number;
  errors: number;
}

/** The agent all sessions use, and how to swap its model. */
export class AgentHost {
  agent: LunaAgent;
  settings: Settings;
  provider: string;
  model: string;
  readonly #rebuild: Rebuild | null;
  #switching: Promise<unknown> = Promise.resolve();
  // Voice engines for /api/tts and /api/stt (voice/), or null.
  tts: TextToSpeech | null = null;
  stt: SpeechToText | null = null;
  // Long-term memory shared by every tab (null = turned off).
  memory: LongTermStore | null = null;
  // Every open tab's send function, told when the model changes.
  readonly listeners = new Set<Send>();
  // For the Control Center (web/control.ts):
  readonly startedAt = Date.now();
  mcpGroups = new Map<string, AnyTool[]>(); // tools by helper tag ("" = main agent)
  mcpErrors = new Map<string, string>(); // helper tag → why its MCP group failed
  routines: RoutineStore | null = null; // routines + usage counters
  scheduler: RoutineScheduler | null = null;
  telegram: { stop(): Promise<void> } | null = null; // TelegramBridge (channels/telegram.ts), if a bot token is set
  // Model / tool calls and errors since startup (per day in this.routines).
  readonly usage: Usage = { runs: 0, model_calls: 0, tool_calls: 0, errors: 0 };

  constructor(agent: LunaAgent, settings: Settings, provider: string, model: string, rebuild: Rebuild | null = null) {
    this.agent = agent;
    this.settings = settings;
    this.provider = provider;
    this.model = model;
    this.#rebuild = rebuild;
  }

  /** True when the agent can be rebuilt with another model. */
  get canSwitch(): boolean {
    return this.#rebuild !== null;
  }

  /** The current provider and model, as a `model` message for the browser. */
  info(): BrowserEvent {
    return { type: "model", provider: this.provider, model: this.model };
  }

  #locked<T>(run: () => Promise<T>): Promise<T> {
    const job = this.#switching.then(run);
    this.#switching = job.catch(() => undefined);
    return job;
  }

  /** Rebuild the agent with another model. Runs already in progress finish
   * on the old one; the next message uses the new one. */
  async switch(provider: string, model = ""): Promise<void> {
    if (!this.#rebuild) throw new Error("Model switching isn't available on this server.");
    const chosen = model.trim() || defaultModel(getProvider(provider), this.settings);
    await this.#locked(async () => {
      this.agent = await this.#rebuild!(provider, chosen);
      this.provider = provider;
      this.model = chosen;
    });
    this.broadcast(this.info());
  }

  /** Use new settings (saved in the Control Center) and rebuild the agent
   * with them, keeping the model. Returns true if it was rebuilt. */
  async reconfigure(settings: Settings): Promise<boolean> {
    this.settings = settings;
    if (!this.#rebuild) return false;
    await this.#locked(async () => {
      this.agent = await this.#rebuild!(this.provider, this.model);
    });
    return true;
  }

  /** Send one event to every open tab. */
  broadcast(event: BrowserEvent): void {
    for (const send of [...this.listeners]) send(event);
  }

  /** Count one run's model / tool calls for the Control Center stats. */
  recordUsage(counts: Partial<Usage>): void {
    for (const key of ["runs", "model_calls", "tool_calls", "errors"] as const) this.usage[key] += counts[key] ?? 0;
    try {
      this.routines?.addUsage(this.provider, this.model, counts);
    } catch (error) {
      // stats must never break a run
      console.error(`Warning: could not save usage (${(error as Error).message}).`);
    }
  }

  /** Tell every tab how many memory suggestions are waiting. */
  broadcastInbox(): void {
    if (this.memory) this.broadcast({ type: "memory_inbox", count: this.memory.pendingCount() });
  }
}

const isAbort = (error: unknown) => (error as Error)?.name === "AbortError" || /abort/i.test((error as Error)?.message ?? "");

/**
 * After a run was cancelled (or a pause abandoned), answer every tool call
 * that has no result yet, so the next message can run normally.
 *
 * Without this the model would see a tool call with no result, which model
 * APIs reject. Writing the results "as the tools node" also clears any
 * approval pause that was waiting. Returns the tool names it closed.
 */
export async function cancelCleanup(agent: LunaAgent, config: Record<string, unknown>): Promise<string[]> {
  if (!agent.checkpointer) return [];
  const state = await agent.getState(config);
  const messages = (state.values?.messages ?? []) as BaseMessage[];
  const answered = new Set(messages.filter((m) => m.type === "tool").map((m) => (m as ToolMessage).tool_call_id));
  const lastAi = [...messages].reverse().find((m) => m.type === "ai") as (BaseMessage & { tool_calls?: { id?: string; name: string }[] }) | undefined;
  const missing = (lastAi?.tool_calls ?? []).filter((c) => c.id && !answered.has(c.id));
  if (missing.length) {
    await agent.updateState(
      config,
      { messages: missing.map((c) => new ToolMessage({ content: CANCELLED, tool_call_id: c.id!, name: c.name })) },
      "tools",
    );
  }
  return missing.map((c) => c.name);
}

const MEMORY_MESSAGES = new Set(["memory_save", "memory_delete", "memory_undo", "memory_history", "suggestion_accept", "suggestion_reject"]);

/** One browser connection: its thread, pending pauses and task budget. */
export class Session {
  readonly host: AgentHost;
  readonly send: Send;
  // Always a fresh session; old ones are resumed on request.
  threadId = newSessionId();
  pending = new Map<string, Pause>(); // pause id → describePause() output
  budget: TaskBudget | null = null;
  #translate = new EventTranslator();
  #run: Promise<void> | null = null; // the run in progress, if any
  #controller: AbortController | null = null;
  #counts = { model_calls: 0, tool_calls: 0 }; // this run, for host.usage

  constructor(host: AgentHost, send: Send) {
    this.host = host;
    this.send = send;
  }

  /** The host's settings (they change when saved in the Control Center). */
  get settings(): Settings {
    return this.host.settings;
  }

  /** The current agent (it changes when the model is switched). */
  get agent(): LunaAgent {
    return this.host.agent;
  }

  /** True while a run is in progress on this connection. */
  get busy(): boolean {
    return this.#run !== null;
  }

  /** Resolves when the current run (if any) has finished. */
  async idle(): Promise<void> {
    await this.#run;
  }

  get #config(): Record<string, any> {
    return { configurable: { thread_id: this.threadId }, recursionLimit: recursionLimit(this.settings) };
  }

  #forward = (namespace: string[], mode: string, payload: unknown): void => {
    if (isModelUpdate(mode, payload)) this.#counts.model_calls += 1; // one model update = one model call (any agent)
    for (const event of this.#translate.translate(namespace, mode, payload)) {
      if (event.type === "tool_call") this.#counts.tool_calls += 1;
      this.send(event);
    }
  };

  #record(error = false): void {
    this.host.recordUsage({ runs: 1, errors: error ? 1 : 0, ...this.#counts });
    this.#counts = { model_calls: 0, tool_calls: 0 };
  }

  #setPending(interrupts: Interrupt[]): void {
    this.pending = new Map(interrupts.map((i) => [i.id ?? "", describePause(i)]));
  }

  /**
   * Send the thread id, its recent messages and any pause still waiting.
   * A pause survives a page reload: it lives in the checkpoint, not here.
   */
  async sync(): Promise<void> {
    const state = this.agent.checkpointer ? await this.agent.getState(this.#config) : null;
    const messages = (state?.values?.messages ?? []) as BaseMessage[];
    const history = messages
      .filter((m) => (m.type === "human" || m.type === "ai") && m.text)
      .map((m) => ({ role: m.type === "human" ? "user" : "luna", text: m.text }))
      .slice(-HISTORY_LIMIT);
    this.send({ type: "thread", id: this.threadId, history });
    this.send(this.#context(messages));
    this.#sendInbox();
    this.#setPending(state ? snapshotInterrupts(state) : []);
    if (this.pending.size) {
      this.budget = new TaskBudget(this.settings.task_budget);
      this.send({ type: "pause", pauses: [...this.pending.values()] });
    }
  }

  /** The context meter: thread history tokens vs. the summarization point. */
  #context(messages: BaseMessage[]): BrowserEvent {
    const limit = this.settings.summary_trigger_tokens || CONTEXT_FALLBACK_TOKENS;
    return { type: "context", used: messages.length ? countTokensApproximately(messages) : 0, max: limit };
  }

  async #sendSessions(): Promise<void> {
    const items = this.agent.checkpointer ? await listSessions(this.agent.checkpointer as never) : [];
    this.send({ type: "sessions", items }); // most recent first
  }

  #sendInbox(): void {
    if (this.host.memory) this.send({ type: "memory_inbox", count: this.host.memory.pendingCount() });
  }

  #memories(): BrowserEvent {
    const store = this.host.memory!;
    return { type: "memories", items: store.list(), suggestions: store.suggestions() };
  }

  /** Memory panel requests. They don't touch the run, so they work while
   * busy, and failures are memory_error (not error, which ends a run in the UI). */
  #handleMemory(kind: string, msg: Record<string, any>): void {
    const store = this.host.memory;
    if (!store) return this.send({ type: "memory_error", message: "Long-term memory is off." });
    const id = () => {
      const n = Number(msg.id);
      if (!Number.isInteger(n)) throw new MemoryRefused("Bad memory request.");
      return n;
    };
    try {
      if (kind === "memory_save") {
        const k = String(msg.kind || "fact");
        const pinned = Boolean(msg.pinned ?? false);
        if (msg.id === undefined || msg.id === null) store.add(String(msg.text ?? ""), k, pinned);
        else store.edit(id(), { text: String(msg.text ?? ""), kind: k, pinned });
      } else if (kind === "memory_delete") store.delete(id());
      else if (kind === "memory_undo") store.undo(id());
      else if (kind === "memory_history") {
        const memoryId = id();
        return this.send({ type: "memory_history", id: memoryId, entries: store.history(memoryId) });
      } else if (kind === "suggestion_accept") store.accept(id(), msg.text ? String(msg.text) : null);
      else if (kind === "suggestion_reject") store.reject(id());
    } catch (error) {
      if (!(error instanceof MemoryRefused) && !(error instanceof TypeError)) throw error;
      return this.send({ type: "memory_error", message: (error as Error).message || "Bad memory request." });
    }
    this.send(this.#memories());
    if (kind.startsWith("suggestion_")) this.host.broadcastInbox();
  }

  async #sendContext(agent: LunaAgent, config: Record<string, unknown>): Promise<void> {
    if (!agent.checkpointer) return;
    try {
      const state = await agent.getState(config);
      this.send(this.#context((state.values?.messages ?? []) as BaseMessage[]));
    } catch {
      // the meter is cosmetic; never fail a run over it
    }
  }

  #start(payload: unknown): void {
    this.#controller = new AbortController();
    this.#run = this.#execute(payload, this.#controller.signal).finally(() => {
      this.#run = null;
      this.#controller = null;
    });
  }

  async #execute(payload: unknown, signal: AbortSignal): Promise<void> {
    this.send({ type: "state", value: "thinking" });
    const agent = this.agent; // fixed for this run, even if the model is switched
    const config = this.#config;
    let interrupts: Interrupt[];
    try {
      if (agent.checkpointer) this.#translate.prime(((await agent.getState(config)).values?.messages ?? []) as BaseMessage[]);
      interrupts = await runTask(agent, payload, config, { budget: this.budget, onEvent: this.#forward, signal });
    } catch (error) {
      this.pending = new Map();
      this.budget = null;
      if (signal.aborted || isAbort(error)) {
        this.#record();
        const closed = await cancelCleanup(agent, config).catch(() => [] as string[]);
        await this.#sendContext(agent, config);
        this.send({ type: "cancelled", tools: closed });
        return;
      }
      // report to the browser, keep the socket open
      this.#record(true);
      await this.#sendContext(agent, config);
      this.send({ type: "error", message: (error as Error)?.message || String(error) });
      return;
    }
    this.#record();
    this.#setPending(interrupts);
    // Before the final event, so the browser has it when the run ends.
    this.#sendInbox();
    await this.#sendContext(agent, config);
    if (this.pending.size) this.send({ type: "pause", pauses: [...this.pending.values()] });
    else {
      this.budget = null;
      this.send({ type: "done" });
    }
  }

  /** React to one message from the browser. */
  async handle(msg: unknown): Promise<void> {
    const m = (msg && typeof msg === "object" ? msg : {}) as Record<string, any>;
    const kind = typeof m.type === "string" ? m.type : null;

    if (kind === "message") {
      const text = String(m.text ?? "").trim();
      if (!text) return this.send({ type: "error", message: "Empty message." });
      if (this.busy) return this.send({ type: "error", message: "Still working on the last request." });
      // A new message now would leave the paused tool call unanswered.
      if (this.pending.size) return this.send({ type: "error", message: "Luna is waiting for your answer first." });
      this.budget = new TaskBudget(this.settings.task_budget);
      return this.#start({ messages: [{ role: "user", content: text }] });
    }

    if (kind === "cancel") {
      if (this.busy) {
        this.#controller?.abort(); // #execute cleans up and sends "cancelled"
        return;
      }
      if (this.pending.size) {
        // Abandon the open pause: its tool calls get "cancelled" results.
        const closed = await cancelCleanup(this.agent, this.#config);
        this.pending = new Map();
        this.budget = null;
        return this.send({ type: "cancelled", tools: closed });
      }
      return this.send({ type: "cancelled", tools: [] });
    }

    if (kind === "resume") {
      const replies = m.answers;
      if (this.busy || !this.pending.size) return this.send({ type: "error", message: "Nothing is waiting for an answer." });
      const ids = replies && typeof replies === "object" && !Array.isArray(replies) ? Object.keys(replies) : null;
      if (!ids || ids.length !== this.pending.size || !ids.every((id) => this.pending.has(id))) {
        return this.send({ type: "error", message: "Answer every pending pause." });
      }
      let answers: Record<string, unknown>;
      try {
        answers = Object.fromEntries(ids.map((id) => [id, buildAnswer(this.pending.get(id)!, replies[id])]));
      } catch (error) {
        return this.send({ type: "error", message: (error as Error).message });
      }
      return this.#start(new Command({ resume: answers }));
    }

    if ((kind === "new_thread" || kind === "thread" || kind === "delete_session") && this.busy) {
      return this.send({ type: "error", message: "Finish or cancel the current task first." });
    }

    if (kind === "new_thread") {
      this.threadId = newSessionId();
      return this.sync();
    }

    if (kind === "delete_session") {
      const threadId = String(m.id ?? "").trim();
      if (!threadId || !this.agent.checkpointer) return this.send({ type: "error", message: "Session id required." });
      await deleteSession(this.agent.checkpointer as never, threadId);
      if (threadId === this.threadId) {
        // Deleted the open one: carry on in a fresh session.
        this.threadId = newSessionId();
        await this.sync();
      }
      return this.#sendSessions();
    }

    if (kind === "thread") {
      const threadId = String(m.id ?? "").trim();
      if (!threadId) return this.send({ type: "error", message: "Thread id required." });
      this.threadId = threadId;
      return this.sync();
    }

    if (kind === "models") {
      const provider = String(m.provider ?? "");
      try {
        return this.send({ type: "models", provider, models: await hooks.listModels(this.settings, provider) });
      } catch (error) {
        // offline, bad key, Ollama not running…
        return this.send({ type: "models", provider, models: [], error: (error as Error).message });
      }
    }

    if (kind === "set_model") {
      try {
        await this.host.switch(String(m.provider ?? ""), String(m.model ?? ""));
      } catch (error) {
        // e.g. missing API key
        this.send({ type: "error", message: (error as Error).message });
      }
      return;
    }

    if (kind === "memories") {
      if (!this.host.memory) return this.send({ type: "memory_error", message: "Long-term memory is off." });
      return this.send(this.#memories());
    }

    if (kind && MEMORY_MESSAGES.has(kind)) return this.#handleMemory(kind, m);

    if (kind === "sessions") return this.#sendSessions();

    this.send({ type: "error", message: `Unknown message type: '${kind}'` });
  }
}
