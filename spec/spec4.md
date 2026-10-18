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

- One `Session` per socket; it starts on `LUNA_DEFAULT_THREAD_ID`.
- On connect and on thread switch, the session sends recent history (≤ 40
  messages with text) and any pause still open in the checkpoint. A page
  reload therefore doesn't lose an approval.
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

## 5. Verification

- `tests/test_web.py`: translator, pause description/answers, origin check,
  and the socket end to end with fake models (reply, question pause,
  approval reject, reconnect while paused, threads, bad input, foreign origin,
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
