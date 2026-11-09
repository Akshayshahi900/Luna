# Spec 12 — The backend in TypeScript

**Date:** 2026-11-09  
**Status:** Implemented.  
**Scope:** Rewrite everything that was Python — agent, web server, Control
Center, routines, Telegram, voice, CLI and the MCP servers — in TypeScript,
in one `core/` package, without changing what Luna does or the browser
protocol.

Decision: [`DECISIONS.md`](../DECISIONS.md) D41. Layout: [`ARCHITECTURE.md`](../ARCHITECTURE.md).

---

## 1. Goal

- One language and one toolchain (Node + pnpm) for the whole repo. `web/`
  and `site/` were TypeScript already.
- Same behaviour: every feature from spec1–spec11 works as before, and the
  ported test suite says so.
- Same data where possible: memories, routines, to-dos, settings, MCP
  config and the Google sign-in carry over.
- No build step: Node ≥ 22.18 runs `.ts` files as they are.

## 2. Shape

```
package.json                  pnpm build / luna / web / google-auth / test
pnpm-workspace.yaml           the workspace: core, web, site (one pnpm-lock.yaml)
core/
  package.json, tsconfig.json strict, noEmit, erasableSyntaxOnly, .ts imports
  bin/                        luna, luna-web, luna-google-auth (thin wrappers)
  src/
    config/                   settings (one field table), envfile, schema
    agent/                    builder, runner, budget, limits, scratchpad,
                              longterm, memory, sessions, persona, providers,
                              types, subagents/
    tools/                    fs, shell, limits, registry, runtime, builtin/
    mcp/loader.ts             MultiServerMCPClient, splitByAgent, risky names
    routines/                 cron, store, builtin, agent, scheduler
    web/                      server (Hono + ws), session, events, control, window
    channels/                 telegram, telegram_api, media (ffmpeg)
    voice/                    stt (whisper.cpp), tts (Piper program), wav, download
    integrations/google.ts    OAuth (google-auth token.json format kept)
    util/zoned.ts             wall-clock time in an IANA zone
  servers/                    demo, tasks, mail, google, common (MCP SDK)
  test/                       vitest, one file per area (helpers.ts = fake model)
```

| Python | TypeScript |
| --- | --- |
| `langchain.agents.create_agent` + middleware | `langchain` `createAgent` + the same middleware |
| `contextvars` (task budget) | `AsyncLocalStorage` |
| `AsyncSqliteSaver` | `@langchain/langgraph-checkpoint-sqlite` `SqliteSaver` |
| `MCPAdapter` | `@langchain/mcp-adapters` `MultiServerMCPClient` |
| FastMCP servers | `@modelcontextprotocol/sdk` `McpServer` |
| pydantic-settings | `config/settings.ts`: a field table + loader |
| `sqlite3` | `better-sqlite3` (same schemas) |
| Starlette + uvicorn | Hono on Node's `http` + `ws` for `/ws` |
| faster-whisper | `@fugood/whisper.node` (whisper.cpp, prebuilt) |
| piper-tts | the Piper program (`data/piper/`, PATH or `LUNA_TTS_PIPER_COMMAND`) |
| PyAV | `ffmpeg` |
| google-api-python-client | `googleapis` |
| imaplib / smtplib / email | imapflow / nodemailer / mailparser |
| httpx (Telegram, model lists) | `fetch` |
| pytest + `conftest.py` | vitest + `test/helpers.ts` |

## 3. Rules

- **Behaviour first.** Each module is a port, not a redesign: the same
  names (camelCase for functions), the same "BEGINNER MAP" comments, the
  same messages to the model and the user.
- **The browser protocol is frozen.** `/ws` and `/api/*` send the same JSON.
  LangChain JS's camelCase pause format (`actionRequests`, `reviewConfigs`,
  `editedAction`) is translated in `web/events.ts`, so `web/` needs no
  change.
- **Settings keep their names** (`model_name`, `LUNA_MODEL_NAME`), because
  they are also the Control Center's field names.
- **Events are deduped by message id.** LangChain JS middleware nodes report
  the whole message list in "updates". The translator remembers the ids it
  has reported and is primed with the thread's messages before each run,
  so earlier turns never come back as new tool calls.
- **Loop limits reset per message.** LangChain JS doesn't reset the run
  counters of its model and tool call limits when a run ends at the limit.
  `resetRunLimitsMiddleware` zeroes both in `beforeAgent`.
- **Cancel is an AbortSignal.** It reaches every node, subagent and
  `run_command` (whose process group is killed). `cancelCleanup` then
  answers the open tool calls, as before.
- **MCP tool names stay plain.** The JS adapter would prefix every tool
  with its server's name. Luna turns that off and only prefixes a name that
  two servers of one group share.
- **Native programs are checked, not trusted.** Piper must answer `--help`
  with `--model` before it is used. A missing program degrades to browser
  speech, as a missing Python wheel did.

## 4. Data

| File | Carried over |
| --- | --- |
| `.env`, `config/mcp_servers.json` | yes (MCP commands now `node core/servers/*.ts`) |
| `data/luna_longterm.sqlite` | yes, same schema |
| `data/luna_routines.sqlite` | yes, same schema |
| `data/tasks.json`, `dashboard.json`, `telegram.json` | yes |
| `data/google/token.json` | yes: read and written in google-auth's format |
| `data/voices/*.onnx` | yes, Piper uses the same voice files |
| `data/luna_memory.sqlite` (threads) | **no**: msgpack checkpoints LangGraph JS can't read; new threads go to `data/luna_checkpoints.sqlite` |
| `data/models/whisper/` (faster-whisper) | no: whisper.cpp uses `ggml-<model>.bin`, downloaded once |

## 5. Tests (`core/test/`, offline)

The pytest suite was ported test by test to vitest. It has 310 tests over
19 files, uses the same fake chat model, and needs no network or API key.
New in the port:
- Echoed messages aren't reported twice.
- Python token files are accepted.
- Calendar times are correct across DST.
- Duplicate MCP tool names get a server prefix.
- Static files are served with an `index.html` fallback.
- The Telegram voice round trip goes through real ffmpeg.

## 6. Later

- Keep one Piper process alive (`--json-input`) instead of one run per
  sentence. That waits on testing its output protocol.
- Re-measure STT and TTS latency against the Python numbers in
  `docs/web-ui.md`.
- Silero VAD in whisper.cpp (`initWhisperVad`), if noise starts to produce
  invented words.
