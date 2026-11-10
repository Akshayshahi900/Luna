# Agents and tools

How Luna's agents are put together, what each one can do, and how to add
your own tool, MCP server or helper. For the end-to-end message flow see
[`ARCHITECTURE.md`](../ARCHITECTURE.md); for the reasons, `DECISIONS.md`.

## The main agent

Built by `buildAgent` → `assembleAgent` in `core/src/agent/builder.ts`
with LangChain's `createAgent`. It gets:

- **Built-in tools** (`core/src/tools/builtin/`): `get_current_time`,
  `calculator` (safe AST evaluator, no `eval`), `ask_user` (pauses to ask you).
- **Scratchpad**: `write_note`, notes kept in graph state and shown to the
  model on every call (`agent/scratchpad.ts`).
- **Long-term memory**: `recall`, `remember`, `suggest_update`,
  `suggest_forget`. `remember` and the `suggest_*` tools only *suggest*;
  you accept them (`agent/longterm.ts`, [`memory.md`](memory.md)).
- **To-do planning**: `write_todos` (LangChain `todoListMiddleware`).
- **MCP tools** from servers with no `"agent"` tag (e.g. `demo`).
- **Delegate tools**: one `ask_<helper>` per enabled helper.

Middleware, in order of concern: task budget, model / tool call limits,
scratchpad, long-term memory, summarization of long threads, and
human-in-the-loop approval.

## Helpers (subagents)

A helper is just a tool, `ask_<name>(task, context)`, that runs a separate
agent with a fresh conversation and returns only its final answer
(D4, `agent/subagents/base.ts`). Helpers cannot call other helpers (D5).

| Tool | Enabled when | Tools inside | Asks before | Calls / timeout |
| --- | --- | --- | --- | --- |
| `ask_researcher` | `LUNA_TAVILY_API_KEY` set | Tavily search + extract, `calculator`, MCP servers tagged `researcher` | risky MCP tools | 5 / 180 s |
| `ask_files` | always | `list_dir`, `read_file`, `search_files`, `write_file`, `edit_file` | `write_file`, `edit_file` | 6 / 180 s |
| `ask_coder` | always | the file tools, `run_command`, `write_todos` | writes, `run_command` | 10 / 600 s |
| `ask_assistant` | an MCP server is tagged `assistant` | mail, calendar, to-do MCP tools, `get_current_time` | risky MCP tools | 5 / 180 s |

File and shell tools (`tools/fs.ts`, `tools/shell.ts`) are sandboxed to
`LUNA_WORKSPACE_DIRS`. Big tool outputs are trimmed by `capOutput`
(`tools/limits.ts`). Every helper's model calls also count against
`LUNA_TASK_BUDGET`.

## MCP servers

`config/mcp_servers.json` (D2):

```json
{
  "mcpServers": {
    "demo":   { "command": "node", "args": ["core/servers/demo.ts"] },
    "google": { "command": "node", "args": ["core/servers/google.ts"], "agent": "assistant" },
    "langchain_docs": { "url": "https://docs.langchain.com/mcp", "agent": "researcher" }
  }
}
```

- `command` + `args` start a local stdio server (relative paths are from the
  repo root; it keeps running until Luna exits); `url` connects to an HTTP one.
- Tool names are the server's own. Only if two servers of one group export
  the same name does the second become `<server>_<name>`.
- `"agent"` gives the server's tools to that helper instead of the main agent.
- `"disabled": true` keeps the entry but doesn't load it (the web
  Control Center's Connectors app sets it; [`control-center.md`](control-center.md)).
- A tool whose name contains a changing verb (`send`, `create`, `update`,
  `delete`, `write`, `add`, `set`, `reply`, …) asks for approval
  automatically (`isRiskyToolName` in `mcp/loader.ts`, D9).

Servers that ship with Luna:

| Server | Tools |
| --- | --- |
| `core/servers/demo.ts` | `reverse_text`, `word_count` |
| `core/servers/tasks.ts` | `list_tasks`, `add_task`, `set_task_done`, `delete_task`, `add_task_from_email` |
| `core/servers/mail.ts` | `list_inbox`, `search_emails`, `read_email`, `send_email`, `reply_to_email` |
| `core/servers/google.ts` | `list_events`, `get_agenda`, `create_event`, `update_event`, `delete_event`, `create_event_from_email` |

## Extending Luna

### Add a built-in tool

1. Write a `tool(fn, { name, description, schema })` in
   `core/src/tools/builtin/` (`tool` from `@langchain/core/tools`, the
   arguments as a zod schema). The description is what the model reads to
   decide when to call it — make it specific.
2. Add it to `getBuiltinTools()`.
3. Add a test in `core/test/` (see `core/test/calculator.test.ts`).
4. Restart and check `/tools`.

If the tool changes anything outside Luna, it must go through approval —
put it in a helper's `interruptOn` (see below) rather than on the main agent.

### Add an MCP server

1. Write the server (copy `core/servers/demo.ts`: the MCP SDK's
   `McpServer.registerTool`, results via `servers/common.ts`) or pick an
   existing one (any language works: it's just a program on stdio).
2. Add it to `config/mcp_servers.json` (and `config/mcp_servers.example.json`),
   with `"agent": "<helper>"` if it belongs to a helper.
3. Name changing tools with a risky verb so they ask for approval.
4. Test the server's functions directly (see `core/test/tasks_server.test.ts`).

Stdio servers don't inherit Luna's process settings; read your own
`LUNA_*` variables with `loadSettings()` inside the server (it reads `.env`).

### Add a helper

Only when the work is noisy and multi-step, needs different tools or
permissions, or can run in parallel (spec2 §2). Otherwise add a tool.

1. Create `core/src/agent/subagents/<name>.ts` with a `<name>Spec(settings)`
   function returning a `subagentSpec({...})` (or `null` when its requirements
   are missing). Copy `files.ts` as a template.
2. Set `interruptOn: needsApproval([...risky tool names], settings.auto_approve)`.
3. Add it to the `candidates` list in `getSubagentSpecs()`
   (`subagents/index.ts`).
4. Add tests (see `core/test/helpers_subagents.test.ts`), and a `DECISIONS.md` entry.
