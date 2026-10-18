# Agents and tools

How Luna's agents are put together, what each one can do, and how to add
your own tool, MCP server or helper. For the end-to-end message flow see
[`ARCHITECTURE.md`](../ARCHITECTURE.md); for the reasons, `DECISIONS.md`.

## The main agent

Built by `build_agent` → `assemble_agent` in `src/luna/agent/builder.py`
with LangChain's `create_agent`. It gets:

- **Built-in tools** (`src/luna/tools/builtin/`): `get_current_time`,
  `calculator` (safe AST evaluator, no `eval`), `ask_user` (pauses to ask you).
- **Scratchpad**: `write_note`, notes kept in graph state and shown to the
  model on every call (`agent/scratchpad.py`).
- **Long-term memory**: `recall`, `remember`, `suggest_update`,
  `suggest_forget`. `remember` and the `suggest_*` tools only *suggest*;
  you accept them (`agent/longterm.py`, [`memory.md`](memory.md)).
- **To-do planning**: `write_todos` (LangChain `TodoListMiddleware`).
- **MCP tools** from servers with no `"agent"` tag (e.g. `demo`).
- **Delegate tools**: one `ask_<helper>` per enabled helper.

Middleware, in order of concern: task budget, model / tool call limits,
scratchpad, long-term memory, summarization of long threads, and
human-in-the-loop approval.

## Helpers (subagents)

A helper is just a tool, `ask_<name>(task, context)`, that runs a separate
agent with a fresh conversation and returns only its final answer
(D4, `agent/subagents/base.py`). Helpers cannot call other helpers (D5).

| Tool | Enabled when | Tools inside | Asks before | Calls / timeout |
| --- | --- | --- | --- | --- |
| `ask_researcher` | `LUNA_TAVILY_API_KEY` set | Tavily search + extract, `calculator`, MCP servers tagged `researcher` | risky MCP tools | 5 / 180 s |
| `ask_files` | always | `list_dir`, `read_file`, `search_files`, `write_file`, `edit_file` | `write_file`, `edit_file` | 6 / 180 s |
| `ask_coder` | always | the file tools, `run_command`, `write_todos` | writes, `run_command` | 10 / 600 s |
| `ask_assistant` | an MCP server is tagged `assistant` | mail, calendar, to-do MCP tools, `get_current_time` | risky MCP tools | 5 / 180 s |

File and shell tools (`tools/fs.py`, `tools/shell.py`) are sandboxed to
`LUNA_WORKSPACE_DIRS`. Big tool outputs are trimmed by `cap_output`
(`tools/limits.py`). Every helper's model calls also count against
`LUNA_TASK_BUDGET`.

## MCP servers

`config/mcp_servers.json` (D2):

```json
{
  "mcpServers": {
    "demo":   { "command": "uv", "args": ["run", "python", "servers/demo_mcp_server.py"] },
    "google": { "command": "uv", "args": ["run", "python", "servers/google_mcp_server.py"], "agent": "assistant" },
    "langchain_docs": { "url": "https://docs.langchain.com/mcp", "agent": "researcher" }
  }
}
```

- `command` + `args` start a local stdio server; `url` connects to an HTTP one.
- `"agent"` gives the server's tools to that helper instead of the main agent.
- A tool whose name contains a changing verb (`send`, `create`, `update`,
  `delete`, `write`, `add`, `set`, `reply`, …) asks for approval
  automatically (`is_risky_tool_name` in `mcp/loader.py`, D9).

Servers that ship with Luna:

| Server | Tools |
| --- | --- |
| `servers/demo_mcp_server.py` | `reverse_text`, `word_count` |
| `servers/tasks_mcp_server.py` | `list_tasks`, `add_task`, `set_task_done`, `delete_task`, `add_task_from_email` |
| `servers/mail_mcp_server.py` | `list_inbox`, `search_emails`, `read_email`, `send_email`, `reply_to_email` |
| `servers/google_mcp_server.py` | `list_events`, `get_agenda`, `create_event`, `update_event`, `delete_event`, `create_event_from_email` |

## Extending Luna

### Add a built-in tool

1. Write a function with `@tool` in `src/luna/tools/builtin/`. The
   docstring is what the model reads to decide when to call it — make it
   specific.
2. Add it to `get_builtin_tools()`.
3. Add a test in `tests/` (see `tests/test_calculator.py`).
4. Restart and check `/tools`.

If the tool changes anything outside Luna, it must go through approval —
put it in a helper's `interrupt_on` (see below) rather than on the main agent.

### Add an MCP server

1. Write the server (copy `servers/demo_mcp_server.py`, uses `FastMCP`) or
   pick an existing one.
2. Add it to `config/mcp_servers.json` (and `config/mcp_servers.example.json`),
   with `"agent": "<helper>"` if it belongs to a helper.
3. Name changing tools with a risky verb so they ask for approval.
4. Test the server's functions directly (see `tests/test_tasks_server.py`).

Stdio servers don't inherit Luna's process settings; read your own
`LUNA_*` variables with `Settings()` inside the server.

### Add a helper

Only when the work is noisy and multi-step, needs different tools or
permissions, or can run in parallel (spec2 §2). Otherwise add a tool.

1. Create `src/luna/agent/subagents/<name>.py` with a `<name>_spec(settings)`
   function returning a `SubagentSpec` (or `None` when its requirements are
   missing). Copy `files.py` as a template.
2. Set `interrupt_on=needs_approval([...risky tool names], settings.auto_approve)`.
3. Add it to the `candidates` list in `get_subagent_specs()`
   (`subagents/__init__.py`).
4. Add tests (see `tests/test_files_subagent.py`), and a `DECISIONS.md` entry.
