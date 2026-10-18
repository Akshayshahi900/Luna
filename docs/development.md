# Development

How to work on Luna itself. Contribution rules are in
[`CONTRIBUTING.md`](../CONTRIBUTING.md).

## Setup

```bash
uv sync                          # Python 3.14 + dev dependencies (pytest)
cp .env.example .env             # add a key, or use Ollama locally
cd web && npm install && cd ..   # web UI (Node 22+)
```

## Repository layout

```
src/luna/        the Python package (agent, tools, CLI, web server, voice)
servers/         MCP servers started by config/mcp_servers.json
config/          MCP config and persona example
web/             browser UI (Vite + React + React Three Fiber)
tests/           pytest suite
docs/            user and developer guides (this folder)
spec/            design specs, one per feature milestone
ARCHITECTURE.md  how the pieces fit, file by file
DECISIONS.md     architectural decisions (D1, D2, …), newest last
```

Start reading at [`spec/beginner-guide.md`](../spec/beginner-guide.md),
then `src/luna/agent/builder.py`.

## Tests

```bash
uv run pytest                    # whole suite
uv run pytest tests/test_fs.py   # one file
uv run pytest -k approval        # by name
cd web && npm test               # web logic (vitest, *.test.ts next to the module)
cd web && npm run build          # type-check + production build
```

Tests never call a real model. `tests/conftest.py` provides
`FakeToolModel`, a scripted chat model that records what it was sent, so
you can assert on prompts, tool calls and approvals. Keep new tests that
way: no network, no API keys, no free-tier usage.

CI (`.github/workflows/ci.yml`) runs all three commands on every pull
request.

## Web UI development

```bash
uv run luna-web                  # backend on :8765
cd web && npm run dev            # Vite on :5173 with hot reload
```

The Vite origin is allowed by default (`LUNA_WEB_ALLOWED_ORIGINS`). The
WebSocket protocol is documented in [`web-ui.md`](web-ui.md); its types
are in `web/src/lib/protocol.ts` and `src/luna/web/events.py`.

## Keeping docs in step

| You changed… | Update |
| --- | --- |
| an architectural choice | add `D<n>` to `DECISIONS.md` |
| files, topology, data flow | `ARCHITECTURE.md` |
| a setting | `settings.py` field description, `.env.example`, [`configuration.md`](configuration.md) |
| a CLI command | `HELP_TEXT` in `cli/chat.py`, [`cli.md`](cli.md) |
| a tool, helper or MCP server | [`agents-and-tools.md`](agents-and-tools.md) |
| feature design | the matching `spec/specN.md` |
