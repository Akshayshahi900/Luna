# Migration notes: Python → TypeScript, npm → pnpm

What changed on 2026-11-09. The details are in [`DECISIONS.md`](DECISIONS.md)
D41 (TypeScript) and D42 (pnpm), [`spec/spec12.md`](spec/spec12.md) and
[`ARCHITECTURE.md`](ARCHITECTURE.md).

## 1. The backend is now TypeScript (`core/`)

- **Everything that was Python is ported to `core/`:**
  - the agent, its subagents, memory and middleware
  - the web server (Hono + `ws`), the Control Center and routines
  - the Telegram bot, voice, the CLI
  - the four MCP servers (`core/servers/`)
- **No build step:** Node ≥ 22.18 runs the `.ts` files directly. `tsc` only
  type-checks (strict).
- **Deleted:** `src/luna/`, `servers/*.py`, `tests/`, `pyproject.toml`,
  `uv.lock`, `.python-version`.
- **Browser protocol unchanged:** `web/` only got comment and text updates.
- **Voice:**
  - Listening: whisper.cpp via `@fugood/whisper.node`.
  - Speaking: the Piper program, from `data/piper/`, PATH, or the new
    `LUNA_TTS_PIPER_COMMAND` setting.
  - Telegram audio goes through `ffmpeg`.
- **Two LangChain JS quirks are worked around:**
  - Loop-limit counters didn't reset between messages
    (`agent/limits.ts`).
  - Stream "updates" repeat old messages, so events are deduped by id
    (`web/events.ts`).
- **Data:**
  - Carried over: memories, routines, to-dos, `.env`, the MCP config and
    the Google token (same format, so no new sign-in).
  - Not carried over: old chat threads. They now live in
    `data/luna_checkpoints.sqlite`.
- **Tests:** the pytest suite is ported to vitest (`core/test/`, 310
  tests, fake model, no API keys).
- **Docs updated:** README, ARCHITECTURE, DECISIONS D41, spec12, `docs/`,
  the beginner guide, `.env.example`, CONTRIBUTING, CI, and the website copy.

## 2. pnpm instead of npm

- `pnpm-workspace.yaml` holds core, web and site, with one
  `pnpm-lock.yaml`. The `package-lock.json` files are gone.
- `allowBuilds` lets `better-sqlite3` build and skips
  `@fugood/whisper.node`, whose prebuilt binaries are optional packages.
- CI (`ci.yml`, `site.yml`) uses `pnpm/action-setup` and
  `pnpm install --frozen-lockfile`.
- All docs, the site and in-app hints now say pnpm.

## Commands

```bash
pnpm install && pnpm build   # install everything, build web/dist
pnpm web                     # web UI (add --no-window, --install-desktop)
pnpm luna                    # terminal chat (add --resume)
pnpm google-auth             # one-time Google sign-in
pnpm test                    # backend tests (fake model)
pnpm typecheck               # tsc --noEmit
```

## Verified

- Core typecheck passes and 310/310 tests pass.
- The web and site production builds (with their type-checks) pass.
- A safe start-up of `luna-web` with the real config, without sending a
  chat message:
  - all MCP servers loaded
  - the socket hello came back
  - the page was served

## Not verified yet

- A real conversation with a model (CLI or web).
- Real Piper and Whisper voice, and voice latency.
- The live Telegram bot, and live Gmail/Calendar/Tasks/IMAP.
- The `web/` and `site/` test suites (not run; only their builds were).

## Leftovers you can clean up

- `.venv/`
- The old faster-whisper files in `data/models/whisper/`
- `data/luna_memory.sqlite`, which holds the old Python threads

Nothing is committed yet.
