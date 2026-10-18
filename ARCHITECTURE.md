# Architecture

Luna is a general assistant: one main ReAct agent that does quick work
itself and hands bigger jobs to helper subagents. Design history is in
`spec/` (spec1 → spec11); decisions and their reasons in `DECISIONS.md`.
Two front doors share the same agent code: the terminal CLI and a
voice-first web UI (`docs/web-ui.md`). The web UI also has a Control
Center for settings, connectors, permissions, routines and live stats
(`docs/control-center.md`). `luna-web` opens the UI in its own app
window, like a desktop application (`web/window.py`, D37). A third
front door, a Telegram bot (`channels/`, D39), runs inside `luna-web` so
you can message Luna from your phone: text, voice notes, photos and
approvals (`docs/messaging.md`).

## Topology

```
                         ┌────────────────────────────────────────────┐
 you ── CLI (cli/chat) ──▶ run_turn → run_task (agent/runner)          │
 you ── browser (web/) ──▶ /ws → Session (web/server) → run_task       │
        voice in/out,     │   events → JSON (web/events)                │
 you ── Telegram ────────▶ long poll → Chat (channels/telegram)         │
        text, voice note, │   → run_task; reply text (+ Piper voice     │
        photo, file       │   note), Approve / Reject buttons           │
   ▲     approve/edit/    │   TaskBudget for the whole message          │
   │     reject, answers  └──────────────────┬─────────────────────────┘
   │                                         ▼
   │        ┌──────────────────── MAIN AGENT (agent/builder) ───────────────────┐
   │        │ middleware: TaskBudget → ModelCallLimit → ToolCallLimit →         │
   │        │   TodoList → Scratchpad → LongTermMemory → [HITL] → Summarization │
   │        │ tools: get_current_time, calculator, ask_user, write_todos,       │
   │        │        write_note, recall, remember, suggest_update/_forget,      │
   │        │        untagged MCP tools, ask_* delegates                        │
   │        └───────┬──────────────┬──────────────┬──────────────┬─────────────┘
   │                ▼              ▼              ▼              ▼
   │         ask_researcher    ask_files       ask_coder     ask_assistant
   │         (Tavily)          (fs tools)      (fs + shell)  (tagged MCP: to-dos, mail, calendar)
   │         each: own ReAct loop, limit + timeout, TaskBudget, optional HITL,
   │               fresh context per call, shares the main checkpointer
   │                │              │              │              │
   └──── pauses ◀───┴── interrupt() / HumanInTheLoopMiddleware ──┘

 Storage: data/luna_memory.sqlite (checkpoints: thread history, scratchpad,
          paused helper runs) · data/luna_longterm.sqlite (long-term memory:
          memories, suggestions, history; only the user writes memories)
          · workspace/ (files the helpers may touch) · data/tasks.json (to-dos,
          synced with Google Tasks) · data/google/ (OAuth client + token)
          · data/luna_routines.sqlite (routines, runs, usage counters)
          · data/dashboard.json (HUD widget preferences)
          · data/app-window/ (the app window's browser profile)
          · data/telegram.json (bot update offset, chat → thread id)

 Control Center (luna-web only): browser #/control ── /api/control/* (web/control.py)
   settings ⇄ .env (config/envfile.py + schema.py; validated, rolled back on error)
   MCP servers ⇄ config/mcp_servers.json · Google sign-in · permissions (LUNA_AUTO_APPROVE)
   stats: process, memory, sessions, tools, usage counters (Session → AgentHost.usage)
   routines: RoutineScheduler (routines/) ticks every 30 s →
     builtin: one read-only MCP tool via tool.ainvoke (no LLM) → HUD widgets
     agent:   run_task on thread routine-<id>, approvals auto-rejected
   → data/luna_routines.sqlite (routines, runs, usage) · data/dashboard.json
   → {"type": "routine_result"} / {"type": "settings_changed"} to every tab

 Google: one sign-in (integrations/google.py, `luna-google-auth`) shared by
         mail (Gmail API) · google (Calendar) · tasks (Google Tasks sync).
         The tasks and google servers import the mail server's fetch_email
         to turn an email into a to-do or an event.
```

## One message, end to end

1. `run_turn` creates a `TaskBudget` and calls `run_task` with the message.
2. `run_task` puts the budget in a context variable and streams
   `agent.astream(..., subgraphs=True)`; the CLI prints text, tool calls and
   helper steps (indented) as they arrive.
3. Before every model call, in any agent, `TaskBudgetMiddleware` takes one unit.
   The main agent sees its system prompt (role + persona: style, "Sir",
   user profile, `config/persona.md`; built by `agent/persona.py`) plus the
   scratchpad (todos + notes) and long-term memory (pinned + keyword
   matches for the message; `agent/longterm.py`).
4. The model either answers, calls a direct tool, or calls `ask_<helper>`.
   A helper runs its own capped loop and returns ≤ 300 words (the
   researcher: ≤ 60 words of facts; the main agent phrases the reply).
5. A risky tool (write, edit, run, send…) or `ask_user` pauses the graph. The
   run ends; `run_task` returns the pending pauses from `aget_state()`.
6. `run_turn` asks you, then calls `run_task` again with
   `Command(resume={id: answer})` and the same budget. Repeat until no pauses.
7. Any `remember` / `suggest_*` call only queued a suggestion; the user
   accepts or declines it in the web Memory panel or with `/memory`
   (`docs/memory.md`).
8. The checkpointer has saved messages, scratchpad and any paused helper
   state under the thread id; old messages get summarized past 12k tokens
   (the newest ~4k tokens stay word-for-word, so summaries stay rare).

Sessions: a session is a thread id. The CLI and every browser tab start a
new one each time; old ones are listed from the checkpoints and resumed
or deleted on request (`agent/sessions.py`).

The web path is the same loop split over socket messages: `message` →
steps 1–5, the pauses go to the browser as `pause`, and `resume` is step 6.
Helper events carry `parent` (the `ask_*` call id, passed through the
helper run's metadata) so the HUD can nest them, and each run ends with a
`context` event (thread tokens vs. the summarization point) before
`done` / `pause`. `cancel` (STOP / Esc while running) cancels the run's
asyncio task, which stops any helpers inside it.
Protocol: `docs/web-ui.md`.

Telegram (`channels/telegram.py`): one private chat = one Chat, like a tab.
A message is downloaded and turned into text (voice notes go through
Whisper, photos and files are saved to `workspace/telegram/`; photos also
go in as image blocks when `LUNA_MODEL_VISION=true`) and run with
`run_task`. The reply is the main agent's `token` text, sent when the run
ends (plus a Piper voice note when the message was a voice note). Pauses
become a card with Approve / Reject buttons (`callback_data` holds a prefix
of the pause id), or the next text reply answers them. Only users in
`LUNA_TELEGRAM_ALLOWED_USERS` reach the agent. Routine results reach the
bot as an AgentHost listener.

## Files

```
src/luna/
  cli/chat.py              REPL (luna [--resume]), printing, pause handling (run_turn,
                           answer_interrupt), /sessions /resume /delete (session_command),
                           /memory (memory_command)
  voice/tts.py             PiperTTS: local text-to-speech for the web UI (/api/tts)
  voice/stt.py             WhisperSTT: local speech-to-text for the web UI (/api/stt)
  web/
    server.py              luna-web: Starlette app, AgentHost (model switch), /ws Session
                           (background runs, cancel + cancel_cleanup, memory panel
                           messages), /api/tts, /api/stt,
                           origin check, serves web/dist; main(): serve + open the app
                           window (or only open one if Luna already runs)
    events.py              stream events → JSON; pause describe / answer conversion
    window.py              app window: find a Chromium browser, open --app with its own
                           profile, stop the server when it closes, .desktop launcher entry
    control.py             /api/control/*: settings, MCP connectors, Google connect, providers,
                           permissions, stats, dashboard prefs, routines, cron check
  channels/
    telegram.py            TelegramBridge (luna-web starts it when LUNA_TELEGRAM_BOT_TOKEN is set):
                           long-poll loop, allow-list, Chat per private chat, voice / photo / file
                           intake, approvals (buttons or "yes"/"no"/reason), /new /stop /help,
                           routine alerts
    telegram_api.py        TelegramAPI: the few Bot API calls over httpx; token kept out of errors
    media.py               decode_audio (voice note → 16 kHz), wav_to_ogg_opus (Piper → voice note),
                           pick_photo, split_text (4096-char limit), safe_filename
  config/settings.py       all LUNA_* settings
  config/envfile.py        read / edit .env in place (comments kept, atomic)
  config/schema.py         settings → grouped form schema (secrets masked, live/rebuild/restart);
                           save_settings (validate, roll back)
  routines/
    cron.py                5-field cron: parse, next_run, describe
    store.py               RoutineStore (SQLite): routines, runs, usage per day
    builtin.py             mail_check / agenda / todos: one read-only MCP tool each, no LLM
    agent.py               run_agent_routine: prompt on thread routine-<id>, approvals rejected
    scheduler.py           RoutineScheduler: due routines one at a time → routine_result
  agent/
    builder.py             build_agent (model, checkpointer, MCP) → assemble_agent (tools,
                           middleware, delegates); assemble again = switch model
    providers.py           OpenRouter / Groq / Ollama → ChatOpenAI; list models
    persona.py             build_system_prompt: role + reply style + title + user profile + persona file
    runner.py              run_task: one run with budget + event stream + pending pauses
    budget.py              TaskBudget + TaskBudgetMiddleware
    scratchpad.py          notes state, write_note, ScratchpadMiddleware
    sessions.py            list / resolve / delete saved sessions (threads), new_session_id
    longterm.py            LongTermStore (SQLite + FTS5, suggestions, history/undo),
                           recall/remember/suggest_* tools, LongTermMemoryMiddleware
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
  integrations/google.py   Google OAuth shared by the servers: credentials (refresh, scope check),
                           service, execute, luna-google-auth
config/mcp_servers.json    MCP servers: demo (main), tasks + mail + google (assistant), LangChain docs (researcher)
config/persona.md          optional extra instructions for Luna (git-ignored; see persona.example.md)
servers/demo_mcp_server.py sample MCP server
servers/tasks_mcp_server.py local to-dos (data/tasks.json) for ask_assistant, two-way
                           synced with Google Tasks; add_task_from_email
servers/mail_mcp_server.py  inbox read + send / reply for ask_assistant over the Gmail API
                           (default) or IMAP/SMTP; fetch_email / email_reference for the others
                           (sending asks for approval; docs/mail.md)
servers/google_mcp_server.py Google Calendar for ask_assistant; get_agenda adds to-dos;
                           create_event_from_email via the mail server's fetch_email (docs/google.md)
tests/                     pytest suite (fake models, no API key)
web/                       browser UI (Vite + React + React Three Fiber); `npm run build` → web/dist
  src/App.tsx              voice loop, pauses, keyboard; src/lib (socket, reducer, speech),
  src/core (3D core), src/components (HUD, drawer, pause card, memory panel,
  InsightWidgets), src/components/control (Control Center apps), src/lib/control.ts
  (Control API client), src/control.css
docs/README.md             index of all docs
docs/configuration.md      every LUNA_* setting, what lives where
docs/cli.md                luna commands, /memory, approvals
docs/agents-and-tools.md   main agent, helpers, MCP servers, how to extend
docs/development.md        setup, layout, tests, web dev, which docs to update
docs/web-ui.md             running the web UI, WebSocket protocol
docs/control-center.md     Control Center: apps, routines, what applies when, HTTP API
docs/memory.md             short- vs long-term memory, suggestions inbox, /memory
docs/mail.md               mail setup, tools, approval
docs/messaging.md          Telegram bot: setup, voice notes, photos, approvals, security
docs/google.md             Google sign-in (Gmail, Calendar, Tasks), calendar tools, to-do sync, email → to-do / event
site/                      product website (Vite + React): src/content.ts holds all copy,
                           src/sections/* lay it out, public/screens/ real screenshots
                           (demo data); deployed to GitHub Pages by .github/workflows/site.yml
spec/                      design specs; DECISIONS.md; this file
.github/                   CI (pytest + web + site test/build), Pages deploy (site.yml),
                           issue and PR templates
LICENSE, CONTRIBUTING.md,  MIT licence, contributor guide, code of conduct,
CODE_OF_CONDUCT.md,        private vulnerability reporting
SECURITY.md
```

## Not built yet

Voice in the CLI, a wake word that works without the web page open,
semantic (embedding) search for long-term memory, and a WhatsApp channel
(see spec11 §6).
