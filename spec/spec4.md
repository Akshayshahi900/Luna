# Spec 4 — Web UI: voice-first HUD

**Date:** 2026-10-18  
**Status:** Implemented (incl. §4a model switching, §4b voice-synced core, §4c full voice control).  
**Scope:** A browser interface for the existing agent. No agent behaviour changes.

Builds on [spec3](spec3.md) (pauses, task budget). Decisions: [`DECISIONS.md`](../DECISIONS.md) D15–D23.
How to run + protocol: [`docs/web-ui.md`](../docs/web-ui.md).

---

## 1. Goal

Luna will mostly be voice controlled, so the screen is a status display
first and a chat window second:

- a large animated core that shows what Luna is doing (listening,
  processing, speaking, waiting for approval, error, offline)
- spoken replies, started sentence by sentence while the reply streams
- captions with only the tail of the conversation
- the full transcript and a text box in a drawer
- approvals and questions answerable by voice or by clicking

## 2. Shape

```
Browser (web/, Vite + React)                     luna-web (src/luna/web/, Starlette)
┌─────────────────────────────────┐   /ws JSON   ┌──────────────────────────────┐
│ Listener (SpeechRecognition) ─┐ │ ───────────▶ │ Session per socket            │
│ text box / drawer ────────────┤ │  message /   │   thread_id, pending pauses,  │
│                               ▼ │  resume      │   TaskBudget                  │
│ App: route input → message,     │              │   run_task(on_event=…) ──┐   │
│      pause answer, or "stop"    │ ◀─────────── │ EventTranslator ◀────────┘   │
│ reducer(state)  Speaker (TTS)   │  token, tool │ describe_pause / build_answer │
│ Core (R3F) ← live audio levels  │  pause, done │                               │
└─────────────────────────────────┘              │ GET / → web/dist (built page) │
                                                 └──────────────────────────────┘
```

The server is the CLI's `run_turn` split across messages: a `message`
starts a task with a new `TaskBudget`; each `resume` continues it with the
same budget, until `done`. Pause answers are converted to the exact
formats the CLI produces, so the agent can't tell the two apart.

## 3. Server rules

- One `Session` per socket; it starts a **new** session (uuid thread) every
  time, so a reload or a new tab is a fresh conversation (§4f).
- On a session switch, the server sends recent history (≤ 40 messages with
  text) and any pause still open in the checkpoint. A pause left behind by
  a reload is therefore not lost: resume that session to answer it.
- A `message` while a pause is open is refused: running new input would
  leave the paused tool call without a result.
- `resume` must answer every open pause; invalid replies (wrong decision
  type, edit without args, count mismatch) return `error` and keep the pause.
- Events are queued and sent by one sender task, so order is preserved
  even though `on_event` is synchronous.
- Errors in a run are sent as `error`; the socket stays open.
- Origin check: browsers may connect only from the server's own origin or
  `LUNA_WEB_ALLOWED_ORIGINS`. Default bind is `127.0.0.1`.

## 4. Browser rules

- **Phase** (drives every color): boot → offline (no socket) → waiting
  (pause open) → listening → speaking → thinking (busy) → error (4 s) → idle.
- **Voice in**: Space / button toggles listening. Final transcript goes to
  the open pause if any (approval: parsed yes/no; unclear → Luna asks
  again), otherwise it becomes a message. "stop"/"quiet" only silences.
  Listening interrupts speech (barge-in).
- **Voice out**: tokens go through `SentenceChunker` (never splits inside a
  code fence); each sentence is cleaned of markdown and spoken. Text before
  a tool call is spoken right away. Pauses are announced.
- **Conversation mode**: after a spoken reply finishes (and after a pause
  prompt when the user had been speaking), listening restarts.
- **Visuals**: the core reads colors/energy/audio from module-level objects
  updated every frame, so animation never re-renders React. Mic loudness
  comes from an `AnalyserNode`; speech synthesis gives no audio, so its
  level is synthesized from word-boundary events.
- Preferences (voice on, conversation mode) are kept in `localStorage`.

## 4a. Model switching (added 2026-10-18)

- Providers live in `luna/agent/providers.py`: OpenRouter, Groq and Ollama,
  all through `ChatOpenAI` with a different base URL / key / model.
  `LUNA_PROVIDER` picks the startup one (CLI and web).
- `build_agent` is split: it makes the model, checkpointer and MCP groups,
  then calls `assemble_agent(settings, model, checkpointer, mcp_groups)`,
  which is cheap and pure wiring.
- `luna-web` keeps those parts in an `AgentHost`. `set_model` calls
  `assemble_agent` again with the new model and swaps `host.agent`; every
  session reads `host.agent` per run, so the next message uses it. Runs in
  progress finish on the old agent. All tabs get a `model` event.
- Same graph shape + same checkpointer ⇒ threads and even an open pause
  carry over to the new model.
- UI: a popover (M key / UPLINK / LINK) with a 3-way provider toggle and a
  model field with suggestions from the provider's `/models`.

## 4b. Voice-synced core (added 2026-10-18)

- `luna/voice/tts.py`: `PiperTTS` downloads its voice once, loads lazily,
  synthesizes WAV per sentence in a worker thread (one at a time: espeak
  inside Piper isn't thread-safe). Warmed up in the background at start.
- `POST /api/tts` (origin-checked, ≤ 1000 chars). `hello.tts` tells the
  browser which mode to use.
- Browser `Speaker` ("audio" mode): queue of sentences; each fetch starts
  when queued (prefetch), playback strictly in order through an
  `AnalyserNode`. `stop()` bumps a generation counter so late fetches are
  dropped. Three failures in a row → browser voice.
- `VoiceAnalyser` (also used for the mic): RMS loudness on a soft curve,
  64 log-spaced bins 80 Hz–7 kHz, three bands each normalized to their own
  decaying peak, onset detector (fast/slow envelopes + re-arm hysteresis).
- Core mapping: see docs/web-ui.md "Voice and the core".
- Tuning came from measuring Piper output (RMS median 0.12, p90 0.28) and
  replaying the analyser pipeline offline at 60 fps: loudness spans
  0.06–0.77 across a sentence, ~3.4 onsets/s, and the bands move
  independently (fixed thresholds had pinned them at 1).

## 4c. Full voice control: local STT, wake word, voice commands, cancel (added 2026-10-18)

- **STT**: `luna/voice/stt.py` `WhisperSTT` (faster-whisper, int8, CPU,
  greedy decoding, Silero VAD filter, prompt "Hey Luna."). `POST /api/stt`
  takes one 16 kHz WAV utterance (≤ 30 s). Benchmarked on an i5-12450H:
  base.en ≈ 4.5× real time (~0.3 s per command), small.en ≈ 2.3×.
- **Utterances** are cut in the browser (`vad.ts`: energy VAD, adaptive
  floor, 60 ms start, 800 ms end, 500 ms pre-roll, 15 s cap) from
  AudioWorklet frames (`voiceInput.ts`, `public/mic-worklet.js`).
- **Wake word = transcript check**, no extra model: the name must open the
  utterance; Whisper's misspellings are accepted. Prompting made the
  difference: wake phrases found 6/12 → 11/12 (base.en) and 12/12 with the
  start-anchored fuzzy match, 0/8 false wakes on near-misses.
- **When speech counts** (browser): push-to-talk utterance; wake-prefixed;
  inside the follow-up window (8 s after a reply / 10 s after "Hey Luna");
  never un-prefixed while Luna speaks; never if it echoes her recent words.
- **Voice commands** (`intent.ts`): hush, cancel, switch provider, new
  thread, transcript, sleep — whole-utterance matches only. Spoken
  denials keep their reason.
- **Cancel**: runs are background tasks per session; `cancel` cancels the
  task, then `cancel_cleanup` writes "Cancelled by the user." results for
  every unanswered tool call (as the tools node), which also clears any
  approval pause — including one inside a helper. `run_command` kills its
  process group on cancellation. While a run is in progress, `message`,
  `resume` and thread switches are refused.
- Mic constraints: echo cancellation on, noise suppression + auto gain off
  (they cut utterance onsets in testing).
- **Verified end to end** in headless Chrome with a fake mic fed by a
  synthetic voice: ignored chatter, "Hey Luna, what is six times seven?",
  follow-up "Save it." without the wake word, spoken "Approve." (file
  written), "Luna, cancel" mid-tool (tool cancelled), "switch to Groq",
  "start a new conversation".

## 4d. Spoken persona: short replies, "Sir", user profile (added 2026-10-18)

Luna's replies are mostly heard, not read, and web results made them long
and noisy. The main agent's system prompt is now built by
`luna/agent/persona.py` `build_system_prompt(settings)` (DECISIONS D26):

- `LUNA_SYSTEM_PROMPT` (role) + style + address + profile + persona file.
- **Style** `LUNA_RESPONSE_STYLE`: `concise` (default; one or two spoken
  sentences, answer first, no lists/markdown/URLs unless asked, detail only
  on request) or `detailed`.
- **Address** `LUNA_USER_TITLE` (default `Sir`, once per reply); empty →
  by `LUNA_USER_NAME` now and then, or not at all.
- **Profile**: `LUNA_USER_NAME`, `LUNA_USER_LOCATION` (default place for
  weather/local questions), `LUNA_UNITS` (`metric`/`imperial`),
  `LUNA_TIMEZONE` (passed to `get_current_time`). The agent hands place and
  units on to helpers in the delegate call.
- **Persona file** `LUNA_PERSONA_PATH` (default `config/persona.md`,
  git-ignored; template `config/persona.example.md`): free-form extra
  instructions appended last. Missing file = nothing added.
- **Researcher** returns facts only (≤ 60 words, ≤ 2 URLs; 300 words only
  when a report is asked for). Tavily search: 3 results, `include_answer`
  ("basic"), output capped at 4000 chars.
- Only the main agent gets the persona; helpers return facts and the main
  agent phrases the reply. Applies to the CLI too.
- Example: "what's the weather?" with `LUNA_USER_LOCATION=Agra, India` →
  "It's 33 degrees, Sir, with a 30 percent chance of rain."
- Tests: `tests/test_persona.py`.

## 4e. HUD polish: captions, active agent, STOP, context meter (added 2026-10-18)

Visual style unchanged; the transcript drawer and approval card are untouched.

- **Captions** (`Captions.tsx`, `.captions`): width is limited to the gap
  between the side panels (`--cap-side` = panel offset + width + gutter,
  per breakpoint) and long words wrap. With the transcript open, the user
  and Luna lines are hidden; live speech and notices move left of the drawer
  (hidden on ≤ 900 px).
- **Contrast**: the YOU line and the shortcut hint use `--text` at
  ~74 % / ~58 % with a dark shadow — readable, still dimmer than Luna's line.
- **Truncated text**: `Clip` (Hud.tsx) on MODEL and activity lines: full
  text in the tooltip, click / Enter toggles expanded.
- **Active agent**: the running agent's row glows and shows WORKING.
- **Nesting**: helper events carry `parent` (DECISIONS D27);
  `nestActivity()` (state.ts) groups them under their DEPLOY entry,
  children oldest first, at most 5 shown (+N EARLIER).
- **STOP**: the dock's red button (was ABORT) and **Esc while a task
  runs** send `cancel`; the run's asyncio task is cancelled, which stops
  helpers inside it. The reducer logs an INTERRUPTED entry. Esc with
  nothing running still hushes; with an approval open it does not cancel
  (D28). The hint reads ESC · STOP while busy.
- **Context meter**: `context` event `{used, max}` (server.py
  `Session._context`): approximate thread-history tokens over
  `summary_trigger_tokens` (128K when off). SUBSYSTEMS → CONTEXT bar,
  amber > 70 %, red > 90 %.
- Tests: `tests/test_web.py` (parent mapping incl. two parallel helpers,
  context before `done`, event order on connect/cancel),
  `web/src/lib/state.test.ts` (nesting, fallback parent, INTERRUPTED,
  context).

## 4f. Sessions: always new, resume on purpose (added 2026-10-18)

- CLI and web both start a new session every time. `LUNA_DEFAULT_THREAD_ID`
  is gone.
- `agent/sessions.py` builds the list from the checkpoints. There is no
  separate table that could disagree with them. Each session has:
  - id
  - title (first user message, ≤ 60 chars)
  - `updated_at` (newest main-graph checkpoint)
  - `turns`

  A thread with nothing said has no checkpoint, so it never shows up.
- CLI:
  - `luna --resume [n|id]` resumes; no value means the most recent.
  - `/sessions`, `/resume <n|id>`, `/delete <n|id>` (asks y/N), `/session`, `/new`.
  - Resuming prints the last 4 messages, then asks any pause the session
    was left at before taking new input.
- Web: socket `sessions` / `thread` / `delete_session`. The transcript
  header shows `SESSION · <title> ▾`, and its list resumes on click and
  deletes on a second click. Deleting the open session moves the tab to
  a new one.
- Tests:
  - `tests/test_memory.py`: list, titles, resolve, delete
  - `tests/test_cli.py`: commands, and a paused session resumed
  - `tests/test_web.py`: list, resume after reload, delete
  - `web/src/lib/state.test.ts` and `time.test.ts`
- Decision: D30.

## 4g. Drag-to-rotate, slowly spinning core (added 2026-10-18)

- The whole core (orb, rings, waveform, shockwaves, satellites) turns in
  3D when dragged. Colors, voice sync and effects are unchanged: rotation
  is applied to the `<Rig/>` group only.
- `web/src/core/orbit.ts` (pure, tested in `orbit.test.ts`): drag right =
  yaw right, drag down = top toward you; 0.008 rad/px; pitch clamped to
  ±80°; release speed is the smoothed recent motion and decays at 3.5/s.
- A constant yaw of 0.125 rad/s (one turn ≈ 50 s) runs whenever nobody is
  dragging; a flick coasts on top of it and fades into it. Yaw is kept
  within one turn. After 4 s idle only the pitch eases back to level.
- Pointer events go to the canvas element with pointer capture
  (`touch-action: none` for touch). The pointer tilt fades out while
  dragging so the two don't fight.

## 5. Verification

- `tests/test_web.py`: translator, pause description/answers, origin check,
  and the socket end to end with fake models (reply, question pause,
  approval reject, reconnect while paused (resume the old session), sessions, bad input, foreign origin,
  model switch seen by every tab, switch errors, model listing).
- `tests/test_web.py` also covers `/api/stt` (transcribe, bad audio,
  wrong rate/channels/length, foreign origin, off), cancel (running task
  + thread repaired, open approval, nothing running, a helper's approval)
  and refusing conflicting messages while busy; `tests/test_coder.py`
  checks a cancelled `run_command` is killed.
- `web/src/lib/vad.test.ts` and `intent.test.ts`: utterance detection,
  WAV encoding, wake phrase (incl. real Whisper misspellings), voice
  commands, approvals with reasons, echo check.
- `tests/test_web.py` also covers `/api/tts` (audio, bad input, foreign
  origin, engine off, engine failure) and TTS settings.
- `web/src/lib/analysis.test.ts`: band layout, loudness curve, AutoRange,
  onset detector (one onset per syllable, none on a held vowel).
- `tests/test_providers.py`: URLs/keys/models per provider, missing key,
  unknown provider, `/models` parsing.
- `web/src/lib/*.test.ts` (vitest): reducer, speech text helpers, voice intents.
- Manual: headless Chrome against a scripted fake agent: boot, idle,
  processing with a helper satellite, approval card, transcript drawer,
  390 px mobile layout.

## 6. Not in scope

A background (tab-less) wake word, voice in the CLI,
authentication for non-local use.
