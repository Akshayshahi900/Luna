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
