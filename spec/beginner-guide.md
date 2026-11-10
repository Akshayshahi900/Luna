# Luna for Beginners — How This Chatbot Works

Read this if the project feels like a black box. No prior LangGraph knowledge assumed.

---

## The 30-second idea

You type a message → Luna sends it to a **language model** (the “brain”) → the model can either:

1. **Answer directly**, or  
2. **Call a tool** (a small TypeScript function: calculator, clock, MCP tools, …) and then answer using the result.

Past messages are **remembered** using a memory system called a **checkpointer**, so Luna can refer to earlier turns in the same chat.

```
You type ──► CLI ──► Agent (LangGraph) ──► Model (OpenRouter)
                         │                      │
                         │                      └── maybe calls tools
                         └── saves/loads chat history (memory)
```

All of Luna's backend is TypeScript in `core/`. Node runs the `.ts` files
directly, so there is no build step: edit a file, run it again.

---

## Words you will see (glossary)

| Word | Plain meaning |
| --- | --- |
| **LLM / model** | The AI that generates replies (here: a model accessed through OpenRouter) |
| **Agent** | A loop: model thinks → maybe uses tools → thinks again → finally replies |
| **LangGraph** | Library that runs that loop as a graph (nodes = steps) |
| **Tool** | A normal TypeScript function the model is allowed to call |
| **MCP** | A standard way for tools to live in *other programs* (servers). Luna connects to them instead of rewriting every tool itself |
| **Checkpointer / memory** | Saves the chat transcript between turns |
| **thread_id** | A chat-room ID. Same ID = same memory. New ID = blank conversation |
| **async / await** | JavaScript’s way of waiting for slow I/O (network, MCP) without freezing everything |
| **Settings** | Config values (model name, memory type, …) from code defaults or `LUNA_*` environment variables |
| **zod** | A small library that describes the shape of data (a tool's arguments, for example) |

---

## What happens when you run `pnpm luna`

1. pnpm runs `node core/bin/luna.ts`, which calls `main()` in `core/src/cli/chat.ts`.
2. `main` calls `runChat()`.
3. `runChat` calls `buildAgent()` which:
   - loads settings
   - creates the OpenRouter chat model
   - creates memory (SQLite or in-RAM)
   - collects tools (built-in + MCP)
   - builds one LangGraph agent with all of that
4. You get a `You:` prompt.
5. Each message you send goes to `runTask(agent, ...)` with your `thread_id`.
6. LangGraph loads prior messages for that thread, runs the agent loop, saves the new state, and streams the reply.

---

## Folder map (start here)

```
Luna/
├── README.md                 ← how to run
├── package.json              ← pnpm luna / web / google-auth / setup
├── .env.example              ← copy to .env for settings
├── spec/
│   ├── spec1.md              ← what was built (design notes)
│   └── beginner-guide.md     ← THIS FILE
├── config/
│   └── mcp_servers.json      ← which MCP tool-servers to connect
└── core/                     ← the actual app
    ├── bin/luna.ts           ← entry point → starts the chat CLI
    ├── servers/
    │   ├── demo.ts           ← tiny example MCP server (2 tools)
    │   └── tasks.ts          ← to-dos for the assistant (synced with Google Tasks)
    ├── test/                 ← tests (a fake model, so no API key needed)
    └── src/
        ├── cli/chat.ts       ← the interactive chat loop (You: / Luna:)
        ├── config/settings.ts← all knobs (model, memory, MCP on/off)
        ├── agent/
        │   ├── builder.ts    ← assembles model + memory + tools
        │   └── memory.ts     ← creates the checkpointer
        ├── tools/
        │   ├── registry.ts   ← shopping bag that holds all tools
        │   └── builtin/      ← tools written in this repo
        └── mcp/loader.ts     ← reads MCP config and loads remote tools
```

**Suggested reading order**

1. `cli/chat.ts` — you already understand chat apps  
2. `agent/builder.ts` — where pieces are glued together  
3. `tools/builtin/` — simplest tools  
4. `tools/registry.ts` — how tools are collected  
5. `agent/memory.ts` — how memory works  
6. `mcp/loader.ts` + `core/servers/demo.ts` — external tools  
7. `config/settings.ts` — how to change behavior without editing logic  

Every file starts with a "BEGINNER MAP" comment that says what it does
and what to read next.

---

## File-by-file walkthrough

### 1. `core/src/cli/chat.ts` — the chat window

This is the only file that talks to *you* directly.

- Prints `You:` and waits for input.
- If you type `/tools`, `/new`, `/quit`, etc., it handles those locally (no AI).
- Otherwise it sends your text to the agent:

```ts
await runTask(
  agent,
  { messages: [{ role: "user", content: userInput }] },
  { configurable: { thread_id: threadId } },
  { budget, onEvent: printer.handle },
);
```

**Why `thread_id`?**  
Memory is stored per thread (a "session"). Same thread → Luna remembers. Every start makes a new UUID so history starts fresh; `/sessions` + `/resume <n>` (or `pnpm luna --resume`) continue an old one.

**Why `await`?**  
Calling the model and tools takes time. `await` means “wait for that work to finish.”

---

### 2. `core/src/agent/builder.ts` — the assembly line

Think of this as a recipe:

| Ingredient | Where it comes from |
| --- | --- |
| Brain (LLM) | `makeModel(settings)` → `new ChatOpenAI({ model, configuration: { baseURL } })` |
| Memory | `createCheckpointer(...)` |
| Tools | `buildToolRegistry(...)` |
| Personality | `buildSystemPrompt(settings)` |

Then:

```ts
const agent = createAgent({
  model,
  tools: registry.listTools(),
  systemPrompt: buildSystemPrompt(settings),
  checkpointer,
  middleware,
});
```

`createAgent` (from LangChain) builds a LangGraph that already knows how to:

- call the model
- detect “I want to use a tool”
- run the tool
- feed the result back to the model
- stop when the model gives a final answer

You do **not** need to write that loop yourself.

---

### 3. `core/src/agent/memory.ts` — remembering chats

Two modes:

| Backend | Setting | Behavior |
| --- | --- | --- |
| SQLite file | `LUNA_MEMORY_BACKEND=sqlite` | Saved on disk (`data/luna_checkpoints.sqlite`) → survives restart |
| RAM | `LUNA_MEMORY_BACKEND=memory` | Forgotten when the process exits |

The object returned is a **checkpointer**. LangGraph asks it:

- “Give me the history for `thread_id=default`”
- “Save the updated history for `thread_id=default`”

You never manually append to a `conversationHistory` list (unlike a simple chatbot tutorial). The checkpointer does that.

---

### 4. `core/src/tools/builtin/` — tools inside this project

A tool is a normal function wrapped with `tool()`:

```ts
import { tool } from "@langchain/core/tools";
import * as z from "zod";

export const echo = tool(async ({ message }) => message, {
  name: "echo",
  description: "Echo back a message.",
  schema: z.object({ message: z.string().describe("What to echo.") }),
});
```

Important details for beginners:

- The **description** is not just for humans — the *model* reads it to decide when to call the tool.
- The zod `schema` becomes the tool’s input schema (`.describe()` explains each argument).
- `getBuiltinTools()` returns the list that gets registered.

**How to add your own tool (easiest path)**

1. Write a new `tool(...)` in `builtin/index.ts`.
2. Add it to the list in `getBuiltinTools()`.
3. Restart `pnpm luna`.
4. Type `/tools` — your tool name should appear.
5. Ask something that needs it.

---

### 5. `core/src/tools/registry.ts` — the tool shopping bag

`ToolRegistry` is a simple container:

- `register(tool)` — add one tool  
- `registerMany([...])` — add several  
- `listTools()` — give them all to the agent  
- `names()` — used by `/tools` in the CLI  

Built-in tools and MCP tools both end up here so the agent sees **one** list.

---

### 6. `core/src/mcp/loader.ts` — tools from other programs

**MCP** = Model Context Protocol.

Analogy:

- Built-in tools = apps installed on your phone  
- MCP tools = apps on another phone that your phone can call over a standard cable  

`config/mcp_servers.json` lists those other programs. By default it
connects the demo server below, the to-do, mail and calendar servers for
the assistant helper (`core/servers/tasks.ts`, `mail.ts`, `google.ts`) and
the LangChain docs server for the researcher. The smallest possible config
looks like this:

```json
{
  "mcpServers": {
    "demo": {
      "command": "node",
      "args": ["core/servers/demo.ts"]
    }
  }
}
```

Add `"agent": "assistant"` (or `"researcher"`, `"files"`, `"coder"`) to a
server to give its tools to that helper instead of the main agent — see
`spec/spec3.md`.

What `loadMcpTools` does:

1. Read that JSON.
2. Connect using LangChain’s `MultiServerMCPClient`.
3. Ask each server: “What tools do you have?”
4. Convert them into normal LangChain tools.
5. Return the list (then the registry adds them).

You can turn this off with `LUNA_ENABLE_MCP_TOOLS=false`.

---

### 7. `core/servers/demo.ts` — a tiny external tool server

This is a **separate program**. When Luna starts, it launches this script and talks to it over stdin/stdout.

```ts
server.registerTool(
  "reverse_text",
  { description: "Reverse a string and return it.", inputSchema: { text: z.string() } },
  async ({ text: value }) => text([...value].reverse().join("")),
);
```

Same idea as `tool()`, but the function lives in another process. That is useful when tools are written by someone else, need isolation, or talk to private APIs. (An MCP server can be written in any language: Luna only sees the protocol.)

---

### 8. `core/src/config/settings.ts` — the control panel

Instead of hard-coding values everywhere, settings live in one place.

Examples:

```bash
LUNA_MODEL_NAME=llama3.2:latest pnpm luna
LUNA_MEMORY_BACKEND=memory pnpm luna
LUNA_ENABLE_MCP_TOOLS=false pnpm luna
```

Or put the same keys in a `.env` file (see `.env.example`).

Prefix is always `LUNA_`.

---

## One full turn (step by step)

Suppose you type: `What is (3+5)*12?` on thread `default`.

1. CLI packages your text as a user message.
2. LangGraph loads prior messages for `default` from the checkpointer.
3. Model sees system prompt + history + your question + available tools.
4. Model decides to call `calculator` with `expression="(3+5)*12"`.
5. LangGraph runs that TypeScript function → gets `"96"`.
6. Model gets the tool result and writes a final answer like “96”.
7. Checkpointer saves the whole exchange under `default`.
8. CLI prints the final answer.

Next turn, if you ask “double that”, the model can see “96” in history (same `thread_id`).

---

## Mental model: what is *not* magic

| Feels magical | Actually is |
| --- | --- |
| “Memory” | Saved message list keyed by `thread_id` |
| “Agent” | Loop: model ↔ tools until done |
| “MCP” | Another program exposing functions over a protocol |
| “LangGraph” | Orchestrator that runs that loop and saves state |

---

## Common beginner experiments

1. **Prove memory works**  
   Say “My name is Ada.” Then ask “What is my name?”  
   Then `/new` and ask again — it should forget.

2. **Prove tools work**  
   Ask for the time in `Asia/Kolkata`.  
   Ask `(100-8)/4`.  
   Type `/tools` to see names.

3. **Turn MCP off**  
   With the demo server in `config/mcp_servers.json` (it is by default), run  
   `LUNA_ENABLE_MCP_TOOLS=false pnpm luna`  
   `/tools` should no longer show `reverse_text` / `word_count`.

4. **Add a silly tool**  
   Add a `shout` tool (`async ({ text }) => text.toUpperCase()`) to the builtins, register it, restart, ask Luna to shout something.

5. **Run the tests**  
   `pnpm test` runs the whole backend suite with a fake model: no API key, no cost.

---

## If you get stuck

| Symptom | Likely cause |
| --- | --- |
| Authentication error when chatting | Set `LUNA_OPENROUTER_API_KEY` in `.env` and check the key is valid |
| MCP tools missing | Config empty, MCP disabled, server failed to start, or the server is tagged for a helper |
| Forgets everything after restart | Using `memory` backend instead of `sqlite` |
| Forgets after `/new` | Expected — new `thread_id` |
| `SyntaxError` about types when starting | Node is older than 22.18: update Node |

---

## Next reading

- Design / decisions: [`spec1.md`](spec1.md) (later specs up to [`spec12.md`](spec12.md): the web Control Center, routines, the app window, the website, Telegram and the move to TypeScript)
- Quick start: [`../README.md`](../README.md)
- Official LangChain agents (JavaScript): https://docs.langchain.com/oss/javascript/langchain/agents
- MCP in LangChain (JavaScript): https://docs.langchain.com/oss/javascript/langchain/mcp
