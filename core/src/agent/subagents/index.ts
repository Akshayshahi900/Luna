/**
 * Subagents — helper agents wrapped as delegate tools.
 *
 *   base.ts        SubagentSpec + makeDelegateTool (how a subagent runs)
 *   researcher.ts  web research (Tavily)
 *   files.ts       read / search / write files in the workspace
 *   coder.ts       code changes + running commands in the workspace
 *   assistant.ts   personal tasks through MCP servers tagged "agent": "assistant"
 *
 * getSubagentSpecs() decides which subagents are switched on: each spec
 * function returns null when what it needs (API key, MCP server, …) is missing.
 */

import type { Settings } from "../../config/settings.ts";
import { isRiskyToolName } from "../../mcp/loader.ts";
import type { AnyTool } from "../../tools/registry.ts";
import { assistantSpec } from "./assistant.ts";
import { needsApproval, type SubagentSpec } from "./base.ts";
import { coderSpec } from "./coder.ts";
import { filesSpec } from "./files.ts";
import { researcherSpec } from "./researcher.ts";

export { isDelegate, makeDelegateTool, needsApproval, PARENT_CALL_METADATA, type SubagentSpec, subagentSpec } from "./base.ts";

/** MCP tools grouped by the server's "agent" tag ("" = the main agent). */
export type McpGroups = Map<string, AnyTool[]>;

/**
 * Every subagent whose requirements are met, in a stable order.
 *
 * `mcpGroups` maps an MCP "agent" tag to its tools. "assistant" tools create
 * the assistant; any other tag adds tools to the subagent of that name (e.g.
 * "researcher" → ask_researcher), with approval for risky names.
 */
export function getSubagentSpecs(settings: Settings, mcpGroups: McpGroups = new Map()): SubagentSpec[] {
  const candidates = [
    researcherSpec(settings),
    filesSpec(settings),
    coderSpec(settings),
    assistantSpec(settings, mcpGroups.get("assistant") ?? []),
  ];
  const specs = candidates.filter((s): s is SubagentSpec => s !== null);

  const byTag = new Map(specs.map((s) => [s.name.replace(/^ask_/, ""), s]));
  for (const [tag, tools] of mcpGroups) {
    if (tag === "" || tag === "assistant" || !tools.length) continue;
    const spec = byTag.get(tag);
    if (!spec) {
      console.error(
        `Warning: MCP servers tagged agent='${tag}' have no matching helper ` +
          `(known: ${[...byTag.keys()].sort().join(", ")}). Their tools are not used.`,
      );
      continue;
    }
    const risky = tools.map((t) => t.name).filter(isRiskyToolName);
    spec.tools = [...spec.tools, ...tools];
    spec.interruptOn = { ...spec.interruptOn, ...needsApproval(risky, settings.auto_approve) };
  }
  return specs;
}
