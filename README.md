# Luna

[![CI](https://github.com/Akshayshahi900/Luna/actions/workflows/ci.yml/badge.svg)](https://github.com/Akshayshahi900/Luna/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Node.js 22.18+](https://img.shields.io/badge/node-22.18%2B-339933.svg) ![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6.svg)
[![Website](https://img.shields.io/badge/website-luna-22d8ff.svg)](https://akshayshahi900.github.io/Luna/)

![Luna's voice-first web UI: the orb, live mail/calendar/to-do cards and the helper agents panel](site/public/screens/hud.webp)

A general assistant on LangGraph: one main agent that does quick work
itself and hands bigger jobs to helper agents — **researcher** (web),
**files**, **coder** and **assistant** (to-dos synced with Google Tasks, Gmail and Google Calendar via MCP). Risky
actions (writing files, running commands, sending things) ask you first.

## Requirements

- [Node.js](https://nodejs.org) 22.18 or newer (it runs Luna's TypeScript
  directly, no build step) and [pnpm](https://pnpm.io) 10 or newer
- An [OpenRouter](https://openrouter.ai/keys) or [Groq](https://console.groq.com/keys)
  API key, or a local [Ollama](https://ollama.com) model that supports tools
- For voice (optional): `espeak-ng` for Luna's voice, and `ffmpeg` for
  Telegram voice notes (both from your package manager)

## Quick start

```bash
# 1. Install (one pnpm workspace: core/, web/, site/) and build the web UI
pnpm install && pnpm build
# 2. Add your OpenRouter credentials to .env
cp .env.example .env
# Replace `your_openrouter_api_key_here` with your key in .env

# 3. Optional: web research — add LUNA_TAVILY_API_KEY (https://app.tavily.com)
#    Optional: Gmail + Calendar + Google Tasks sync — pnpm google-auth (docs/google.md)
#    (or IMAP mail with an app password: LUNA_MAIL_BACKEND=imap, docs/mail.md)

# 4. Chat
pnpm luna            # always a new session
pnpm luna --resume   # continue the most recent one (or --resume <n|id>)
```

Every start (and every web tab or reload) opens a **new session**. In the
CLI, `/sessions` lists saved ones, `/resume <n>` continues one and
`/delete <n>` removes it. In the web UI, open the transcript (**T**) and
click `SESSION · … ▾`.

### Web UI (voice-first)

```bash
pnpm web   # opens Luna in its own window (or http://127.0.0.1:8765)
```

Voice runs fully on your machine. Luna listens with Whisper and speaks
with a Piper voice, both on onnxruntime (models download once, ~135 MB),
and Piper uses `espeak-ng` for phonemes. Turn on **WAKE** and say
**"Hey Luna, …"** for hands-free use; "Luna, cancel" stops a task. Or press
**Space** to talk, **T** for the chat transcript, **M** to switch
between OpenRouter, Groq and Ollama models. Details and dev
setup: [`docs/web-ui.md`](docs/web-ui.md).

### From your phone (Telegram)

Create a bot with @BotFather, set `LUNA_TELEGRAM_BOT_TOKEN` and your user
id in `LUNA_TELEGRAM_ALLOWED_USERS`, and run `pnpm web`. Then send Luna
text, **voice notes** (answered by voice), photos or files, and approve her
actions with a tap. Setup: [`docs/messaging.md`](docs/messaging.md).

The files and coder helpers only touch `./workspace` unless you set
`LUNA_WORKSPACE_DIRS`. When Luna wants to write, edit or run something you
get `[a]pprove / [e]dit / [r]eject`.

Run the tests (no API key needed, the model is faked):

```bash
pnpm test             # the backend (core/, vitest)
cd web && pnpm test   # web UI logic (vitest)
```

## How it works

Every message, from the terminal, the web UI, Telegram or a scheduled
routine, goes through one agent loop. The main agent answers directly, uses
a tool, or hands a bigger job to a helper agent:

```mermaid
flowchart LR
    subgraph doors["Front doors"]
        CLI["CLI<br/>cli/chat.ts runTurn"]
        WEB["Browser tab<br/>web/session.ts Session"]
        TG["Telegram chat<br/>channels/telegram.ts Chat"]
        RT["Agent routine<br/>routines/agent.ts"]
    end

    CLI & WEB & TG & RT --> RUN["runTask<br/>agent/runner.ts<br/>TaskBudget + stream"]

    subgraph agent["Main agent (agent/builder.ts, createAgent)"]
        LOOP["agent loop<br/>middleware → model → tools"]
    end

    RUN --> LOOP
    LOOP <-->|"chat completions"| LLM[("LLM API<br/>OpenRouter / Groq / Ollama<br/>agent/providers.ts")]
    LOOP --> BUILTIN["built-in tools<br/>calculator, time, ask_user,<br/>write_todos, write_note, memory tools"]
    LOOP --> MAINMCP["untagged MCP tools<br/>(demo)"]
    LOOP --> HELPERS["ask_* helpers<br/>agent/subagents/"]
    HELPERS <-->|"own loop"| LLM
    HELPERS --> FS["files / shell<br/>tools/fs.ts, tools/shell.ts"]
    HELPERS --> WEBS["Tavily web search"]
    HELPERS --> MCP["tagged MCP servers<br/>core/servers/tasks, mail, google<br/>(stdio subprocesses)"]

    LOOP <--> CKPT[("checkpoints<br/>data/luna_checkpoints.sqlite<br/>messages, notes, todos, pauses")]
    LOOP <--> LTM[("long-term memory<br/>data/luna_longterm.sqlite")]
    RUN -->|"events"| OUT["what you see:<br/>tokens, tool calls,<br/>pauses, done"]
```

Step by step (the agent loop, what is sent to the model, helpers) and how to
trace each prompt: [`docs/prompt-lifecycle.md`](docs/prompt-lifecycle.md).
Every file: [`ARCHITECTURE.md`](ARCHITECTURE.md).

## New here? Read this first

The code can feel like a black box. Start with the beginner walkthrough:

→ **[`spec/beginner-guide.md`](spec/beginner-guide.md)**

It explains, in plain English:

- what an agent / tool / MCP / checkpointer is
- what happens when you type a message
- which file to open first
- how to add your own tool

## Documentation

Everything is indexed in [`docs/`](docs/README.md). The most useful pages:

- [`docs/configuration.md`](docs/configuration.md) — every `LUNA_*` setting
- [`docs/cli.md`](docs/cli.md) — terminal commands, `/memory`, approvals
- [`docs/agents-and-tools.md`](docs/agents-and-tools.md) — helpers, MCP servers, adding your own tools
- [`docs/development.md`](docs/development.md) — layout, tests, web dev

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — how the pieces fit, one message end to end
- [`DECISIONS.md`](DECISIONS.md) — why things are the way they are
  (D41: why the backend moved from Python to TypeScript)
- Specs: [`spec1`](spec/spec1.md) (core agent), [`spec2`](spec/spec2.md)
  (loop limits, when to use subagents), [`spec3`](spec/spec3.md) (helpers,
  task budget, scratchpad, approval), [`spec4`](spec/spec4.md) (web UI)

## Contributing

Contributions are welcome — see [`CONTRIBUTING.md`](CONTRIBUTING.md) and the
[Code of Conduct](CODE_OF_CONDUCT.md). Found a security issue? Please follow
[`SECURITY.md`](SECURITY.md) instead of opening a public issue.

## License

[MIT](LICENSE) © Akshay Shahi
