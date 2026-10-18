# Architecture

Luna is a general assistant: one main ReAct agent that does quick work
itself and hands bigger jobs to helper subagents. Design history is in
`spec/` (spec1 → spec4); decisions and their reasons in `DECISIONS.md`.
Two front doors share the same agent code: the terminal CLI and a
voice-first web UI (`docs/web-ui.md`).

## Topology

```
                         ┌────────────────────────────────────────────┐
 you ── CLI (cli/chat) ──▶ run_turn → run_task (agent/runner)          │
 you ── browser (web/) ──▶ /ws → Session (web/server) → run_task       │
        voice in/out,     │   events → JSON (web/events)                │
   ▲     approve/edit/    │   TaskBudget for the whole message          │
   │     reject, answers  └──────────────────┬─────────────────────────┘
   │                                         ▼
   │        ┌──────────────────── MAIN AGENT (agent/builder) ───────────────────┐
   │        │ middleware: TaskBudget → ModelCallLimit → ToolCallLimit →         │
   │        │             TodoList → Scratchpad → [HITL] → Summarization        │
   │        │ tools: get_current_time, calculator, ask_user, write_todos,       │
   │        │        write_note, untagged MCP tools, ask_* delegates            │
   │        └───────┬──────────────┬──────────────┬──────────────┬─────────────┘
   │                ▼              ▼              ▼              ▼
   │         ask_researcher    ask_files       ask_coder     ask_assistant
   │         (Tavily)          (fs tools)      (fs + shell)  (tagged MCP)
   │         each: own ReAct loop, limit + timeout, TaskBudget, optional HITL,
   │               fresh context per call, shares the main checkpointer
   │                │              │              │              │
   └──── pauses ◀───┴── interrupt() / HumanInTheLoopMiddleware ──┘

 Storage: data/luna_memory.sqlite (checkpoints: thread history, scratchpad,
          paused helper runs) · workspace/ (files the helpers may touch)
```

## One message, end to end

1. `run_turn` creates a `TaskBudget` and calls `run_task` with the message.
2. `run_task` puts the budget in a context variable and streams
   `agent.astream(..., subgraphs=True)`; the CLI prints text, tool calls and
   helper steps (indented) as they arrive.
3. Before every model call, in any agent, `TaskBudgetMiddleware` takes one unit.
   The main agent sees its system prompt plus the scratchpad (todos + notes).
4. The model either answers, calls a direct tool, or calls `ask_<helper>`.
   A helper runs its own capped loop and returns ≤ 300 words.
5. A risky tool (write, edit, run, send…) or `ask_user` pauses the graph. The
   run ends; `run_task` returns the pending pauses from `aget_state()`.
6. `run_turn` asks you, then calls `run_task` again with
   `Command(resume={id: answer})` and the same budget. Repeat until no pauses.
7. The checkpointer has saved messages, scratchpad and any paused helper
   state under the thread id; old messages get summarized past 12k tokens.

The web path is the same loop split over socket messages: `message` →
steps 1–5, the pauses go to the browser as `pause`, and `resume` is step 6.
Protocol: `docs/web-ui.md`.

## Files

```
src/luna/
  cli/chat.py              REPL, printing, pause handling (run_turn, answer_interrupt)
  voice/tts.py             PiperTTS: local text-to-speech for the web UI (/api/tts)
  web/
    server.py              luna-web: Starlette app, AgentHost (model switch), /ws Session,
                           origin check, serves web/dist
    events.py              stream events → JSON; pause describe / answer conversion
  config/settings.py       all LUNA_* settings
  agent/
    builder.py             build_agent (model, checkpointer, MCP) → assemble_agent (tools,
                           middleware, delegates); assemble again = switch model
    providers.py           OpenRouter / Groq / Ollama → ChatOpenAI; list models
    runner.py              run_task: one run with budget + event stream + pending pauses
    budget.py              TaskBudget + TaskBudgetMiddleware
    scratchpad.py          notes state, write_note, ScratchpadMiddleware
    memory.py              checkpointer factory (sqlite / memory)
    subagents/
      base.py              SubagentSpec, make_delegate_tool, needs_approval
      researcher.py        Tavily web research
      files.py             workspace files
      coder.py             code + run_command
      assistant.py         personal tasks via tagged MCP servers
      __init__.py          get_subagent_specs (which helpers are on, MCP routing)
  tools/
    builtin/               get_current_time, calculator, ask_user
    fs.py                  sandboxed file tools (Workspace)
    shell.py               run_command
    limits.py              cap_output
    registry.py            ToolRegistry
  mcp/loader.py            read MCP config, split_by_agent, is_risky_tool_name
config/mcp_servers.json    MCP servers (empty by default; see .example.json)
servers/demo_mcp_server.py sample MCP server
tests/                     pytest suite (fake models, no API key)
web/                       browser UI (Vite + React + React Three Fiber); `npm run build` → web/dist
  src/App.tsx              voice loop, pauses, keyboard; src/lib (socket, reducer, speech),
  src/core (3D core), src/components (HUD, drawer, pause card)
docs/web-ui.md             running the web UI, WebSocket protocol
spec/                      design specs; DECISIONS.md; this file
```

## Not built yet

Long-term memory across threads (spec3 §9), local speech input (STT),
a wake word, and cancelling a running task from the UI.
