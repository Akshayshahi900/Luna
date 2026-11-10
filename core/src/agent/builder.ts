/**
 * Assemble the Luna agent (model + memory + tools).
 *
 * BEGINNER MAP
 * ------------
 * This is the "factory". It does not chat with you. It builds the object
 * that *can* chat.
 *
 * Analogy:
 *   - Model        = brain (OpenRouter, Groq or Ollama — see providers.ts)
 *   - Tools        = hands (calculator, MCP tools, ...)
 *   - Checkpointer = notebook (remembers the conversation)
 *   - createAgent  = wires brain + hands + notebook into one runnable graph
 *
 * After buildAgent() returns, the CLI only needs to call runTask(agent, ...).
 *
 * Read next: agent/memory.ts and tools/registry.ts
 */

import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import {
  createAgent,
  humanInTheLoopMiddleware,
  modelCallLimitMiddleware,
  summarizationMiddleware,
  todoListMiddleware,
  toolCallLimitMiddleware,
} from "langchain";

import { getSettings, type Settings } from "../config/settings.ts";
import { isRiskyToolName, loadMcpConfig, loadMcpTools, splitByAgent } from "../mcp/loader.ts";
import { getBuiltinTools } from "../tools/builtin/index.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { taskBudgetMiddleware } from "./budget.ts";
import { resetRunLimitsMiddleware } from "./limits.ts";
import { longTermMemoryMiddleware, type LongTermStore, openLongtermStore } from "./longterm.ts";
import { createCheckpointer } from "./memory.ts";
import { buildSystemPrompt } from "./persona.ts";
import { makeModel } from "./providers.ts";
import { scratchpadMiddleware } from "./scratchpad.ts";
import { getSubagentSpecs, type McpGroups, makeDelegateTool, needsApproval } from "./subagents/index.ts";
import type { LunaAgent } from "./types.ts";

/**
 * Load MCP tools, grouped by the server's "agent" tag ("" = main agent).
 *
 * May start MCP server subprocesses / open HTTP connections. A broken
 * server should not stop Luna from starting: warn and carry on with
 * whatever tools we already have (only that group is skipped). Pass
 * `errors` to also collect each failed group's error (the Control Center
 * shows them).
 */
export async function loadMcpGroups(settings: Settings, errors?: Map<string, string>): Promise<McpGroups> {
  const groups: McpGroups = new Map();
  if (!settings.enable_mcp_tools) return groups;
  let config;
  try {
    config = loadMcpConfig(settings.mcp_config_path);
  } catch (error) {
    // e.g. invalid JSON
    console.error(`Warning: could not load MCP tools (${(error as Error).message}). Continuing without them.`);
    errors?.set("", `Invalid MCP config: ${(error as Error).message}`);
    return groups;
  }
  if (!config) return groups;

  for (const [agent, groupConfig] of splitByAgent(config)) {
    try {
      groups.set(agent, await loadMcpTools(groupConfig));
    } catch (error) {
      // any MCP failure is non-fatal
      const message = (error as Error)?.message || (error as Error)?.name || String(error);
      errors?.set(agent, message);
      const owner = agent ? `the ${agent} helper` : "the main agent";
      console.error(`Warning: could not load MCP tools for ${owner} (${message}). Continuing without them.`);
    }
  }
  return groups;
}

/**
 * Collect every tool the MAIN agent should know about into one registry.
 *
 * Two sources:
 *   1. Built-in tools — TypeScript functions in this repo (tools/builtin).
 *   2. MCP tools — functions living in other programs, loaded from config.
 *      Only untagged servers; tagged ones go to their subagent.
 *
 * The agent does not care where a tool came from; it just gets one list.
 */
export async function buildToolRegistry(settings: Settings = getSettings(), mcpGroups?: McpGroups): Promise<ToolRegistry> {
  const registry = new ToolRegistry();
  if (settings.enable_builtin_tools) registry.registerMany(getBuiltinTools());
  const groups = mcpGroups ?? (await loadMcpGroups(settings));
  registry.registerMany(groups.get("") ?? []);
  return registry;
}

/** Tokens kept after summarizing, capped at half the trigger. */
export function summaryKeepTokens(settings: Settings): number {
  return Math.max(Math.min(settings.summary_keep_tokens, Math.floor(settings.summary_trigger_tokens / 2)), 1);
}

/**
 * LangGraph step backstop, set well above the model-call limit.
 *
 * Each model call costs several graph steps (model, tools, and one node per
 * middleware hook), so this leaves wide headroom and only triggers if the
 * middleware limits somehow fail.
 */
export function recursionLimit(settings: Settings): number {
  return settings.max_model_calls * 10 + 20;
}

/**
 * Middleware that runs around each model / tool call (in this order).
 *
 * - Run-limit reset: zeroes the per-message counters of the two loop limits
 *   at the start of each message (agent/limits.ts explains why).
 * - Task budget: one model-call allowance shared with every subagent
 *   (see agent/budget.ts).
 * - Loop limits: a ReAct loop can keep calling tools forever. After
 *   `max_model_calls` the run ends with a short "limit reached" message;
 *   after `max_tool_calls` further tool calls are refused, so the model
 *   answers with what it already has.
 * - Scratchpad: write_todos (plan) + write_note (facts), shown to the
 *   model on every call (see agent/scratchpad.ts).
 * - Long-term memory: pinned + matching memories shown on every call;
 *   the agent can only suggest changes (see agent/longterm.ts).
 * - Approval: `interruptOn` lists main-agent tools (risky MCP tools)
 *   that pause for the user's OK before running.
 * - Summarization: replaces old messages with a short summary so long
 *   threads don't grow forever. The scratchpad is state, not messages,
 *   so it survives this. It keeps a token amount (at most half the
 *   trigger) rather than a message count: if the kept messages alone
 *   passed the trigger, every model call would pay for a new summary.
 */
export function buildMiddleware(
  settings: Settings,
  model: BaseChatModel | null,
  interruptOn: Record<string, boolean> = {},
  memoryStore: LongTermStore | null = null,
): any[] {
  const middleware: any[] = [
    resetRunLimitsMiddleware(),
    taskBudgetMiddleware(),
    modelCallLimitMiddleware({ runLimit: settings.max_model_calls, exitBehavior: "end" }),
    toolCallLimitMiddleware({ runLimit: settings.max_tool_calls, exitBehavior: "continue" }),
    todoListMiddleware(),
    scratchpadMiddleware(),
  ];
  if (memoryStore) {
    middleware.push(
      longTermMemoryMiddleware(memoryStore, {
        recallLimit: settings.memory_recall_limit,
        maxChars: settings.memory_prompt_chars,
        maxSuggestions: settings.memory_max_suggestions,
      }),
    );
  }
  if (Object.keys(interruptOn).length) middleware.push(humanInTheLoopMiddleware({ interruptOn }));
  if (settings.summary_trigger_tokens > 0 && model) {
    middleware.push(
      summarizationMiddleware({
        model: model as never,
        trigger: { tokens: settings.summary_trigger_tokens },
        keep: { tokens: summaryKeepTokens(settings) },
      }),
    );
  }
  return middleware;
}

export interface BuiltAgent {
  agent: LunaAgent;
  registry: ToolRegistry;
}

/**
 * Create the runnable LangGraph agent and its tool registry.
 *
 *     const { agent } = await buildAgent();
 *     await runTask(agent, { messages: [{ role: "user", content: "Hi" }] },
 *                   { configurable: { thread_id: "default" } });
 */
export async function buildAgent(settings: Settings = getSettings(), memoryStore?: LongTermStore | null): Promise<BuiltAgent> {
  // 1) Brain — an OpenAI-compatible chat model from the configured
  // provider (OpenRouter, Groq or Ollama; see agent/providers.ts).
  const model = makeModel(settings);
  // 2) Notebook — stores message history per thread_id.
  const checkpointer = await createCheckpointer(settings.memory_backend, settings.checkpoint_path);
  // 3) Hands (part 1) — MCP tools are loaded once and split: untagged →
  // main agent, tagged → that subagent (see "agent" in config/mcp_servers.json).
  const mcpGroups = await loadMcpGroups(settings);
  // 4) Long-term memory — facts across threads. Pass `memoryStore` to keep
  // a handle (the CLI does, for /memory); otherwise it comes from settings.
  const store = memoryStore === undefined ? openLongtermStore(settings) : memoryStore;
  return assembleAgent(settings, model, checkpointer, mcpGroups, store);
}

/**
 * Wire an agent from parts that already exist.
 *
 * Cheap (no network, no files), so the web UI calls it again with a new
 * `model` to switch providers: same memory, same MCP connections, and every
 * helper and the summarizer switch along with the main agent.
 */
export async function assembleAgent(
  settings: Settings,
  model: BaseChatModel,
  checkpointer: BaseCheckpointSaver | null,
  mcpGroups: McpGroups,
  memoryStore: LongTermStore | null = null,
): Promise<BuiltAgent> {
  // 3) Hands (part 2) — all callable tools, plus one delegate tool per subagent.
  // Delegates are ordinary tools, so the model chooses between "do it myself"
  // and "hand it off" the same way it picks any other tool.
  const registry = await buildToolRegistry(settings, mcpGroups);
  registry.registerMany(getSubagentSpecs(settings, mcpGroups).map((spec) => makeDelegateTool(spec, model)));

  // 4) Middleware — budget, loop limits, scratchpad, long-term memory,
  // approval, summarization. Main-agent MCP tools that change things
  // (send_*, delete_*, …) need approval.
  const risky = (mcpGroups.get("") ?? []).map((t) => t.name).filter(isRiskyToolName);
  const middleware = buildMiddleware(settings, model, needsApproval(risky, settings.auto_approve), memoryStore);

  // 5) Wire everything into one agent graph. createAgent already implements
  // the "think → tool → think → answer" loop.
  const agent = createAgent({
    model: model as never,
    tools: registry.listTools() as never,
    // Role + speaking style + user profile (agent/persona.ts).
    systemPrompt: buildSystemPrompt(settings),
    ...(checkpointer ? { checkpointer } : {}),
    middleware: middleware as never,
    name: "luna",
  }) as unknown as LunaAgent;
  return { agent, registry };
}
