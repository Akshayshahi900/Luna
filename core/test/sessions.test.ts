import path from "node:path";

import { createAgent } from "langchain";
import { expect, test } from "vitest";

import { closeCheckpointers, createCheckpointer } from "../src/agent/memory.ts";
import { deleteSession, listSessions, resolveSession } from "../src/agent/sessions.ts";
import type { LunaAgent } from "../src/agent/types.ts";
import { type FakeToolModel, fakeModel, tmpDir } from "./helpers.ts";

const agentWith = (model: FakeToolModel, checkpointer: unknown) =>
  createAgent({ model: model as never, tools: [], checkpointer: checkpointer as never }) as unknown as LunaAgent;
const ask = (text: string) => ({ messages: [{ role: "user", content: text }] });

test("sqlite history survives a restart", async () => {
  const db = path.join(tmpDir(), "mem.sqlite");
  const config = { configurable: { thread_id: "t1" } };
  let saver = await createCheckpointer("sqlite", db);
  await agentWith(fakeModel("hi Ada"), saver).invoke(ask("I am Ada"), config);
  await closeCheckpointers();
  // Fresh connection to the same file → the previous turn is still there.
  saver = await createCheckpointer("sqlite", db);
  const result = await agentWith(fakeModel("you are Ada"), saver).invoke(ask("who am I?"), config);
  expect(result.messages.map((m: { content: unknown }) => m.content)).toEqual(["I am Ada", "hi Ada", "who am I?", "you are Ada"]);
  await closeCheckpointers();
});

test("sessions: list, titles, resolve and delete", async () => {
  for (const backend of ["memory", "sqlite"]) {
    const saver = await createCheckpointer(backend, path.join(tmpDir(), "s.sqlite"));
    const agent = agentWith(fakeModel("a", "b", "c"), saver);
    for (const [tid, text] of [["aaa-1", "first   question"], ["bbb-2", "x".repeat(80)], ["aaa-1", "follow up"]]) {
      await agent.invoke(ask(text), { configurable: { thread_id: tid } });
    }
    const sessions = await listSessions(saver);
    expect(sessions.map((s) => s.id)).toEqual(["aaa-1", "bbb-2"]); // aaa-1 used last
    expect(sessions[0].title).toBe("first question");
    expect(sessions[0].turns).toBe(2);
    expect([...sessions[1].title]).toHaveLength(60);
    expect(sessions[1].title.endsWith("…")).toBe(true);

    expect(resolveSession("2", sessions)).toBe("bbb-2");
    expect(resolveSession("bbb", sessions)).toBe("bbb-2"); // id prefix
    expect(resolveSession("aaa-1", sessions)).toBe("aaa-1");
    expect(resolveSession("9", sessions)).toBeNull();
    expect(resolveSession("zzz", sessions)).toBeNull();

    await deleteSession(saver, "aaa-1");
    expect((await listSessions(saver)).map((s) => s.id)).toEqual(["bbb-2"]);
  }
  await closeCheckpointers();
});
