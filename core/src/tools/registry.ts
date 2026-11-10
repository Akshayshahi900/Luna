/**
 * ToolRegistry — a shopping bag that holds every tool for the agent.
 *
 * BEGINNER MAP
 * ------------
 * Luna can get tools from different places (builtin TypeScript functions,
 * MCP servers, maybe more later). The agent wants ONE flat list.
 *
 * This class is that list, with helpers:
 *   register(tool)       → add one
 *   registerMany([...])  → add many
 *   listTools()          → give them to createAgent(...)
 *   names()              → pretty list for the /tools CLI command
 *
 * If two tools share the same name, the newest one wins (last writer wins).
 *
 * How to add a native tool:
 *   1. Write a tool() in tools/builtin/
 *   2. Put it in getBuiltinTools()
 *   3. Restart Luna
 *
 * How to add an MCP server:
 *   1. Edit config/mcp_servers.json
 *   2. Restart Luna
 */

import type { StructuredToolInterface } from "@langchain/core/tools";

export type AnyTool = StructuredToolInterface;

/** Simple in-memory collection of LangChain tools. */
export class ToolRegistry {
  #tools: AnyTool[] = [];

  /** Add one tool. Replaces any existing tool with the same name. */
  register(tool: AnyTool): void {
    if (!tool?.name) throw new TypeError("Cannot determine tool name");
    this.#tools = this.#tools.filter((t) => t.name !== tool.name);
    this.#tools.push(tool);
  }

  /** Register several tools in order. */
  registerMany(tools: Iterable<AnyTool>): void {
    for (const tool of tools) this.register(tool);
  }

  /** A copy of the tool list (safe to pass to createAgent). */
  listTools(): AnyTool[] {
    return [...this.#tools];
  }

  /** Sorted tool names — handy for printing. */
  names(): string[] {
    return this.#tools.map((t) => t.name).sort();
  }

  /** Remove every registered tool. */
  clear(): void {
    this.#tools = [];
  }
}
