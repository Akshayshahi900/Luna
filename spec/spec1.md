# Spec 1 — Luna LangGraph Chatbot

**Date:** 2026-10-06  
**Status:** Implemented  
**Scope:** Memory-backed LangGraph agent with pluggable native + MCP tools

> **Beginner?** This file is the design record. For a plain-English tour of
> every concept and file, read **[`beginner-guide.md`](beginner-guide.md)** first.
> Source files also have `BEGINNER MAP` comments at the top.

---

## 1. Goal

Build a Python chatbot on **LangGraph / LangChain** that:

1. Remembers conversation turns (short-term memory via checkpointers).
2. Can call **built-in tools** and **MCP protocol tools**.
3. Is structured so new tools, MCP servers, models, and memory backends can be added without rewriting the agent core.
4. Ships as a runnable CLI (`uv run luna`).

---

## 2. Architecture

```
┌─────────────────────────────────────────────────────────┐
│  CLI (luna.cli.chat)                                    │
│  thread_id  →  ainvoke(messages, config)                │
└───────────────────────────┬─────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────┐
│  Agent builder (luna.agent.builder)                     │
│  create_agent(model, tools, system_prompt, checkpointer)│
└───────┬─────────────────────────────┬───────────────────┘
        │                             │
┌───────▼──────────┐         ┌────────▼───────────────────┐
│  Memory          │         │  ToolRegistry              │
│  InMemorySaver   │         │  ├─ builtin @tool funcs    │
│  SqliteSaver     │         │  └─ MCPAdapter tools       │
└──────────────────┘         └────────────────────────────┘
                                        │
                         ┌──────────────┴──────────────┐
                         │ config/mcp_servers.json     │
                         │ (MCPConfig / multi-server)  │
                         └─────────────────────────────┘
```

### Design principles

| Principle | How it shows up |
| --- | --- |
| Single composition root | `build_agent()` wires model + memory + tools |
| Open for extension | New tools = register; new MCP servers = JSON entry |
| Config over code | `LUNA_*` env vars + `mcp_servers.json` |
| Protocol-first tools | Prefer MCP for external systems; keep a thin builtin set |
| Thread-scoped memory | LangGraph `thread_id` isolates conversations |

---

## 3. Work completed

### 3.1 Dependencies (`pyproject.toml`)

- `langchain[mcp]` — agents + built-in `langchain.mcp.MCPAdapter` (FastMCP under the hood)
- `langchain-ollama` — local LLM via Ollama
- `langgraph` — agent graph runtime
- `langgraph-checkpoint-sqlite` — durable conversation memory
- `pydantic-settings` — typed settings from env / `.env`

### 3.2 Package layout

```
src/luna/
  __init__.py              # entry → CLI main
  config/
    settings.py            # Settings + get_settings()
  agent/
    builder.py             # build_agent / build_tool_registry
    memory.py              # checkpointer factory
  tools/
    registry.py            # ToolRegistry (merge + dedupe by name)
    builtin/               # native @tool implementations
  mcp/
    loader.py              # load MCPConfig JSON → LangChain tools
  cli/
    chat.py                # interactive REPL
  core/
    main.py                # legacy shim

config/
  mcp_servers.json         # MCP server fleet (editable)
  env.example              # documented env vars

servers/
  demo_mcp_server.py       # sample local stdio MCP server

data/                      # sqlite checkpoints (gitignored)

spec/
  spec1.md                 # this document
```

### 3.3 Memory

| Backend | Setting | Behavior |
| --- | --- | --- |
| `sqlite` (default) | `LUNA_MEMORY_BACKEND=sqlite` | Persists under `data/luna_memory.sqlite` |
| `memory` | `LUNA_MEMORY_BACKEND=memory` | Process-local `InMemorySaver` |

Memory is **short-term / thread memory**: the full message history for a `thread_id` is restored on each turn via the LangGraph checkpointer passed into `create_agent(..., checkpointer=...)`.

Invoke pattern:

```python
await agent.ainvoke(
    {"messages": [{"role": "user", "content": "..."}]},
    config={"configurable": {"thread_id": "default"}},
)
```

CLI commands:

- `/new` — new UUID thread (fresh history key)
- `/thread` — print current thread id

### 3.4 Tools — native path

Built-ins in `luna.tools.builtin`:

| Tool | Purpose |
| --- | --- |
| `get_current_time` | Current time in an IANA timezone |
| `calculator` | Safe AST-based arithmetic |
| `echo` | Pipeline smoke test |

**How to add a native tool**

1. Add a `@tool` function (same module or a new module under `tools/`).
2. Append it to `get_builtin_tools()`.
3. Restart the CLI — no agent graph code changes required.

### 3.5 Tools — MCP path

Loader: `luna.mcp.loader.load_mcp_tools`.

Uses LangChain 1.4+ `MCPAdapter` with a standard **MCPConfig** dict.

Default (`config/mcp_servers.json`) wires the local demo server:

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

See `config/mcp_servers.example.json` for a multi-server example that also includes the public LangChain docs MCP HTTP endpoint.

Transports (inferred by FastMCP / MCPAdapter):

- HTTP(S) URL → Streamable HTTP
- `command` + `args` → stdio subprocess
- In-process FastMCP instance → memory transport (tests)

**How to add an MCP server**

1. Edit `config/mcp_servers.json` (or point `LUNA_MCP_CONFIG_PATH` elsewhere).
2. Restart the agent. Tools are discovered at build time and namespaced by server key when using a multi-server config.

Disable MCP without code changes: `LUNA_ENABLE_MCP_TOOLS=false`.

### 3.6 Tool registry

`ToolRegistry` merges sources and dedupes by tool name (last writer wins). This keeps the agent builder ignorant of where a tool came from, which is the scalability seam for future sources (OpenAPI tools, local plugins, etc.).

### 3.7 CLI

```bash
uv run luna
```

Commands: `/help`, `/tools`, `/thread`, `/new`, `/quit`.

### 3.8 Sample MCP server

`servers/demo_mcp_server.py` exposes `reverse_text` and `word_count` over stdio for local integration tests. Wire it into `mcp_servers.json` as shown above when you want it loaded.

---

## 4. Configuration reference

| Variable | Default | Meaning |
| --- | --- | --- |
| `LUNA_MODEL_NAME` | `phi4-mini:latest` | Ollama model tag |
| `LUNA_SYSTEM_PROMPT` | Luna helper prompt | Agent system message |
| `LUNA_MEMORY_BACKEND` | `sqlite` | `sqlite` or `memory` |
| `LUNA_CHECKPOINT_PATH` | `./data/luna_memory.sqlite` | SQLite file path |
| `LUNA_MCP_CONFIG_PATH` | `./config/mcp_servers.json` | MCP fleet config |
| `LUNA_ENABLE_BUILTIN_TOOLS` | `true` | Load native tools |
| `LUNA_ENABLE_MCP_TOOLS` | `true` | Discover MCP tools |
| `LUNA_DEFAULT_THREAD_ID` | `default` | Initial chat thread |

Copy `config/env.example` → `.env` to customize.

---

## 5. Runbook

```bash
# Install
uv sync

# Ensure Ollama + model
ollama serve   # if not already running
ollama pull phi4-mini:latest

# Optional: disable remote MCP while iterating
# export LUNA_ENABLE_MCP_TOOLS=false

# Chat
uv run luna
```

Smoke-test memory: ask your name, then ask “what is my name?” in the same thread.  
Smoke-test tools: ask for the time in `Asia/Kolkata` or `(3+5)*12`.

---

## 6. Scalability roadmap (intentional extension points)

Already supported:

- [x] Add native tools via registry
- [x] Add MCP servers via JSON
- [x] Swap memory backend (`memory` / `sqlite`)
- [x] Multi-thread conversations

Natural next steps (not implemented in spec1):

1. **Long-term memory** — LangGraph `store` + embeddings for cross-thread facts.
2. **HTTP API** — FastAPI wrapper around `build_agent()` with per-user `thread_id`.
3. **Auth’d MCP** — bearer / OAuth via FastMCP client options on `MCPAdapter`.
4. **Dynamic tool hot-reload** — re-run `list_tools(cache_mode="refresh")` without process restart.
5. **Alternate models** — swap `ChatOllama` for any LangChain chat model behind settings.
6. **Middleware** — LangChain agent middleware for logging, HITL interrupts, rate limits.

---

## 7. Decisions & trade-offs

| Decision | Rationale |
| --- | --- |
| `create_agent` instead of hand-rolled StateGraph | Same LangGraph runtime; less boilerplate; checkpointer + tools first-class |
| `langchain.mcp.MCPAdapter` over `langchain-mcp-adapters` | Official path as of LangChain ≥ 1.4; adapters package is unmaintained |
| SQLite checkpointer by default | Durable memory with zero ops overhead; easy to replace later |
| Config-driven MCP fleet | Adding a server should not require a PR to agent code |
| Safe AST calculator (not `eval`) | Avoid arbitrary code execution in a demo tool |

---

## 8. Known limitations (spec1)

- MCP tool discovery happens once at agent build time (restart to pick up new servers).
- Remote / public MCP servers need network access; the default config uses the local demo server only. See `config/mcp_servers.example.json` for HTTP examples. Turn MCP off with `LUNA_ENABLE_MCP_TOOLS=false`.
- `langchain.mcp` is marked beta by LangChain; APIs may shift.
- No long-term / cross-thread memory yet.
- CLI only — no web UI or API server in this spec.

---

## 9. File checklist (created / updated)

| Path | Role |
| --- | --- |
| `pyproject.toml` | Deps + `luna` console script |
| `README.md` | Quick start |
| `.gitignore` | venv, data, env |
| `config/mcp_servers.json` | Default MCP fleet |
| `config/env.example` | Env documentation |
| `servers/demo_mcp_server.py` | Sample stdio MCP server |
| `src/luna/**` | Application package |
| `spec/spec1.md` | This specification |

---

## 10. Acceptance criteria

| Criterion | Status |
| --- | --- |
| LangGraph agent runs via CLI | Done |
| Conversation memory across turns (`thread_id`) | Done |
| Built-in tools callable by the model | Done |
| MCP tools loadable from config | Done |
| Clear path to add more tools / servers | Done |
| Work documented in `spec/spec1.md` | Done |
