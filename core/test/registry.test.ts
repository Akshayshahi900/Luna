import { tool } from "@langchain/core/tools";
import { expect, test } from "vitest";
import * as z from "zod";

import { type AnyTool, ToolRegistry } from "../src/tools/registry.ts";

const make = (name: string, reply: string) =>
  tool(async () => reply, { name, description: "Test tool.", schema: z.object({}) }) as unknown as AnyTool;

test("register and list", () => {
  const registry = new ToolRegistry();
  registry.registerMany([make("b", "1"), make("a", "2")]);
  expect(registry.names()).toEqual(["a", "b"]);
  expect(registry.listTools()).toHaveLength(2);
});

test("last writer wins", async () => {
  const registry = new ToolRegistry();
  registry.register(make("dup", "old"));
  registry.register(make("dup", "new"));
  const [only] = registry.listTools();
  expect(registry.listTools()).toHaveLength(1);
  expect(await only.invoke({})).toBe("new");
});

test("clear", () => {
  const registry = new ToolRegistry();
  registry.register(make("x", "1"));
  registry.clear();
  expect(registry.names()).toEqual([]);
  expect(registry.listTools()).toEqual([]);
});
