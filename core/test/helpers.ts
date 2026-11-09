/**
 * Shared test helpers: a fake chat model so tests never call OpenRouter.
 * (Port of the Python tests/conftest.py.)
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, AIMessageChunk, type BaseMessage } from "@langchain/core/messages";
import { ChatGenerationChunk, type ChatResult } from "@langchain/core/outputs";

type Reply = AIMessage | string;

/**
 * A chat model that returns canned replies and accepts bindTools (needed by
 * createAgent).
 *
 * Each call records `received` (message count), `systemPrompts` (system
 * prompt text) and `inputs` (every message's text), so tests can check what
 * context the model saw.
 */
export class FakeToolModel extends BaseChatModel {
  received: number[] = [];
  systemPrompts: string[] = [];
  inputs: string[][] = [];
  #replies: Iterator<AIMessage>;

  constructor(replies: Iterator<AIMessage>) {
    super({});
    this.#replies = replies;
  }

  _llmType(): string {
    return "fake-tool-model";
  }

  bindTools(): this {
    return this;
  }

  /** Same model for withConfig/bind calls made by createAgent. */
  withConfig(): this {
    return this;
  }

  #next(messages: BaseMessage[]): AIMessage {
    this.received.push(messages.length);
    this.inputs.push(messages.map((m) => m.text));
    const first = messages[0];
    this.systemPrompts.push(first && first.type === "system" ? first.text : "");
    const next = this.#replies.next();
    if (next.done) throw new Error("FakeToolModel ran out of replies");
    // A fresh copy: LangGraph's reducer gives messages ids in place.
    const m = next.value;
    return new AIMessage({ content: m.content, tool_calls: m.tool_calls ?? [] });
  }

  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const message = this.#next(messages);
    return { generations: [{ message, text: message.text }] };
  }

  async *_streamResponseChunks(
    messages: BaseMessage[],
    _options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    // Emit each canned reply as a single chunk (tool calls included).
    const message = this.#next(messages);
    const chunk = new AIMessageChunk({
      content: message.content,
      tool_call_chunks: (message.tool_calls ?? []).map((c, index) => ({
        name: c.name,
        args: JSON.stringify(c.args),
        id: c.id,
        index,
        type: "tool_call_chunk" as const,
      })),
    });
    const text = typeof message.content === "string" ? message.content : "";
    if (runManager && text) await runManager.handleLLMNewToken(text, undefined, undefined, undefined, undefined, { chunk: new ChatGenerationChunk({ message: chunk, text }) });
    yield new ChatGenerationChunk({ message: chunk, text });
  }
}

function asMessage(reply: Reply): AIMessage {
  return typeof reply === "string" ? new AIMessage(reply) : reply;
}

/** A model that gives these replies, in order. */
export function fakeModel(...replies: Reply[]): FakeToolModel {
  return new FakeToolModel(replies.map(asMessage)[Symbol.iterator]());
}

/** An AI message that asks to run one tool. */
export function toolCall(name: string, callId = "c1", args: Record<string, unknown> = {}): AIMessage {
  return new AIMessage({ content: "", tool_calls: [{ name, args, id: callId, type: "tool_call" }] });
}

/** A model that calls the same tool forever — for testing loop limits. */
export function loopingModel(name = "calculator", args: Record<string, unknown> = {}): FakeToolModel {
  if (name === "calculator" && !Object.keys(args).length) args = { expression: "2+2" };
  // A new message (and call id) each time: reusing one object would make
  // LangGraph treat every repeat as an update of the same message.
  function* replies() {
    for (let i = 0; ; i++) yield toolCall(name, `c${i}`, args);
  }
  return new FakeToolModel(replies());
}

/** A fresh temporary folder. */
export function tmpDir(prefix = "luna-test-"): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

/** What a fake Google API does for an unknown id. */
export function missing(kind: string, key: string): never {
  throw new Error(`Google API error 404: no ${kind} ${key}`);
}
