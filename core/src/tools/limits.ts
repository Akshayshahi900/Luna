/**
 * capOutput — stop one tool result from flooding the model's context.
 *
 * Web pages, file contents and command output can be huge. Wrapping a tool
 * with capOutput() keeps its name, description and arguments, but cuts the
 * result to `maxChars` and says so, so the model knows to ask for less
 * (e.g. a narrower query or a line range).
 */

import { tool } from "@langchain/core/tools";

import type { AnyTool } from "./registry.ts";

/** Any tool result as text (objects become JSON). */
export function asText(result: unknown): string {
  if (typeof result === "string") return result;
  if (result && typeof result === "object" && "content" in result && typeof (result as { content: unknown }).content === "string") {
    return (result as { content: string }).content; // a ToolMessage
  }
  try {
    return JSON.stringify(result) ?? String(result);
  } catch {
    return String(result);
  }
}

/** A copy of `inner` whose results are at most `maxChars` long. */
export function capOutput(inner: AnyTool, maxChars = 8000): AnyTool {
  const capped = tool(
    async (args: Record<string, unknown>, config) => {
      const text = asText(await inner.invoke(args, config));
      if (text.length <= maxChars) return text;
      const dropped = text.length - maxChars;
      return `${text.slice(0, maxChars)}\n…[truncated ${dropped} characters]`;
    },
    { name: inner.name, description: inner.description, schema: inner.schema as never },
  );
  capped.metadata = (inner as { metadata?: Record<string, unknown> }).metadata;
  return capped as unknown as AnyTool;
}
