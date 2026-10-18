# Luna

A general assistant on LangGraph: one main agent that does quick work
itself and hands bigger jobs to helper agents — **researcher** (web),
**files**, **coder** and **assistant** (calendar / mail via MCP). Risky
actions (writing files, running commands, sending things) ask you first.

## Quick start

```bash
# 1. Install (uses uv)
uv sync

# 2. Add your OpenRouter credentials to .env
cp env.example .env
# Replace `your_openrouter_api_key_here` with your key in .env

# 3. Optional: web research — add LUNA_TAVILY_API_KEY (https://app.tavily.com)

# 4. Chat
uv run luna
```

### Web UI (voice-first)

```bash
cd web && npm install && npm run build && cd ..
uv run luna-web          # open http://127.0.0.1:8765 in Chrome or Edge
```

Luna speaks with a local Piper voice (downloaded once, ~60 MB) and the
core animates to her actual voice. Press **Space** to talk, **T** for the chat transcript, **M** to switch
between OpenRouter, Groq and Ollama models. Details and dev
setup: [`docs/web-ui.md`](docs/web-ui.md).

The files and coder helpers only touch `./workspace` unless you set
`LUNA_WORKSPACE_DIRS`. When Luna wants to write, edit or run something you
get `[a]pprove / [e]dit / [r]eject`.

Run the tests (no API key needed, the model is faked):

```bash
uv run pytest
cd web && npm test       # web UI logic (vitest)
```

## New here? Read this first

The code can feel like a black box. Start with the beginner walkthrough:

→ **[`spec/beginner-guide.md`](spec/beginner-guide.md)**

It explains, in plain English:

- what an agent / tool / MCP / checkpointer is
- what happens when you type a message
- which file to open first
- how to add your own tool

## Configuration

See `env.example` and `config/mcp_servers.json`.

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — how the pieces fit, one message end to end
- [`DECISIONS.md`](DECISIONS.md) — why things are the way they are
- Specs: [`spec1`](spec/spec1.md) (core agent), [`spec2`](spec/spec2.md)
  (loop limits, when to use subagents), [`spec3`](spec/spec3.md) (helpers,
  task budget, scratchpad, approval), [`spec4`](spec/spec4.md) (web UI)
