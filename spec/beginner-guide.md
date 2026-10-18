# Luna for Beginners — How This Chatbot Works

Read this if the project feels like a black box. No prior LangGraph knowledge assumed.

---

## The 30-second idea

You type a message → Luna sends it to a **language model** (the “brain”) → the model can either:

1. **Answer directly**, or  
2. **Call a tool** (a small Python function: calculator, clock, MCP tools, …) and then answer using the result.

Past messages are **remembered** using a memory system called a **checkpointer**, so Luna can refer to earlier turns in the same chat.

```
You type ──► CLI ──► Agent (LangGraph) ──► Model (OpenRouter)
                         │                      │
                         │                      └── maybe calls tools
                         └── saves/loads chat history (memory)
```

---

## Words you will see (glossary)

| Word | Plain meaning |
| --- | --- |
| **LLM / model** | The AI that generates replies (here: a model accessed through OpenRouter) |
| **Agent** | A loop: model thinks → maybe uses tools → thinks again → finally replies |
| **LangGraph** | Library that runs that loop as a graph (nodes = steps) |
| **Tool** | A normal Python function the model is allowed to call |
| **MCP** | A standard way for tools to live in *other programs* (servers). Luna connects to them instead of rewriting every tool itself |
| **Checkpointer / memory** | Saves the chat transcript between turns |
| **thread_id** | A chat-room ID. Same ID = same memory. New ID = blank conversation |
| **async / await** | Python’s way of waiting for slow I/O (network, MCP) without freezing everything |
| **Settings** | Config values (model name, memory type, …) from code defaults or `LUNA_*` environment variables |

---

## What happens when you run `uv run luna`

1. Python starts `luna.cli.chat.main`.
2. `main` calls `run_chat()`.
3. `run_chat` calls `build_agent()` which:
   - loads settings
   - creates the OpenRouter chat model
   - creates memory (SQLite or in-RAM)
   - collects tools (built-in + MCP)
   - builds one LangGraph agent with all of that
4. You get a `You>` prompt.
5. Each message you send is passed to `agent.ainvoke(...)` with your `thread_id`.
6. LangGraph loads prior messages for that thread, runs the agent loop, saves the new state, and returns the reply.

---

## Folder map (start here)

```
Luna/
├── README.md                 ← how to run
├── env.example               ← copy to .env for settings
├── spec/
│   ├── spec1.md              ← what was built (design notes)
│   └── beginner-guide.md     ← THIS FILE
├── config/
│   └── mcp_servers.json      ← which MCP tool-servers to connect
├── servers/
│   ├── demo_mcp_server.py    ← tiny example MCP server (2 tools)
│   └── tasks_mcp_server.py   ← to-dos for the assistant (synced with Google Tasks)
└── src/luna/                 ← the actual app
    ├── __init__.py           ← entry point → starts the chat CLI
    ├── cli/chat.py           ← the interactive chat loop (You> / Luna>)
    ├── config/settings.py    ← all knobs (model, memory, MCP on/off)
    ├── agent/
    │   ├── builder.py        ← assembles model + memory + tools
    │   └── memory.py         ← creates the checkpointer
    ├── tools/
    │   ├── registry.py       ← shopping bag that holds all tools
    │   └── builtin/          ← tools written in this repo
    └── mcp/loader.py         ← reads MCP config and loads remote tools
```

**Suggested reading order**

1. `cli/chat.py` — you already understand chat apps  
2. `agent/builder.py` — where pieces are glued together  
3. `tools/builtin/` — simplest tools  
4. `tools/registry.py` — how tools are collected  
5. `agent/memory.py` — how memory works  
6. `mcp/loader.py` + `servers/demo_mcp_server.py` — external tools  
7. `config/settings.py` — how to change behavior without editing logic  

---

## File-by-file walkthrough

### 1. `src/luna/cli/chat.py` — the chat window

This is the only file that talks to *you* directly.

- Prints `You>` and waits for input.
- If you type `/tools`, `/new`, `/quit`, etc., it handles those locally (no AI).
- Otherwise it sends your text to the agent:

```python
result = await agent.ainvoke(
    {"messages": [{"role": "user", "content": user_input}]},
    config={"configurable": {"thread_id": thread_id}},
)
```

**Why `thread_id`?**  
Memory is stored per thread (a "session"). Same thread → Luna remembers. Every start makes a new UUID so history starts fresh; `/sessions` + `/resume <n>` (or `luna --resume`) continue an old one.

**Why `async`?**  
Calling the model and tools takes time. `await` means “wait for that work to finish.”

---

### 2. `src/luna/agent/builder.py` — the assembly line

Think of this as a recipe:

| Ingredient | Where it comes from |
| --- | --- |
| Brain (LLM) | `ChatOpenAI(model=..., base_url=OpenRouter)` |
| Memory | `create_checkpointer(...)` |
| Tools | `build_tool_registry(...)` |
| Personality | `system_prompt` from settings |

Then:

```python
agent = create_agent(
    model=model,
    tools=registry.list_tools(),
    system_prompt=settings.system_prompt,
    checkpointer=checkpointer,
)
```

`create_agent` (from LangChain) builds a LangGraph that already knows how to:

- call the model
- detect “I want to use a tool”
- run the tool
- feed the result back to the model
- stop when the model gives a final answer

You do **not** need to write that loop yourself.

---

### 3. `src/luna/agent/memory.py` — remembering chats

Two modes:

| Backend | Setting | Behavior |
| --- | --- | --- |
| SQLite file | `LUNA_MEMORY_BACKEND=sqlite` | Saved on disk → survives restart |
| RAM | `LUNA_MEMORY_BACKEND=memory` | Forgotten when the process exits |

The object returned is a **checkpointer**. LangGraph asks it:

- “Give me the history for `thread_id=default`”
- “Save the updated history for `thread_id=default`”

You never manually append to a `conversation_history` list (unlike a simple chatbot tutorial). The checkpointer does that.

Because the CLI uses **async** (`ainvoke`), SQLite memory uses `AsyncSqliteSaver` (not the sync `SqliteSaver`). If you ever see *“SqliteSaver does not support async methods”*, the wrong saver type was wired in.

---

### 4. `src/luna/tools/builtin/` — tools inside this project

A tool is a normal function with `@tool` on top:

```python
@tool
def echo(message: str) -> str:
    """Echo back a message."""
    return message
```

Important details for beginners:

- The **docstring** is not just for humans — the *model* reads it to decide when to call the tool.
- Argument names/types become the tool’s input schema.
- `get_builtin_tools()` returns the list that gets registered.

**How to add your own tool (easiest path)**

1. Write a new `@tool` function in `builtin/__init__.py`.
2. Add it to the list in `get_builtin_tools()`.
3. Restart `uv run luna`.
4. Type `/tools` — your tool name should appear.
5. Ask something that needs it.

---

### 5. `src/luna/tools/registry.py` — the tool shopping bag

`ToolRegistry` is a simple container:

- `register(tool)` — add one tool  
- `register_many([...])` — add several  
- `list_tools()` — give them all to the agent  
- `names()` — used by `/tools` in the CLI  

Built-in tools and MCP tools both end up here so the agent sees **one** list.

---

### 6. `src/luna/mcp/loader.py` — tools from other programs

**MCP** = Model Context Protocol.

Analogy:

- Built-in tools = apps installed on your phone  
- MCP tools = apps on another phone that your phone can call over a standard cable  

`config/mcp_servers.json` lists those other programs. By default it
connects the demo server below, a local to-do server for the assistant
helper (`servers/tasks_mcp_server.py`) and the LangChain docs server for
the researcher. The smallest possible config looks like this:

```json
{
  "mcpServers": {
    "demo": {
      "command": "uv",
      "args": ["run", "python", "servers/demo_mcp_server.py"]
    }
  }
}
```

Add `"agent": "assistant"` (or `"researcher"`, `"files"`, `"coder"`) to a
server to give its tools to that helper instead of the main agent — see
`spec/spec3.md`.

What `load_mcp_tools` does:

1. Read that JSON.
2. Connect using LangChain’s `MCPAdapter`.
3. Ask each server: “What tools do you have?”
4. Convert them into normal LangChain tools.
5. Return the list (then the registry adds them).

You can turn this off with `LUNA_ENABLE_MCP_TOOLS=false`.

---

### 7. `servers/demo_mcp_server.py` — a tiny external tool server

This is a **separate program**. When Luna starts, it may launch this script and talk to it.

```python
@mcp.tool()
def reverse_text(text: str) -> str:
    return text[::-1]
```

Same idea as `@tool`, but the function lives in another process. That is useful when tools are written by someone else, need isolation, or talk to private APIs.

---

### 8. `src/luna/config/settings.py` — the control panel

Instead of hard-coding values everywhere, settings live in one place.

Examples:

```bash
export LUNA_MODEL_NAME=llama3.2:latest
export LUNA_MEMORY_BACKEND=memory
export LUNA_ENABLE_MCP_TOOLS=false
uv run luna
```

Or put the same keys in a `.env` file (see `env.example`).

Prefix is always `LUNA_`.

---

## One full turn (step by step)

Suppose you type: `What is (3+5)*12?` on thread `default`.

1. CLI packages your text as a user message.
2. LangGraph loads prior messages for `default` from the checkpointer.
3. Model sees system prompt + history + your question + available tools.
4. Model decides to call `calculator` with `expression="(3+5)*12"`.
5. LangGraph runs that Python function → gets `"96"`.
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
   `LUNA_ENABLE_MCP_TOOLS=false uv run luna`  
   `/tools` should no longer show `reverse_text` / `word_count`.

4. **Add a silly tool**  
   Add `@tool def shout(text: str) -> str: return text.upper()` to builtins, register it, restart, ask Luna to shout something.

---

## If you get stuck

| Symptom | Likely cause |
| --- | --- |
| Authentication error when chatting | Set `LUNA_OPENROUTER_API_KEY` in `.env` and check the key is valid |
| MCP tools missing | Config empty, MCP disabled, server failed to start, or the server is tagged for a helper |
| Forgets everything after restart | Using `memory` backend instead of `sqlite` |
| Forgets after `/new` | Expected — new `thread_id` |

---

## Next reading

- Design / decisions: [`spec1.md`](spec1.md) (later specs up to [`spec8.md`](spec8.md): the web Control Center and routines)
- Quick start: [`../README.md`](../README.md)
- Official LangChain agents: https://docs.langchain.com/oss/python/langchain/agents
- MCP in LangChain: https://docs.langchain.com/oss/python/langchain/mcp
