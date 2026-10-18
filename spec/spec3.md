# Spec 3 — Luna v1 architecture: subagents, task memory, human approval

**Date:** 2026-10-18  
**Status:** Phases A–E implemented. Phase F (long-term memory) not started.  
**Scope:** A general assistant. Main agent + four helper subagents, shared task budget, task scratchpad, human-in-the-loop approval.

Builds on [spec2](spec2.md) (loop limits, "a subagent is just a tool").
Decision log: [`DECISIONS.md`](../DECISIONS.md) D6–D14. Topology: [`ARCHITECTURE.md`](../ARCHITECTURE.md).

---

## 1. Shape

```
User ─▶ CLI run_turn()  (one TaskBudget per user message, kept across resumes)
         │
         ▼
   MAIN AGENT "Luna"   ≤ 25 model calls, ≤ 40 tool calls per message
   middleware: TaskBudget · ModelCallLimit · ToolCallLimit · TodoList ·
               Scratchpad · [HITL for risky MCP tools] · Summarization
   direct tools: get_current_time, calculator, ask_user, write_todos,
                 write_note, untagged MCP tools
   delegate tools (each runs its own capped ReAct loop, fresh context):
     ├─ ask_researcher  tavily_search, tavily_extract, calculator      (needs Tavily key)
     ├─ ask_files       list_dir, read_file, search_files, write_file*, edit_file*
     ├─ ask_coder       file tools + run_command*, write_todos
     └─ ask_assistant   MCP servers tagged "agent": "assistant"*      (needs a tagged server)
   * = asks for approval            one level only: helpers can't delegate
```

`echo` was removed from the built-ins (it was only a smoke test).

## 2. Helpers

| Helper | Why a subagent (spec2 §2) | Limit / timeout | Approval |
| --- | --- | --- | --- |
| researcher | noisy, multi-step | 10 / 180 s | none (read-only) |
| files | noisy + tighter permissions | 12 / 180 s | `write_file`, `edit_file` |
| coder | noisy + strictest permissions | 15 / 600 s | `write_file`, `edit_file`, `run_command` |
| assistant | many look-alike MCP tools | 10 / 180 s | MCP tools with a changing verb in the name |

Code: `src/luna/agent/subagents/{researcher,files,coder,assistant}.py`, each a
`<name>_spec(settings)` that returns `None` when its requirement is missing.
`get_subagent_specs(settings, mcp_groups)` in `__init__.py` collects them.

- Delegate input: `task` (self-contained) + optional `context` (facts, notes).
- Each helper replies in ≤ 300 words; bigger results go to a file, by path.
- **Boundaries** (D14): files can't execute anything and says to use the coder;
  the coder is "use this whenever something must run".
- **File sandbox** (`luna/tools/fs.py`): every path is resolved (`..`, `~`,
  symlinks) and must stay inside `LUNA_WORKSPACE_DIRS` (default `./workspace`).
  Reads are paged (400 lines), searches capped (100 matches), `.git`/`.venv`/
  `node_modules` skipped.
- **run_command** (`luna/tools/shell.py`): starts in a workspace folder, own
  process group (timeout kills children), output trimmed to head 2 000 + tail
  6 000 chars. Not a security boundary — approval is (D11).
- **Output cap** (`luna/tools/limits.py`): `cap_output(tool, 8000)` wraps the
  Tavily tools so a big page can't flood the researcher.

## 3. Loops and limits

| Level | Mechanism | Default | On hit |
| --- | --- | --- | --- |
| Whole task | `TaskBudgetMiddleware` on every agent, shared `TaskBudget` (`luna/agent/budget.py`) | `LUNA_TASK_BUDGET=80` model calls | "Task budget exhausted…"; a helper returns `[name stopped: the task budget ran out]` |
| Main agent | `ModelCallLimitMiddleware` / `ToolCallLimitMiddleware` | 25 / 40 | ends cleanly / extra calls refused |
| Each helper call | `SubagentSpec.max_model_calls` + `timeout_seconds` | see §2 | `[name stopped at its limit …]` / `[… timed out …]` + last partial text |
| Backstop | `recursion_limit` | `max_model_calls × 10 + 20` | error (should never trigger) |

The budget lives in a context variable set by `run_task()` (`luna/agent/runner.py`).
LangGraph copies context into every task it starts, and the copy points at the
same `TaskBudget`, so parallel helpers draw from one allowance. `run_turn()`
passes the same budget to every resume of one message.

## 4. Memory

| Layer | Lifetime | Where | Status |
| --- | --- | --- | --- |
| Working context | one model call | system prompt (+ scratchpad) + recent messages | built |
| **Task scratchpad** | the task (may span messages in a thread) | agent state, checkpointed | built |
| Helper scratchpad | one delegation | the helper's own messages (+ coder's todos) | built |
| Thread history | the conversation | sqlite checkpointer + summarization | built (spec1/2) |
| Long-term | across threads | `AsyncSqliteStore` + embeddings | **phase F, not built** |

Task scratchpad (`luna/agent/scratchpad.py`):

- `todos` — `TodoListMiddleware`'s `write_todos` (the plan).
- `notes` — `write_note(key, content)`; empty content deletes. Merging reducer,
  so parallel `write_note` calls don't overwrite each other.
- `ScratchpadMiddleware` renders **both** into the system prompt on every call.
  (TodoListMiddleware alone only adds instructions; the current todos would
  otherwise live only in old tool messages, which summarization can remove.)
- Survives summarization (state, not messages) and approval pauses (checkpointed).
- `/new` starts a thread with an empty scratchpad.

Helpers inherit the main checkpointer (`checkpointer=None`, D8) so a pause
inside one can resume; each call still starts with only `[system, task]`.

## 5. Human approval

- `SubagentSpec.interrupt_on` → `HumanInTheLoopMiddleware` on that helper.
- Main agent: HITL only for untagged MCP tools with risky names.
- `ask_user(question)` on the main agent pauses with `interrupt()`.
- CLI (`run_turn` in `luna/cli/chat.py`): after each run it reads pending
  pauses from `agent.aget_state()`; shows the tool + JSON args; you choose
  `[a]pprove / [e]dit / [r]eject` (edit = new JSON args; reject = optional
  reason shown to Luna) or type an answer for `ask_user`. It resumes with
  `Command(resume={interrupt_id: answer, …})` — several parallel pauses at once.
- `LUNA_AUTO_APPROVE=write_file,...` skips approval for trusted tools.
- Waiting for you doesn't count toward helper timeouts (a pause ends the run).

## 6. MCP routing

`config/mcp_servers.json` (empty by default, D13). Per server, optional
`"agent": "<helper>"`:

- none → main agent
- `"assistant"` → creates `ask_assistant`
- other (`"researcher"`, `"files"`, `"coder"`) → extra tools for that helper
- unknown → warning, tools unused

Each group loads separately; a broken server only drops its own group.

## 7. Configuration added

| Variable | Default | Meaning |
| --- | --- | --- |
| `LUNA_TASK_BUDGET` | `80` | Model calls per message across all agents |
| `LUNA_TAVILY_API_KEY` | unset | Enables the researcher |
| `LUNA_WORKSPACE_DIRS` | `./workspace` | Comma-separated folders for files/coder |
| `LUNA_AUTO_APPROVE` | empty | Comma-separated tools that skip approval |

## 8. Verification

`uv run pytest` — 86 tests, fake models, no network except one local stdio
MCP server. Files: `test_budget`, `test_scratchpad`, `test_hitl`,
`test_researcher`, `test_fs`, `test_files_subagent`, `test_coder`,
`test_mcp_routing` (plus the spec1/2 tests).

Live (OpenRouter): `ask_user` pause/answer and `write_note` worked through the
real CLI. A coding request ran into the routing problem in D14, then the free
tier's daily limit; the boundary fix still needs a live re-check. The
researcher hasn't run live (no Tavily key yet).

## 9. Next — phase F, long-term memory

- `AsyncSqliteStore` with a vector index; namespaces `("memories", user)`
  (facts, preferences) and `("episodes", user)` (one-line task summaries).
- Main-agent tools `remember`, `recall`, `forget`; `MemoryMiddleware` injects
  the top 5 matches for each new message; `/memories` to list/delete.
- Open decision: embedding provider.
