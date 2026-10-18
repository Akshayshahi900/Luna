# Web UI

A voice-first, sci-fi HUD for Luna. You talk; a 3D reactor core reacts
(listening, processing, speaking); Luna answers out loud. Text chat is
there too, in a side drawer, but it's secondary.

Design and reasons: [`spec/spec4.md`](../spec/spec4.md), `DECISIONS.md` D15–D18.

## Run it

```bash
# once
uv sync
cd web && npm install && cd ..

# production-style: one server on :8765 serves the page and the agent
cd web && npm run build && cd ..
uv run luna-web                     # → http://127.0.0.1:8765

# frontend development (hot reload)
uv run luna-web                     # terminal 1: agent on :8765
cd web && npm run dev               # terminal 2: page on http://localhost:5173
```

Vite proxies `/ws` and `/api` to `:8765` (override with `LUNA_BACKEND=http://host:port`).

The first start downloads Luna's voice (Piper `en_US-lessac-medium`,
~60 MB) into `data/voices/`, in the background; until it's ready, replies
use the browser's voice.

Use **Google Chrome or Edge** for voice input. Firefox has no speech
recognition, and Chromium builds usually lack Google's speech keys (you get
a `network` error). Without it the UI falls back to typing; replies are
still spoken.

## Using it

| Do | How |
| --- | --- |
| Talk | **Space** or the big button. Talking while Luna speaks interrupts her. |
| Hush | **Esc**, or say "stop" / "quiet" |
| Type instead | **/** or TYPE |
| Transcript / chat | **T** or LOG (also new thread, switch thread) |
| Conversation mode | CONVO: after each spoken reply Luna listens again |
| Mute voice + sounds | VOICE |
| Switch model / provider | **M**, or click `UPLINK · …` (top right) or LINK in SUBSYSTEMS |
| Approve a risky action | say "approve" / "yes, go ahead", or "deny" / "no"; or click AUTHORIZE / MODIFY / DENY |
| Answer a question | just say (or type) the answer |

Core colors: cyan = standing by, bright cyan = listening, violet =
processing, pale cyan = speaking, amber = waiting for your approval,
red = error, grey = no connection. Each helper subagent that is working
shows as a satellite orbiting the core and lights up in SUBSYSTEMS.

## Voice and the core

Luna's replies are spoken by **Piper**, a small neural voice that runs
locally on the CPU (Windows, macOS, Linux; ~0.1–0.4 s per sentence, about
14× faster than real time). Each sentence is synthesized by `POST /api/tts`
as soon as it's complete, so the next one is ready while the current one
plays.

The browser plays the audio through an `AnalyserNode` and the core
follows the actual sound, every frame:

| Voice feature | Measured as | Core reaction |
| --- | --- | --- |
| Loudness | RMS, soft curve `1 − e^(−4·rms)` | orb deformation, brightness, particle speed |
| Voice body (80–300 Hz) | band vs. its recent peak | whole orb swells, inner light pulses |
| Vowels (300–2000 Hz) | band vs. its recent peak | rings glow brighter |
| Consonants (2–7 kHz) | band vs. its recent peak | fine ripples, rim flashes white |
| Spectrum (64 log-spaced bands) | 80 Hz – 7 kHz | the circular waveform |
| Syllable onsets | fast vs. slow envelope, with re-arm | a shockwave ring bursts outward |

Each band is measured against its own recent peak (`AutoRange`), so the
same tuning works for any voice, mic or browser. Your mic while listening
goes through the same analyser.

If Piper is off (`LUNA_TTS_ENGINE=browser`) or fails three sentences in a
row, Luna uses the browser's voice. That has no audio to analyse, so the
core falls back to an estimate from word timing.

Other voices: `LUNA_TTS_VOICE=en_GB-jenny_dioco-medium`, `en_GB-alba-medium`,
`en_US-amy-medium`… (list: https://huggingface.co/rhasspy/piper-voices).
Pace: `LUNA_TTS_LENGTH_SCALE` (< 1 faster). Note: `piper-tts` is GPL-3.0.

## Switching models

The NEURAL LINK popover lists OpenRouter, Groq and Ollama. Pick one, pick
or type a model (the list comes from the provider's `/models` endpoint),
and press ENGAGE. The server rebuilds the agent with that model: main
agent, every helper and the summarizer switch together; memory and MCP
connections are kept, so the conversation carries on. The switch applies
to every open tab and lasts until the server restarts (the startup choice
is `LUNA_PROVIDER`).

- A provider without an API key shows `NO KEY` and can't be picked.
- Ollama needs `ollama serve` running and a model that supports tool
  calling (e.g. `qwen3`, `llama3.1`). If it isn't reachable the popover
  says so; you can still type a model name.
- A wrong model name is only noticed on the next message (it comes back
  as an error); switch again to fix it.

## Settings

| Env var | Default | Meaning |
| --- | --- | --- |
| `LUNA_PROVIDER` | `openrouter` | Startup provider: `openrouter`, `groq` or `ollama` |
| `LUNA_GROQ_API_KEY` / `LUNA_GROQ_MODEL` | — / `llama-3.3-70b-versatile` | Groq |
| `LUNA_OLLAMA_BASE_URL` / `LUNA_OLLAMA_MODEL` | `http://localhost:11434/v1` / `qwen3:8b` | Ollama |
| `LUNA_TTS_ENGINE` | `piper` | `piper` (local voice, core follows real audio) or `browser` |
| `LUNA_TTS_VOICE` | `en_US-lessac-medium` | Piper voice, downloaded once |
| `LUNA_TTS_VOICES_DIR` | `data/voices` | Where voices are kept |
| `LUNA_TTS_LENGTH_SCALE` | `0.95` | Speaking pace (< 1 faster) |
| `LUNA_WEB_HOST` | `127.0.0.1` | Listen address. Keep it local: the agent can write files and run commands. |
| `LUNA_WEB_PORT` | `8765` | Port |
| `LUNA_WEB_ALLOWED_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173` | Extra browser origins allowed to open the socket (the server's own origin is always allowed) |

## WebSocket protocol (`/ws`)

JSON messages, one per frame. Server side: `src/luna/web/server.py`
(`Session`) and `events.py`; browser side: `web/src/lib/protocol.ts`.

### Server → browser

| type | fields | when |
| --- | --- | --- |
| `hello` | `provider`, `model`, `providers: [{id, label, configured, default_model}]`, `can_switch`, `tools`, `helpers`, `budget`, `tts` (`"piper"` or `"browser"`) | on connect |
| `model` | `provider`, `model` | the model was switched (sent to every tab) |
| `models` | `provider`, `models`, `error`? | reply to `models` |
| `thread` | `id`, `history: [{role: "user"\|"luna", text}]` | on connect and after a thread switch |
| `threads` | `ids` (newest first) | reply to `threads` |
| `state` | `value: "thinking"` | a run started |
| `token` | `text` | main agent reply text, streamed |
| `tool_call` | `id`, `name`, `args`, `depth` | any agent called a tool (`depth` 0 = main, 1 = helper) |
| `tool_result` | `id`, `name`, `preview` (≤ 240 chars), `depth` | a tool returned |
| `notice` | `text`, `depth` | middleware message, e.g. a limit was reached |
| `pause` | `pauses: [...]` | the run stopped for you (see below); also sent on connect if a pause is still open |
| `done` | | the task finished |
| `error` | `message` | the run failed or a message was invalid; the socket stays open |

A pause is one of:

```json
{"id": "...", "kind": "question", "question": "Which folder?"}
{"id": "...", "kind": "approval", "actions": [{"name": "write_file", "args": {...}, "description": "...", "allowed": ["approve", "edit", "reject"]}]}
{"id": "...", "kind": "other", "text": "..."}
```

Note: when an approval is resumed, the approval middleware re-sends the
same `tool_call` (same `id`). The browser updates the existing entry.

### HTTP

| Route | |
| --- | --- |
| `POST /api/tts` `{"text": "..."}` | WAV (16-bit mono) of one sentence. 400 for empty/over 1000 chars, 403 foreign origin, 404 when TTS is off, 500 if synthesis fails |
| `GET /api/health` | `{status, provider, model}` |

### Browser → server

| type | fields | effect |
| --- | --- | --- |
| `message` | `text` | start a task (fresh task budget). Refused while a pause is open. |
| `resume` | `answers: {pause_id: reply}` | answer **every** open pause; same budget continues |
| `new_thread` | | switch to a fresh thread (uuid) |
| `thread` | `id` | switch to an existing or new thread |
| `threads` | | list saved threads |
| `models` | `provider` | list that provider's models |
| `set_model` | `provider`, `model` (empty = provider default) | rebuild the agent with that model; `error` if e.g. the key is missing |

Replies: a question takes `{"answer": "text"}` (or a bare string). An
approval takes `{"decisions": [d, ...]}`, one per action, or a single one
for all, where `d` is `{"type": "approve"}`, `{"type": "reject", "message"?: "why"}`
or `{"type": "edit", "args": {...}}`. These become exactly what the CLI
sends (`answer_interrupt` in `cli/chat.py`).

## Frontend files (`web/`)

```
src/App.tsx              orchestration: voice loop, pauses, keyboard, phase
src/lib/useLuna.ts       WebSocket + reconnect
src/lib/state.ts         pure reducer for server events (tested)
src/lib/speech.ts        Speaker (Piper audio via /api/tts, browser voice fallback),
                         Listener (SpeechRecognition), cleanForSpeech + SentenceChunker (tested)
src/lib/analysis.ts      VoiceAnalyser: loudness, bands, spectrum, onsets (tested)
src/lib/intent.ts        "approve"/"deny"/"stop" voice commands (tested)
src/lib/audio.ts         mic meter, shared `live` values the core reads, UI sounds
src/lib/theme.ts         phases → colors / energy, helper codenames
src/core/                the 3D core (React Three Fiber, shaders, bloom)
src/components/          HUD, captions, dock, command line, chat drawer, pause card,
                         boot, ModelSwitcher (provider/model popover)
```

Tests: `cd web && npm test` (vitest, pure modules) and `uv run pytest tests/test_web.py`.

## Limits / next steps

- Voice *input* runs in the browser (Web Speech API): Chrome/Edge only,
  and Chrome sends audio to Google. A local STT (e.g. Whisper) endpoint
  would remove both limits. Voice *output* is already local (Piper).
- No wake word yet; conversation mode is the hands-free option.
- A task can't be cancelled from the UI (cancelling mid-tool would leave
  the thread with an unanswered tool call). "Stop" only silences speech.
