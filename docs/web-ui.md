# Web UI

A voice-first, sci-fi HUD for Luna. You talk; a 3D reactor core reacts
(listening, processing, speaking); Luna answers out loud. Text chat is
there too, in a side drawer, but it's secondary.

Design and reasons: [`spec/spec4.md`](../spec/spec4.md), `DECISIONS.md` D15–D23.

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

The first start downloads, in the background, Luna's voice (Piper
`en_US-lessac-medium`, ~60 MB, into `data/voices/`) and her ears (Whisper
`base.en`, ~140 MB, into `data/models/whisper/`). Both run locally on the
CPU; nothing you say or hear leaves the machine, and it works in any
modern browser (Chrome, Edge, Firefox, Safari).

The browser asks for microphone access the first time. Turn on **WAKE**
in the dock for hands-free use.

## Using it

| Do | How |
| --- | --- |
| Hands-free | **WAKE** on: the mic stays open; start with **"Hey Luna, …"** (or just "Hey Luna", wait for "Yes?") |
| Push-to-talk | **Space** or the big button: one utterance, no wake word. Space again ends it early. |
| Interrupt her | say "Luna, …" while she talks (or press Space) |
| Hush | **Esc** (when no task is running), or say "stop" / "quiet" |
| Stop the task | **Esc** while a task runs, the STOP button, or say **"Luna, cancel"** / "never mind". Stops the main agent and any helpers and logs INTERRUPTED in NEURAL ACTIVITY. STOP also abandons an open approval/question; Esc does not. |
| Type instead | **/** or TYPE |
| Transcript / chat | **T** or LOG |
| Sessions | every tab and every reload starts a **new session**. In the transcript, click `SESSION · … ▾` for saved sessions (title = first thing you said, last used, message count): click one to resume it, ✕ twice to delete it, + for a new one |
| Long-term memory | **K** or MEMORY (badge = Luna's suggestions waiting). Inbox: accept / edit / decline. Saved: search, add, edit, pin, delete, history + undo. See `docs/memory.md` |
| Mute voice + sounds | VOICE |
| Switch model / provider | **M**, or click `UPLINK · …` (top right) or LINK in SUBSYSTEMS |
| Approve a risky action | say "approve" / "yes, go ahead", or "deny" / "no"; or click AUTHORIZE / MODIFY / DENY |
| Steer instead of approving | "no, call it notes.md instead": the reason goes back to Luna |
| Answer a question | just say (or type) the answer |

Core colors: cyan = standing by, bright cyan = listening, violet =
processing, pale cyan = speaking, amber = waiting for your approval,
red = error, grey = no connection. Each helper subagent that is working
shows as a satellite orbiting the core and lights up in SUBSYSTEMS.

HUD details:

- **Captions** stay in the free space between the side panels and wrap.
  With the transcript (T) open, Luna's reply and your last line are hidden
  from the center (the drawer shows them); live speech and warnings still
  show, left of the drawer.
- **AGENTS** (SUBSYSTEMS): the agent that is running glows and reads
  WORKING instead of its role.
- **NEURAL ACTIVITY**: each helper's steps (RUN COMMAND, WRITE FILE, …)
  are indented under the DEPLOY … entry that started them, oldest first;
  past five, older steps fold into "+N EARLIER". Top-level entries stay
  newest first.
- **Truncated text** (MODEL, activity lines): hover for the full text,
  click (or Enter) to expand/collapse.
- **CONTEXT** (SUBSYSTEMS): tokens in the current thread's history /
  `LUNA_SUMMARY_TRIGGER_TOKENS` (the point where older messages get
  summarized; 128K if summarizing is off). Amber above 70 %, red above 90 %.
  Updated on connect, thread switch and at the end of every run.

## Voice commands

Handled in the browser, without the model (`web/src/lib/intent.ts`). Say
them after "Hey Luna" (hands-free) or as one push-to-talk utterance; the
whole utterance must be the command, so "cancel my 3pm meeting" still goes
to Luna.

| Say | Does |
| --- | --- |
| "stop", "quiet", "be quiet", "enough" | stop talking |
| "cancel", "cancel that", "abort", "never mind", "forget it" | cancel the running task or the open approval/question |
| "switch to Groq" / "use Ollama" / "change the model to OpenRouter" | switch provider (its default model) |
| "new conversation", "start over", "new chat" | new session |
| "show / hide the transcript" | open / close the chat drawer |
| "go to sleep", "stop listening" | turn hands-free off (Space wakes her) |

## Listening (speech in)

The browser records, the server transcribes:

1. An AudioWorklet streams mic frames (~21 ms) to an energy-based voice
   activity detector with an adaptive noise floor (`web/src/lib/vad.ts`):
   speech starts after 60 ms above the floor, ends after 800 ms of
   silence, and keeps 500 ms from before the start so the first syllable
   isn't cut.
2. Each utterance is resampled to 16 kHz WAV and sent to `POST /api/stt`.
   The server runs **Whisper** (`faster-whisper`, int8 on CPU) with Silero
   VAD filtering, prompted with "Hey Luna." so it spells her name right.
   About 0.3 s for a short command on a laptop CPU.
3. The browser decides what to do with the text:
   - starts with the wake phrase ("Hey Luna", "Luna", and the ways
     Whisper mishears it: "Lunar", "Hey-Lunar"…) → a command;
   - otherwise only accepted during push-to-talk, in the **follow-up
     window** (8 s after Luna replies, 10 s after a bare "Hey Luna"), or
     never while Luna is talking;
   - anything that's ≥ 70 % words Luna just said is her own echo → ignored.

Echo cancellation is on (it keeps Luna's voice out of the mic); noise
suppression and auto-gain are off: in testing they cut the start of
utterances ("Hey Luna" lost), and Whisper handles noise itself.

Measured (synthetic voices through a fake mic in headless Chrome): wake
phrase + question, follow-up without the wake word, spoken approval, and
"Luna, cancel" mid-task all worked end to end; chatter without the wake
phrase was ignored. A strongly accented test voice was misheard by both
`base.en` and `small.en` ("Approve" → "The Prius"); Luna then asks again
rather than guessing. If you're often misheard, try `LUNA_STT_MODEL=small.en`
(~2.5× slower).

`LUNA_STT_ENGINE=browser` switches back to Chrome/Edge recognition (no
wake word; WAKE becomes CONVO: listen again after each reply).

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
| `LUNA_STT_ENGINE` | `whisper` | `whisper` (local, any browser, wake word) or `browser` (Chrome/Edge) |
| `LUNA_STT_MODEL` | `base.en` | `tiny.en` (fastest), `base.en`, `small.en` (most accurate) |
| `LUNA_STT_MODELS_DIR` | `data/models/whisper` | Where Whisper models are kept |
| `LUNA_STT_THREADS` | `4` | CPU threads for Whisper |
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
| `hello` | `provider`, `model`, `providers: [{id, label, configured, default_model}]`, `can_switch`, `tools`, `helpers`, `budget`, `tts` (`"piper"` or `"browser"`), `stt` (`"whisper"` or `"browser"`), `memory` (long-term memory on) | on connect |
| `model` | `provider`, `model` | the model was switched (sent to every tab) |
| `models` | `provider`, `models`, `error`? | reply to `models` |
| `thread` | `id`, `history: [{role: "user"\|"luna", text}]` | on connect (always a new session, empty history) and after a session switch |
| `sessions` | `items: [{id, title, updated_at, turns}]` (most recent first) | reply to `sessions` and after `delete_session` |
| `state` | `value: "thinking"` | a run started |
| `token` | `text` | main agent reply text, streamed |
| `tool_call` | `id`, `name`, `args`, `depth`, `parent`? | any agent called a tool (`depth` 0 = main, 1 = helper) |
| `tool_result` | `id`, `name`, `preview` (≤ 240 chars), `depth`, `parent`? | a tool returned |
| `notice` | `text`, `depth`, `parent`? | middleware message, e.g. a limit was reached |
| `context` | `used`, `max` | approximate tokens in the thread history vs. the summarization point; sent right after `thread`, and just before each run's `done` / `pause` / `cancelled` / `error` |
| `pause` | `pauses: [...]` | the run stopped for you (see below); also sent on connect if a pause is still open |
| `done` | | the task finished |
| `cancelled` | `tools` (tool calls that were closed) | after `cancel` |
| `error` | `message` | the run failed or a message was invalid; the socket stays open |
| `memories` | `items: [{id, text, kind, pinned, created_at, updated_at}]`, `suggestions: [{id, action: "add"\|"update"\|"forget", target_id, target_text, text, kind, reason, thread_id, created_at}]` | reply to `memories` and to every memory / suggestion change |
| `memory_inbox` | `count` | pending suggestions; after `context` on sync, before each run's `context` + final event, and to every tab after a suggestion is accepted or declined (only when memory is on) |
| `memory_history` | `id`, `entries: [{action, before, after, source, at, undone}]` | reply to `memory_history`, newest first |
| `memory_error` | `message` | a memory request failed (unknown id, empty text, memory off). Unlike `error`, it doesn't end a run |

A pause is one of:

```json
{"id": "...", "kind": "question", "question": "Which folder?"}
{"id": "...", "kind": "approval", "actions": [{"name": "write_file", "args": {...}, "description": "...", "allowed": ["approve", "edit", "reject"]}]}
{"id": "...", "kind": "other", "text": "..."}
```

`parent` is present on helper events (`depth` ≥ 1): the `id` of the
`ask_*` call they run under, or `null` if unknown. The delegate tool puts
its call id in the helper run's metadata (`PARENT_CALL_METADATA` in
`agent/subagents/base.py`); `EventTranslator` reads it from the helper's
first streamed `messages` event and maps the helper's namespace to it, so
parallel helpers nest correctly.

Note: when an approval is resumed, the approval middleware re-sends the
same `tool_call` (same `id`). The browser updates the existing entry.

### HTTP

| Route | |
| --- | --- |
| `POST /api/stt` (body: 16 kHz mono 16-bit WAV, ≤ 30 s) | `{"text": "..."}` ("" if nothing was said). 400 bad audio, 403 foreign origin, 404 when STT is off |
| `POST /api/tts` `{"text": "..."}` | WAV (16-bit mono) of one sentence. 400 for empty/over 1000 chars, 403 foreign origin, 404 when TTS is off, 500 if synthesis fails |
| `GET /api/health` | `{status, provider, model}` |

### Browser → server

| type | fields | effect |
| --- | --- | --- |
| `message` | `text` | start a task (fresh task budget). Refused while a task runs or a pause is open. |
| `cancel` | | stop the running task, or abandon the open pause; every unanswered tool call gets the result "Cancelled by the user." so the thread stays valid. Shell commands are killed. |
| `resume` | `answers: {pause_id: reply}` | answer **every** open pause; same budget continues |
| `new_thread` | | switch to a new session (uuid); refused while a task runs |
| `thread` | `id` | resume a saved session: its history and any open pause are sent again |
| `sessions` | | list saved sessions (only ones where something was said) |
| `delete_session` | `id` | delete a session's checkpoints (long-term memory is untouched). Deleting the open one moves the tab to a new session (`thread` + `context` first). Refused while a task runs |
| `models` | `provider` | list that provider's models |
| `set_model` | `provider`, `model` (empty = provider default) | rebuild the agent with that model; `error` if e.g. the key is missing |
| `memories` | | list memories and pending suggestions |
| `memory_save` | `id`? (none = add), `text`, `kind` (`fact`, `preference`, `person`, `project`), `pinned` | add or change a memory |
| `memory_delete` / `memory_undo` / `memory_history` | `id` | soft-delete; revert the newest change (repeat to go further back); list changes |
| `suggestion_accept` | `id`, `text`? (your own wording) | apply a suggestion |
| `suggestion_reject` | `id` | decline; Luna can't suggest the same thing again |

Memory messages work while a task is running: they don't touch the run.

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
src/lib/intent.ts        wake phrase, voice commands, approvals, echo check (tested)
src/lib/vad.ts           utterance detection + 16 kHz WAV encoding (tested)
src/lib/voiceInput.ts    mic + AudioWorklet (public/mic-worklet.js) → utterances → /api/stt
src/lib/audio.ts         mic meter, shared `live` values the core reads, UI sounds
src/lib/theme.ts         phases → colors / energy, helper codenames
src/core/                the 3D core (React Three Fiber, shaders, bloom)
src/components/          HUD, captions, dock, command line, chat drawer, pause card,
                         boot, ModelSwitcher (provider/model popover),
                         MemoryPanel (long-term memory: inbox + saved)
```

Tests: `cd web && npm test` (vitest, pure modules) and `uv run pytest tests/test_web.py`.

## Limits / next steps

- The wake word works while the Luna page is open (a browser tab must
  hold the mic). An always-on background listener would be a desktop app
  or a small native service.
- Hands-free starts after the ENGAGE click: browsers only allow audio
  after a user gesture.
- The terminal CLI has no voice.
- Voice can't edit an action's arguments (use MODIFY, or deny with a
  reason, which lets Luna redo it your way).
- In a loud room the energy VAD records more; Whisper's own VAD turns
  noise into empty text, which is ignored, but it costs CPU.
