/**
 * Example MCP *server* — a tiny separate program that exposes tools.
 *
 * BEGINNER MAP
 * ------------
 * This file is NOT imported into the Luna agent as normal code.
 *
 * Instead, when config/mcp_servers.json says:
 *
 *   "command": "node", "args": ["core/servers/demo.ts"]
 *
 * Luna starts this script as another process and talks to it over stdio
 * (standard input/output) using the MCP protocol.
 *
 * server.registerTool() is like LangChain's tool(), but for an MCP server:
 * it publishes the function so clients can discover and call it.
 *
 * Try it alone (it waits for MCP messages on stdin):
 *
 *     node core/servers/demo.ts
 *
 * In Luna, after startup, /tools should list reverse_text and word_count
 * (unless MCP is disabled).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod";

import { runStdio, text } from "./common.ts";

// Create a named MCP server. Clients see this name when they connect.
export function createServer(): McpServer {
  const server = new McpServer({ name: "luna-demo", version: "1.0.0" });

  server.registerTool(
    "reverse_text",
    { description: "Reverse a string and return it.", inputSchema: { text: z.string() } },
    async ({ text: value }) => text([...value].reverse().join("")),
  );

  server.registerTool(
    "word_count",
    { description: "Count whitespace-separated words in text.", inputSchema: { text: z.string() } },
    async ({ text: value }) => text(String(value.split(/\s+/).filter(Boolean).length)),
  );

  return server;
}

// stdio = talk through stdin/stdout (what MCP clients expect for local tools).
if (import.meta.main) await runStdio(createServer(), new StdioServerTransport());
