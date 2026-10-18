# Decisions

Architectural decisions for Luna, newest last. Each entry: what was decided,
why, and what it rules out. Details live in the linked spec.

---

## D1 — `create_agent` instead of a hand-built StateGraph (2026-10-06, spec1)
LangChain's `create_agent` gives the same LangGraph runtime with tools,
checkpointer and middleware built in. Less code to own.

## D2 — MCP servers are config, not code (2026-10-06, spec1)
`config/mcp_servers.json` lists servers; adding one never needs an agent
code change.

## D3 — Loop limits come from middleware, not `recursion_limit` (2026-10-18, spec2)
`ModelCallLimitMiddleware` / `ToolCallLimitMiddleware` stop a runaway ReAct
loop *cleanly* with a message. `recursion_limit` stays only as a wide
backstop (it raises an error instead of ending politely).

## D4 — A subagent is just a tool (2026-10-18, spec2)
No hard-coded router. Each subagent is wrapped as an `ask_<name>(task, context)`
tool, so the main model chooses "do it myself" vs "delegate" on every step
the same way it chooses any tool. Rules for *which* domains become
subagents are in spec2 §2 (noisy multi-step work, too many tools,
different setup/permissions, parallel work).

## D5 — One level of delegation only (2026-10-18, spec2)
Subagents may not call other subagents (enforced in `make_delegate_tool`).
Keeps cost predictable and traces readable.

## D6 — Shared task budget across all agents (2026-10-18, spec3)
Per-agent limits multiply (main 25 × several subagents). A `TaskBudget`
per user message, shared through a context variable, caps total model
calls (default 80). Resumes after a pause reuse the same budget.

## D7 — Task scratchpad lives in agent state, not messages (2026-10-18, spec3)
`todos` (TodoListMiddleware) and `notes` (ScratchpadMiddleware) are state
fields rendered into the system prompt on every call. Summarization only
rewrites messages, so the scratchpad survives it, and it is checkpointed so
it survives approval pauses. `notes` uses a merging reducer so parallel
`write_note` calls don't clobber each other. No `read_notes` tool: the
notes are always in the prompt already.

## D8 — Subagents inherit the main checkpointer (2026-10-18, spec3)
Supersedes spec2's `checkpointer=False`. A prototype showed that with
`False`, resuming after a human approved an action inside a subagent
*silently skipped the action*. With `None` (inherit) resumes work, and each
delegation still starts with an empty conversation because every tool call
gets its own checkpoint namespace (covered by tests).

## D9 — Human approval sits on the subagent that owns the risky tool (2026-10-18, spec3)
`HumanInTheLoopMiddleware(interrupt_on=...)` per subagent spec. The CLI
answers pauses (approve / edit / reject, or a typed answer for `ask_user`)
and resumes with `Command(resume={interrupt_id: answer})`, which also
handles several parallel pauses. Read-only tools never ask.

## D10 — Web search uses Tavily (2026-10-18, spec3)
Built for LLM agents (clean extracted content). The researcher subagent is
only registered when `LUNA_TAVILY_API_KEY` is set.

## D11 — Workspace sandbox for file tools; approval is the real guard for shell (2026-10-18, spec3)
File tools resolve every path (`..`, `~`, symlinks) and refuse anything
outside `LUNA_WORKSPACE_DIRS` (default `./workspace`, gitignored).
`run_command` only *starts* inside the workspace: a shell command can still
reach elsewhere, so the guard there is approval, which is always on unless
the user lists `run_command` in `LUNA_AUTO_APPROVE` (documented as not
recommended).

## D12 — MCP servers are routed by an `"agent"` tag (2026-10-18, spec3)
Untagged servers → main agent; `"agent": "assistant"` → creates the
assistant subagent; any other tag adds tools to the subagent of that name
(`"researcher"` → `ask_researcher`). Each group loads separately, so a
broken server only drops its own group. MCP tools whose names contain a
changing verb (send/create/update/delete/…, split on `_ - .` and camelCase)
need approval, on the main agent too.

## D13 — Default MCP config is empty (2026-10-18, spec3)
The demo server moved to `config/mcp_servers.example.json`. It printed a
large banner on every start and its tools are only for learning.

## D14 — Overlapping helpers must state their boundary (2026-10-18, spec3)
In a live run, "write code and run its test" most likely went to the files
helper (no `run_command`): it left behind wrapper scripts (`run.sh`,
`execute.py`, …) that were written but never executed. (Inferred from the
files; the run hit the OpenRouter free-tier limit before it could be traced.)
Fix: the files description and prompt say it cannot execute and point to
`ask_coder`; the coder says to use it whenever something must run. Rule
for future helpers: when two helpers can touch the same thing, each
description must say what it is *not* for.

## D15 — The web UI talks to the agent over one WebSocket (2026-10-18, spec4)
`luna-web` (Starlette + uvicorn) keeps one `Session` per socket that does
what the CLI's `run_turn` does, split across messages: `message` starts a
task, `resume` answers pauses with the same budget. Events stream as small
JSON dicts (`luna/web/events.py`), and pause answers are converted to the
CLI's exact formats, so the agent code is unchanged. Starlette rather than
FastAPI: one socket and two routes don't need request models, and it was
already installed through `mcp`. Rules out: a REST/SSE API (pauses need
two-way traffic), cancelling a run mid-tool (would leave an unanswered
tool call in the thread).

## D16 — Frontend is a Vite + React SPA, not Next.js (2026-10-18, spec4)
Everything the UI needs runs in the browser (WebGL, mic, speech APIs, a
WebSocket); Next.js's server rendering, routing and API routes would go
unused, and its server would be a second backend next to Python. Vite +
React has the same libraries (React Three Fiber, postprocessing, Motion),
builds to static files that `luna-web` serves itself, and proxies the
socket in dev. Lives in `web/`.

## D17 — Voice uses the browser's speech APIs for now (2026-10-18, spec4)
SpeechRecognition + speechSynthesis need no extra service or model, and
the UI is built so they can be swapped. Cost: voice input works in Chrome
and Edge only (audio goes to Google), and synthesized speech gives no
audio data, so the core's "speaking" waveform is synthesized from word
boundaries. A local STT/TTS endpoint is the planned replacement.

## D18 — The socket checks Origin; the server binds to localhost (2026-10-18, spec4)
The agent can write files and, after approval, run commands, and the
approval itself arrives over the same socket. Any web page could try to
open `ws://127.0.0.1:8765`, so only the server's own origin and
`LUNA_WEB_ALLOWED_ORIGINS` (default: the Vite dev server) are accepted.
Non-browser clients (no Origin header) are allowed: they already run on
this machine.

## D19 — Switching models rebuilds the agent around the same memory and tools (2026-10-18, spec4 §4a)
OpenRouter, Groq and Ollama all expose the OpenAI API, so one `ChatOpenAI`
covers them (`luna/agent/providers.py`, no new dependency). To switch at
runtime the web server re-runs the cheap part of `build_agent`
(`assemble_agent`) with a new model and keeps the checkpointer and MCP
connections. Chosen over swapping the model inside middleware, because the
model is also baked into every helper subagent and the summarizer; a
rebuild switches all of them at once. The choice is server-wide (one
agent per server) and not persisted: `LUNA_PROVIDER` sets the startup one.

## D20 — Luna speaks with Piper on the server so the core can follow the real audio (2026-10-18, spec4 §4b)
Partly supersedes D17 (output only; input is still the browser's). Browser
speechSynthesis exposes no audio, so the core could only guess. Piper was
chosen over Kokoro (more natural but ~330 MB and slow on CPU) and Edge TTS
(cloud, unofficial endpoint) because it is local, fast on CPU (~14×
real time), small (~60 MB voice) and has wheels for Windows, macOS and
Linux. Sentences are synthesized one by one and prefetched, so speech
starts after the first sentence instead of the whole reply. The browser
voice stays as the fallback (`LUNA_TTS_ENGINE=browser`, or Piper failing).
Band levels are normalized to their own recent peak instead of fixed
thresholds, which pinned at 1 when measured. Cost: `piper-tts` is GPL-3.0.

## D21 — Speech input is local Whisper; utterances are cut in the browser (2026-10-18, spec4 §4c)
Supersedes the input half of D17. faster-whisper (CTranslate2, int8) runs
on CPU on Windows, macOS and Linux, ~0.3 s per command with base.en, and
makes voice input private and browser-independent. The browser does voice
activity detection and sends one WAV per utterance (`POST /api/stt`)
instead of streaming audio over the socket: simpler, no server-side
streaming VAD state, and an HTTP request per utterance is cheap. Noise
that slips past the browser's energy VAD is removed by Whisper's Silero
VAD (it becomes empty text). The browser recognizer stays as a fallback
(`LUNA_STT_ENGINE=browser`).

## D22 — The wake word is a transcript check, not a keyword model (2026-10-18, spec4 §4c)
Pre-trained wake-word models (openWakeWord) don't have "Luna", and
training one is a project of its own. Since every utterance is already
transcribed locally, "Hey Luna" is detected in the text: the name must be
the first word(s), Whisper's misspellings ("Lunar", "Heilunar") count, and
the prompt "Hey Luna." makes it spell the name right (6/12 → 12/12 found,
0/8 false wakes in our test set). Cost: every utterance in the room is
transcribed (CPU), and the page must be open. Follow-up windows avoid
repeating the name in a conversation; anything echoing Luna's own recent
words is ignored so she can't wake herself.

## D23 — Tasks can be cancelled; cancel repairs the thread (2026-10-18, spec4 §4c)
Replaces "cancelling mid-tool is out" (D15). A session runs each task in
a background asyncio task. `cancel` cancels it, then gives every tool call
without a result the result "Cancelled by the user." (written as the
tools node), so the next model call sees a valid history; this also
clears an open approval, including one inside a helper. `run_command`
kills its process group when cancelled. Verified with a prototype before
building: the follow-up message runs normally in all three cases.

## D24 — Default MCP config wires every helper; to-dos are a local MCP server (2026-10-18, spec3 §6)
Supersedes D13. The default `config/mcp_servers.json` now loads the demo
server (main agent), the public LangChain docs server (researcher) and a
new local `servers/tasks_mcp_server.py` tagged `"assistant"`, so
`ask_assistant` exists out of the box. To-dos were chosen over Google
Calendar / Gmail because they need no account, OAuth client or network;
a Google server can be added later with the same tag. The tasks server
stores one JSON file (`data/tasks.json`, `LUNA_TASKS_PATH`), written via
temp-file-and-rename. Tool names (`add_task`, `set_task_done`,
`delete_task`) contain risky verbs on purpose, so changes ask for
approval like every other assistant action; `list_tasks` doesn't.
Cost: the demo banner prints on start again, and the docs server needs
network (it fails alone and only drops the researcher's extra tools).

## D25 — Spend fewer API calls per message (2026-10-18, spec2 §3a)
Luna runs mostly on free LLM tiers, where every model call counts against
a small request limit, and the old defaults let one message use up to 80
calls. Defaults are now: main agent 10 model / 20 tool calls, task budget
30, helpers 5–10 steps, and one retry per failed request instead of the
client's two (a retry after a 429 is another request against the same
limit). Summarization now keeps a token amount (4000, at most half of the
12k trigger) instead of 20 messages: with long tool results the 20 kept
messages alone could pass the trigger, and then every model call paid for
a second, summarizing call. The prompts also ask for economy (answer
directly, batch independent tool calls in one step, one complete helper
call, stop searching when the answer is good enough). Chosen over caching
answers or a cheaper "router" model call, which add moving parts and, for
the router, a call of their own. Cost: hard tasks hit a limit sooner;
raise `LUNA_MAX_MODEL_CALLS` / `LUNA_TASK_BUDGET` for them.

## D26 — The system prompt is built from persona settings; replies are short and spoken (2026-10-18, spec4 §4d)
Luna is voice-first, but replies read like web pages: the researcher
returned up to 300 words with URLs and the main agent recited them. The
main agent's prompt is now assembled by `agent/persona.py` from small
settings (`LUNA_RESPONSE_STYLE` concise/detailed, `LUNA_USER_TITLE`
default "Sir", name, location, units, timezone) plus an optional
free-form `config/persona.md` (git-ignored, appended last). Settings
cover what every user changes and stay validated; the file covers
everything else without new code. Only the main agent gets the persona:
helpers return facts, and one place phrases the reply. The researcher
now returns ≤ 60 words of facts with ≤ 2 URLs and searches with 3 results
plus Tavily's own short answer (`include_answer`), which usually settles
a factual question in one call. Chosen over post-processing replies
(trimming, stripping markdown), which can't make a long answer short
without another model call. Cost: the persona adds ~250 tokens to every
main-agent call; in concise mode the user has to ask for detail.

## D27 — Helper steps are linked to their `ask_*` call through run metadata (2026-10-18, spec4 §4e)
NEURAL ACTIVITY nests each helper's steps under the delegation that
started them, so every helper event needs its parent call id. LangGraph
gives a helper run its own namespace (`tools:<task id>`), which says
nothing about the tool call. The delegate tool now takes an injected
`ToolRuntime` (optional, so direct calls in tests still work) and runs the
helper with `metadata={"luna_parent_call": <call id>}`; that metadata shows
up on the helper's streamed `messages` events, which always come before its
first update, so `EventTranslator` maps namespace → parent and adds
`parent` to helper `tool_call` / `tool_result` / `notice` events. Verified
with two parallel helpers on fake models. Chosen over guessing by order
(wrong for parallel helpers) and over a `custom` stream mode (changes the
CLI's event handling too). The browser falls back to "newest running
delegation" when `parent` is missing.

## D28 — Context meter measures thread history against the summarization point; Esc stops a running task (2026-10-18, spec4 §4e)
The CONTEXT row shows `count_tokens_approximately(thread messages)` over
`summary_trigger_tokens` — the same counter and limit SummarizationMiddleware
uses, so 100 % means "older messages get summarized now", which is the
real ceiling of a Luna thread (model context windows are far larger and
differ per provider). 128K is shown when summarizing is off. It's sent on
sync and just before each run's final event (not per token: one
`aget_state` per run is cheap, per step is not needed). It excludes the
system prompt and tool schemas. For STOP, Esc already meant HUSH and every
free letter was a guess, so Esc now cancels when a task is running
(`busy`) and hushes otherwise. Open approvals/questions are not "running":
Esc there still only hushes, so it can't silently abandon an approval
(the STOP button and "Luna, cancel" still can).

## D29 — Long-term memory: the agent only suggests, the user writes; keyword search, no embeddings (2026-10-18, spec5)
Facts about the user now outlive threads in `data/luna_longterm.sqlite`
(`agent/longterm.py`), a separate file from the checkpoints. To keep a model
from spoiling it, the agent has **no write path** to `memories`: `remember`,
`suggest_update` and `suggest_forget` only queue rows in `suggestions`. The
user accepts (optionally rewording), or declines, in the web Memory panel or
with `/memory`. Guards run in code before a suggestion is queued: ≤ 300
chars, no secret-looking text, no duplicates of memories, pending or
declined suggestions, ≤ 3 per message (counted on the `TaskBudget`). Every
user change writes a before/after row to `memory_history`, and deletes are
soft, so any change can be undone step by step. Sync is explicit: memories
reach the main agent through `LongTermMemoryMiddleware` (pinned + top-5
FTS5 matches for the latest user message, ≤ 1500 chars, read fresh every
model call, so panel edits apply immediately). Thread content is promoted
only when the agent suggests it. There is no extract-on-summarize pass,
which would cost an extra model call. FTS5 over embeddings: zero API calls,
no model download, enough for a few hundred memories; paraphrases are
covered by pinning and `recall`. The store uses plain `sqlite3` behind a
lock (queries are sub-millisecond, and sync tools run in worker threads)
rather than aiosqlite. Ruled out: direct agent writes with approval pauses
(interrupts every turn), auto-add with ownership rules (the agent could
still fill memory with noise), and helpers reading memory (the main agent
passes facts, as with the persona, D26). Memory socket messages use
`memory_error` instead of `error`, because `error` ends a run in the browser.

## D30 — Every start is a new session; old sessions are resumed on purpose (2026-10-18, spec4 §4f)
The CLI and every web socket used to open `LUNA_DEFAULT_THREAD_ID`
("default"), so every reload or restart landed in one ever-growing
thread. Now each CLI start and each tab or reload gets a new uuid thread,
and the setting is removed. Sessions are listed from the checkpoints
themselves (`agent/sessions.py`): the newest main-graph checkpoint per
thread gives `updated_at`, and its messages give the title (first user
message) and turn count. No sessions table means nothing can drift out of
sync with the real history. Empty threads have no checkpoint, so opening
and closing Luna leaves no clutter. Resume:
- CLI: `luna --resume [n|id]`, `/resume`
- web: the transcript's SESSION list

Delete uses the checkpointer's `adelete_thread` (long-term memory is
separate, D29). A pause left in an old session is answered when it is
resumed: the CLI asks right away, and the web sends the pause on switch.
Ruled out:
- user-chosen titles: they need storage beside the checkpoints; can be added later
- "reopen the last session on reload": that was the behaviour the user wanted gone

Cost: listing reads every checkpoint, which is fine for a personal
assistant's few hundred threads.

