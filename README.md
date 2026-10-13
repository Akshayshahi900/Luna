# Luna

Scalable LangGraph chatbot with conversation memory and pluggable tools
(native `@tool` functions and MCP servers).

## Quick start

```bash
# 1. Install (uses uv)
uv sync

# 2. Add your OpenRouter credentials to .env
cp config/env.example .env
# Replace `your_openrouter_api_key_here` with your key in .env

# 3. Chat
uv run luna
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

See `config/env.example` and `config/mcp_servers.json`.

Design / implementation notes: [`spec/spec1.md`](spec/spec1.md).
