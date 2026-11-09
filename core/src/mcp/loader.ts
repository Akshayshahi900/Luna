/**
 * Load tools from MCP servers and turn them into LangChain tools.
 *
 * BEGINNER MAP
 * ------------
 * MCP = Model Context Protocol.
 *
 * Think of it as a USB standard for AI tools:
 *   - An MCP *server* is a small program that exposes tools.
 *   - An MCP *client* (here: LangChain's MultiServerMCPClient) plugs in and
 *     asks "what tools do you have?" then can call them.
 *
 * Why bother?
 *   So Luna can use tools written by other people / other processes
 *   without copying their code into this repo.
 *
 * Config file (default: config/mcp_servers.json):
 *
 *     {
 *       "mcpServers": {
 *         "demo": {
 *           "command": "node",
 *           "args": ["core/servers/demo.ts"]
 *         }
 *       }
 *     }
 *
 * That entry means: "start this command as a subprocess and talk to it."
 * You can also use {"url": "https://..."} for remote HTTP MCP servers.
 *
 * Add "agent": "<name>" to a server to give its tools to that subagent
 * instead of the main agent, e.g. "agent": "assistant" for calendar / mail
 * servers (see splitByAgent below).
 *
 * The client keeps each stdio server running until Luna exits
 * (closeMcpClients). Tool names are the server's own; only when two servers
 * of one group export the same name does the second become
 * `<server>_<name>` (routines/builtin.ts findTool knows both forms).
 *
 * Disable with LUNA_ENABLE_MCP_TOOLS=false.
 *
 * Read next: servers/demo.ts (a tiny MCP server example).
 */

import { existsSync, readFileSync } from "node:fs";

import { MultiServerMCPClient } from "@langchain/mcp-adapters";

import { PROJECT_ROOT } from "../config/settings.ts";
import type { AnyTool } from "../tools/registry.ts";

export type ServerConfig = Record<string, unknown>;
export interface McpConfig {
  mcpServers: Record<string, ServerConfig>;
  [key: string]: unknown;
}

/** Read mcp_servers.json. Return null if missing or has no servers. Throws on invalid JSON. */
export function loadMcpConfig(file: string): McpConfig | null {
  if (!existsSync(file)) return null;
  const data = JSON.parse(readFileSync(file, "utf8")) as Partial<McpConfig>;
  // "disabled": true (set from the Control Center) keeps an entry without loading it.
  const servers: Record<string, ServerConfig> = {};
  for (const [name, server] of Object.entries(data.mcpServers ?? {})) {
    if (server?.disabled) continue;
    const { disabled: _disabled, ...rest } = server;
    servers[name] = rest;
  }
  if (!Object.keys(servers).length) return null;
  // Relative paths in "args" (e.g. core/servers/demo.ts) mean "from the
  // project root", so run stdio servers there unless the entry sets its own cwd.
  for (const server of Object.values(servers)) {
    if ("command" in server && server.cwd === undefined) server.cwd = PROJECT_ROOT;
  }
  return { ...data, mcpServers: servers };
}

/**
 * Group servers by their optional "agent" tag.
 *
 * `{"mcpServers": {"gcal": {..., "agent": "assistant"}, "docs": {...}}}`
 * becomes `{"assistant": {"mcpServers": {"gcal": ...}}, "": {"mcpServers": {"docs": ...}}}`.
 * Untagged servers (key "") belong to the main agent; a tag names the
 * subagent that gets those tools (e.g. "assistant" → ask_assistant).
 * The tag itself is removed before the config reaches the MCP client.
 */
export function splitByAgent(config: McpConfig): Map<string, McpConfig> {
  const groups = new Map<string, McpConfig>();
  for (const [name, server] of Object.entries(config.mcpServers ?? {})) {
    const { agent, ...rest } = server;
    const key = typeof agent === "string" ? agent : "";
    if (!groups.has(key)) groups.set(key, { mcpServers: {} });
    groups.get(key)!.mcpServers[name] = rest;
  }
  return groups;
}

// Words in a tool name that mean it changes something outside Luna.
const RISKY_WORDS = new Set([
  "send", "create", "update", "delete", "remove", "write", "edit", "post", "reply",
  "cancel", "move", "modify", "insert", "upload", "archive", "add", "set", "submit",
  "invite", "share", "trash", "patch", "put", "rename", "forward",
]);

/**
 * True if the tool name contains a word like send/create/delete.
 *
 * Names are split on _ - . and camelCase, so 'send_email' and 'createEvent'
 * are risky but 'get_settings' is not.
 */
export function isRiskyToolName(name: string): boolean {
  const words = name.split(/[_\-.\s]+|(?<=[a-z0-9])(?=[A-Z])/);
  return words.some((word) => word && RISKY_WORDS.has(word.toLowerCase()));
}

/** Our config entry → the MCP client's connection format. */
function toConnection(server: ServerConfig): Record<string, unknown> {
  if (typeof server.url === "string") {
    const transport = server.transport === "sse" ? "sse" : "http";
    return { ...server, transport };
  }
  return { transport: "stdio", ...server, args: (server.args as string[] | undefined) ?? [] };
}

const OPEN_CLIENTS = new Set<MultiServerMCPClient>();

/**
 * Connect to the MCP server(s) of one group and return LangChain tools.
 *
 * `config` is a path to JSON or an already-parsed config. Empty list if there
 * is nothing to connect to. Throws when a server can't be reached; the
 * client is closed again in that case.
 */
export async function loadMcpTools(config: McpConfig | string | null): Promise<AnyTool[]> {
  if (config === null) return [];
  const target = typeof config === "string" ? loadMcpConfig(config) : config;
  if (!target || !Object.keys(target.mcpServers).length) return [];

  const connections = Object.fromEntries(Object.entries(target.mcpServers).map(([name, s]) => [name, toConnection(s)]));
  const client = new MultiServerMCPClient({
    mcpServers: connections,
    throwOnLoadError: true,
    onConnectionError: "throw",
    prefixToolNameWithServerName: false,
  } as never);
  try {
    const toolsets = await client.listToolsets();
    OPEN_CLIENTS.add(client);
    const tools: AnyTool[] = [];
    const seen = new Set<string>();
    for (const [server, list] of Object.entries(toolsets)) {
      for (const tool of list as unknown as AnyTool[]) {
        if (seen.has(tool.name)) (tool as { name: string }).name = `${server}_${tool.name}`;
        seen.add(tool.name);
        tools.push(tool);
      }
    }
    return tools;
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
}

/** Stop every MCP server Luna started. Call once when the app exits (or before reloading). */
export async function closeMcpClients(): Promise<void> {
  const clients = [...OPEN_CLIENTS];
  OPEN_CLIENTS.clear();
  await Promise.all(clients.map((c) => c.close().catch(() => undefined)));
}
