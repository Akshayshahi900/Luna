/**
 * Small helpers shared by Luna's MCP servers (demo, tasks, mail, google).
 *
 * A tool answer is MCP "content": a list of blocks. Luna's tools return
 * one text block — plain text, or JSON text for structured results, which
 * the model and the routines (routines/builtin.ts decodeToolOutput) read.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

export interface ToolText {
  content: { type: "text"; text: string }[];
  isError?: boolean;
  [key: string]: unknown;
}

/** One text block. */
export function text(value: string): ToolText {
  return { content: [{ type: "text", text: value }] };
}

/** A structured result as JSON text (like FastMCP returning a dict or list). */
export function json(value: unknown): ToolText {
  return text(JSON.stringify(value));
}

/** A failed call: the model sees the message and can correct itself. */
export function toolError(message: string): ToolText {
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * Run a tool body; a thrown Error becomes an error result instead of
 * crashing the server (like FastMCP's ToolError / ValueError handling).
 */
export async function guarded(run: () => unknown | Promise<unknown>): Promise<ToolText> {
  try {
    const result = await run();
    return typeof result === "string" ? text(result) : json(result);
  } catch (error) {
    return toolError(error instanceof Error ? error.message : String(error));
  }
}

/** Serve over stdio until the client goes away. */
export async function runStdio(server: McpServer, transport: Transport): Promise<void> {
  await server.connect(transport);
}
