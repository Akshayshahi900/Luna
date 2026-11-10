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
  - Listening: Whisper (base.en, ONNX) on onnxruntime via
    `@huggingface/transformers`, with a silence gate.
  - Speaking: the same Piper voices on onnxruntime; `espeak-ng` makes the
    phonemes.
  - Telegram audio goes through `ffmpeg`.
  - Section 3 below explains why this replaced the first plan.
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
- **Tests:** the pytest suite is ported to vitest (`core/test/`, 316
  tests, fake model, no API keys).
- **Docs updated:** README, ARCHITECTURE, DECISIONS D41–D43, spec12, `docs/`,
  the beginner guide, `.env.example`, CONTRIBUTING, CI, and the website copy.

## 2. pnpm instead of npm

- `pnpm-workspace.yaml` holds core, web and site, with one
  `pnpm-lock.yaml`. The `package-lock.json` files are gone.
- `allowBuilds` lets `better-sqlite3` build its native binding. It skips
  the postinstalls of `onnxruntime-node` (optional CUDA downloads) and
  `protobufjs` (a notice).
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

## 3. Verified for real (2026-11-10)

Beyond the fake-model tests, every part was run against the real thing:

| What | How | Result |
| --- | --- | --- |
| Backend | `pnpm typecheck`, `pnpm test` | clean, 315 passed + 1 opt-in |
| Web UI / site | `pnpm --filter luna-web test` / `luna-site test`, both builds | 94 and 9 passed, builds OK |
| Speech in | espeak-ng speech → `/api/stt` on the real server | "Hey Luna, what time is it in London?" in ~0.9 s |
| Silence | quiet noise → Whisper | "" (no invented words) |
| Speech out | `/api/tts` on the real server | a 22 kHz WAV in ~0.2 s; Whisper reads it back word for word |
| Telegram audio | speech → OGG/Opus → `decodeAudio` → Whisper | exact text |
| CLI | `pnpm luna`, real Groq model | calculator (391) and stdio MCP tool (`reverse_text` → "anuL") used, saved, `/sessions` lists it |
| Web chat | real socket turn on `pnpm web` | streamed tool call `calculator 12 * 12` → "The result is 144, Sir." |
| MCP | real start-up with the repo config | demo, tasks, mail, google and LangChain docs all loaded |

Problems that only the real runs found, all fixed:

- **Speech-to-text engine replaced (D43).** The planned whisper.cpp binding
  crashed on this CPU (an AVX-512 build) or was far too slow (24 s per
  command, no SIMD). Whisper now runs on onnxruntime, which picks the CPU's
  best instructions at runtime.
- **Whisper heard words in silence** ("you", "Thank you."). A silence gate
  now returns "" for quiet audio, as the Python VAD filter did.
- **Text-to-speech engine replaced (D43).** The Piper program couldn't be
  run or tested here. The same Piper voices now run in-process on
  onnxruntime, with `espeak-ng` for phonemes. The
  `LUNA_TTS_PIPER_COMMAND` setting is gone.
- **The Groq default model was retired by Groq** (404). The new default is
  `openai/gpt-oss-120b`, which your key can use. If you'd rather choose,
  set `LUNA_GROQ_MODEL`; the Control Center lists what your key offers.

Notes from the live runs:

- One `gpt-oss-120b` reply had a run of "… … ..." before the real answer.
  That text is in the model's own saved message, so it's the model's
  output, not Luna's. A different model (`LUNA_GROQ_MODEL`, or
  OpenRouter) avoids it.
- Not run live: the Telegram bot against Telegram's servers, and
  Gmail/Calendar/Tasks/IMAP against Google or a mail server. Their code
  paths are covered by the tests with fake clients, and their MCP servers
  start and list their tools.

## System programs for voice

`espeak-ng` (Luna's voice) and `ffmpeg` (Telegram voice notes), from
your package manager. Without them Luna still works, and the UI uses the
browser's speech.

## Leftovers you can clean up

- `.venv/`
- The old faster-whisper folders in `data/models/whisper/` (`models--Systran--…`)
- `data/luna_memory.sqlite`, which holds the old Python threads

Nothing is committed yet.
