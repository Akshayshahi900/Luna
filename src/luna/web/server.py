"""
luna-web — serve the browser UI and bridge it to the agent over a WebSocket.

BEGINNER MAP
------------
One browser tab = one WebSocket = one Session. A Session does what
cli/chat.py `run_turn` does, but split across messages because the answer
to a pause arrives later from the browser:

  browser → {"type": "message", "text": ...}   new task: fresh TaskBudget, run_task
  server  → token / tool_call / tool_result / notice ... (streamed, see events.py)
  server  → {"type": "pause", ...}  or  {"type": "done"}
  browser → {"type": "resume", "answers": {pause_id: reply}}   same budget, run_task again
  browser → {"type": "set_model", "provider": ..., "model": ...}  AgentHost rebuilds the agent

Sessions: every socket (a new tab, a reload) starts a NEW session (thread).
The browser lists saved ones with {"type": "sessions"}, resumes one with
{"type": "thread", "id"} and deletes one with {"type": "delete_session"}
(luna/agent/sessions.py).

All tabs share one AgentHost: switching the model switches it for everyone
(the memory and MCP connections are reused, so threads carry on).

Full protocol: docs/web-ui.md.

Voice: POST /api/tts {"text"} → WAV from Piper (luna/voice/tts.py), so the
browser can analyse the real audio and the core moves with Luna's voice.
POST /api/stt (16 kHz WAV of one utterance) → {"text"} from Whisper
(luna/voice/stt.py); the browser does voice activity detection and the
"Hey Luna" wake word.

Context meter: on every sync and at the end of every run (just before
done / pause / cancelled / error) the server sends
{"type": "context", "used", "max"}: the thread history's approximate token
count and the point where it gets summarized (summary_trigger_tokens).

Long-term memory (luna/agent/longterm.py): the Memory panel lists, edits
and undoes memories and answers Luna's suggestions with memory_* /
suggestion_* messages; the server answers with {"type": "memories", ...}
and tells every tab the inbox size ({"type": "memory_inbox", "count"}) on
sync, after each run and after every memory change.

A run happens in a background task, so the socket keeps listening: a
{"type": "cancel"} stops it, and cancel_cleanup() gives every unanswered
tool call a "Cancelled by the user." result so the thread stays valid.

SECURITY: the agent can write files and (after approval) run commands, and
any web page you visit could try to open ws://127.0.0.1:8765. So the socket
only accepts browsers whose Origin is this server itself or one listed in
LUNA_WEB_ALLOWED_ORIGINS, and the server listens on 127.0.0.1 by default.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Awaitable, Callable
from contextlib import asynccontextmanager
from typing import Any
from urllib.parse import urlsplit

from langchain_core.messages import ToolMessage
from langchain_core.messages.utils import count_tokens_approximately
from langgraph.types import Command, Interrupt
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import HTMLResponse, JSONResponse, Response
from starlette.routing import Mount, Route, WebSocketRoute
from starlette.staticfiles import StaticFiles
from starlette.websockets import WebSocket, WebSocketDisconnect

from luna.agent.budget import TaskBudget
from luna.agent.builder import assemble_agent, load_mcp_groups, recursion_limit
from luna.agent.longterm import LongTermStore, MemoryRefused, open_longterm_store
from luna.agent.memory import close_checkpointers, create_checkpointer
from luna.agent.providers import describe_providers, get_provider, list_models, make_model
from luna.agent.runner import run_task
from luna.agent.sessions import delete_session, list_sessions, new_session_id
from luna.cli.chat import agent_tool_names
from luna.config import Settings, get_settings
from luna.config.settings import PROJECT_ROOT
from luna.voice.stt import create_stt, wav_to_samples
from luna.voice.tts import MAX_TEXT_CHARS, create_tts
from luna.web.events import EventTranslator, build_answer, describe_pause

# `npm run build` in web/ writes the frontend here.
DIST_DIR = PROJECT_ROOT / "web" / "dist"
# How many past messages to send when a tab connects or switches thread.
HISTORY_LIMIT = 40
# Context meter ceiling when summarization is off (LUNA_SUMMARY_TRIGGER_TOKENS=0).
CONTEXT_FALLBACK_TOKENS = 128_000

_NO_BUILD_PAGE = """<!doctype html><meta charset="utf-8"><title>Luna</title>
<body style="background:#02060c;color:#7fe9ff;font-family:monospace;padding:3rem">
<h1>LUNA backend online</h1>
<p>The frontend isn't built yet. Either:</p>
<pre>cd web &amp;&amp; npm install &amp;&amp; npm run dev     # then open http://localhost:5173
cd web &amp;&amp; npm run build                     # then reload this page</pre>
</body>"""


def origin_allowed(origin: str | None, host: str | None, allowed: list[str]) -> bool:
    """May a WebSocket from ``origin`` talk to this server (reached as ``host``)?

    Browsers always send Origin on a WebSocket; a missing one means a
    non-browser client (a script on this machine), which is allowed.
    """
    if not origin:
        return True
    origin = origin.rstrip("/")
    if origin in allowed:
        return True
    return bool(host) and urlsplit(origin).netloc == host


# (provider, model) → a new agent built on the same memory and MCP tools.
Rebuild = Callable[[str, str], Awaitable[Any]]


class AgentHost:
    """The agent all sessions use, and how to swap its model."""

    def __init__(
        self, agent: Any, settings: Settings, provider: str, model: str, rebuild: Rebuild | None = None
    ) -> None:
        self.agent = agent
        self.settings = settings
        self.provider = provider
        self.model = model
        self._rebuild = rebuild
        self._lock = asyncio.Lock()
        # Voice engines for /api/tts and /api/stt (luna/voice/), or None.
        self.tts: Any = None
        self.stt: Any = None
        # Long-term memory shared by every tab (None = turned off).
        self.memory: LongTermStore | None = None
        # Every open tab's send function, told when the model changes.
        self.listeners: set[Callable[[dict], None]] = set()

    @property
    def can_switch(self) -> bool:
        return self._rebuild is not None

    def info(self) -> dict:
        return {"type": "model", "provider": self.provider, "model": self.model}

    async def switch(self, provider: str, model: str = "") -> None:
        """Rebuild the agent with another model. Runs already in progress
        finish on the old one; the next message uses the new one."""
        if self._rebuild is None:
            raise ValueError("Model switching isn't available on this server.")
        model = model.strip() or get_provider(provider).default_model(self.settings)
        async with self._lock:
            self.agent = await self._rebuild(provider, model)
            self.provider, self.model = provider, model
        for send in list(self.listeners):
            send(self.info())

    def broadcast_inbox(self) -> None:
        """Tell every tab how many memory suggestions are waiting."""
        if self.memory is None:
            return
        event = {"type": "memory_inbox", "count": self.memory.pending_count()}
        for send in list(self.listeners):
            send(event)


CANCELLED = "Cancelled by the user."


async def cancel_cleanup(agent: Any, config: dict[str, Any]) -> list[str]:
    """After a run was cancelled (or a pause abandoned), answer every tool
    call that has no result yet, so the next message can run normally.

    Without this the model would see a tool call with no result, which
    model APIs reject. Writing the results "as the tools node" also clears
    any approval pause that was waiting. Returns the tool names it closed.
    """
    if agent.checkpointer is None:
        return []
    state = await agent.aget_state(config)
    messages = state.values.get("messages", [])
    answered = {m.tool_call_id for m in messages if m.type == "tool"}
    last_ai = next((m for m in reversed(messages) if m.type == "ai"), None)
    missing = [c for c in (last_ai.tool_calls if last_ai else []) if c["id"] not in answered]
    if missing:
        await agent.aupdate_state(
            config,
            {"messages": [ToolMessage(content=CANCELLED, tool_call_id=c["id"], name=c["name"]) for c in missing]},
            as_node="tools",
        )
    return [c["name"] for c in missing]


MEMORY_MESSAGES = {
    "memory_save", "memory_delete", "memory_undo", "memory_history", "suggestion_accept", "suggestion_reject",
}


class Session:
    """One browser connection: its thread, pending pauses and task budget."""

    def __init__(self, host: AgentHost, settings: Settings, send: Callable[[dict], None]) -> None:
        self.host = host
        self.settings = settings
        self.send = send
        # Always a fresh session; old ones are resumed on request.
        self.thread_id = new_session_id()
        self.pending: dict[str, dict] = {}  # pause id → describe_pause() output
        self.budget: TaskBudget | None = None
        self._translate = EventTranslator()
        self.task: asyncio.Task | None = None  # the run in progress, if any

    @property
    def busy(self) -> bool:
        return self.task is not None and not self.task.done()

    def _start(self, payload: Any) -> None:
        self.task = asyncio.create_task(self._run(payload))

    @property
    def agent(self) -> Any:
        return self.host.agent

    @property
    def _config(self) -> dict[str, Any]:
        return {
            "configurable": {"thread_id": self.thread_id},
            "recursion_limit": recursion_limit(self.settings),
        }

    def _forward(self, namespace: tuple[str, ...], mode: str, payload: Any) -> None:
        for event in self._translate(namespace, mode, payload):
            self.send(event)

    def _set_pending(self, interrupts: list[Interrupt]) -> None:
        self.pending = {i.id: describe_pause(i) for i in interrupts}

    async def sync(self) -> None:
        """Send the thread id, its recent messages and any pause still waiting.

        A pause survives a page reload: it lives in the checkpoint, not here.
        """
        state = None
        if self.agent.checkpointer is not None:
            state = await self.agent.aget_state(self._config)
        messages = (state.values.get("messages", []) if state else [])
        history = [
            {"role": "user" if m.type == "human" else "luna", "text": m.text}
            for m in messages
            if m.type in {"human", "ai"} and m.text
        ][-HISTORY_LIMIT:]
        self.send({"type": "thread", "id": self.thread_id, "history": history})
        self.send(self._context(messages))
        self._send_inbox()
        self._set_pending(list(state.interrupts) if state else [])
        if self.pending:
            self.budget = TaskBudget(limit=self.settings.task_budget)
            self.send({"type": "pause", "pauses": list(self.pending.values())})

    def _context(self, messages: list[Any]) -> dict:
        """The context meter: thread history tokens vs. the summarization point.

        Counted the way SummarizationMiddleware counts by default, so the bar
        fills up to where older messages get summarized.
        """
        limit = self.settings.summary_trigger_tokens or CONTEXT_FALLBACK_TOKENS
        return {"type": "context", "used": count_tokens_approximately(messages), "max": limit}

    async def _send_sessions(self) -> None:
        items = await list_sessions(self.agent.checkpointer) if self.agent.checkpointer else []
        self.send({"type": "sessions", "items": items})  # most recent first

    def _send_inbox(self) -> None:
        if self.host.memory is not None:
            self.send({"type": "memory_inbox", "count": self.host.memory.pending_count()})

    def _memories(self) -> dict:
        store = self.host.memory
        return {"type": "memories", "items": store.list(), "suggestions": store.suggestions()}

    def _handle_memory(self, kind: str, msg: dict) -> None:
        """Memory panel requests. They don't touch the run, so they work while
        busy, and failures are memory_error (not error, which ends a run in the UI)."""
        store = self.host.memory
        if store is None:
            return self.send({"type": "memory_error", "message": "Long-term memory is off."})
        try:
            if kind == "memory_save":
                kind_ = str(msg.get("kind") or "fact")
                pinned = bool(msg.get("pinned", False))
                if msg.get("id") is None:
                    store.add(str(msg.get("text", "")), kind_, pinned)
                else:
                    store.edit(int(msg["id"]), text=str(msg.get("text", "")), kind=kind_, pinned=pinned)
            elif kind == "memory_delete":
                store.delete(int(msg.get("id")))
            elif kind == "memory_undo":
                store.undo(int(msg.get("id")))
            elif kind == "memory_history":
                memory_id = int(msg.get("id"))
                return self.send({"type": "memory_history", "id": memory_id, "entries": store.history(memory_id)})
            elif kind == "suggestion_accept":
                text = msg.get("text")
                store.accept(int(msg.get("id")), str(text) if text else None)
            elif kind == "suggestion_reject":
                store.reject(int(msg.get("id")))
        except (MemoryRefused, TypeError, ValueError) as exc:
            return self.send({"type": "memory_error", "message": str(exc) or "Bad memory request."})
        self.send(self._memories())
        if kind.startswith("suggestion_"):
            self.host.broadcast_inbox()

    async def _send_context(self, agent: Any, config: dict[str, Any]) -> None:
        if agent.checkpointer is None:
            return
        try:
            state = await agent.aget_state(config)
        except Exception:  # noqa: BLE001 — the meter is cosmetic; never fail a run over it
            return
        self.send(self._context(state.values.get("messages", [])))

    async def _run(self, payload: Any) -> None:
        self.send({"type": "state", "value": "thinking"})
        agent, config = self.agent, self._config  # fixed for this run, even if the model is switched
        try:
            interrupts = await run_task(agent, payload, config, budget=self.budget, on_event=self._forward)
        except asyncio.CancelledError:
            closed = await cancel_cleanup(agent, config)
            self.pending = {}
            self.budget = None
            await self._send_context(agent, config)
            self.send({"type": "cancelled", "tools": closed})
            return
        except Exception as exc:  # noqa: BLE001 — report to the browser, keep the socket open
            self.pending = {}
            self.budget = None
            await self._send_context(agent, config)
            self.send({"type": "error", "message": str(exc) or type(exc).__name__})
            return
        self._set_pending(interrupts)
        # Before the final event, so the browser has it when the run ends.
        self._send_inbox()
        await self._send_context(agent, config)
        if self.pending:
            self.send({"type": "pause", "pauses": list(self.pending.values())})
        else:
            self.budget = None
            self.send({"type": "done"})

    async def handle(self, msg: Any) -> None:
        """React to one message from the browser."""
        kind = msg.get("type") if isinstance(msg, dict) else None

        if kind == "message":
            text = str(msg.get("text", "")).strip()
            if not text:
                return self.send({"type": "error", "message": "Empty message."})
            if self.busy:
                return self.send({"type": "error", "message": "Still working on the last request."})
            if self.pending:
                # A new message now would leave the paused tool call unanswered.
                return self.send({"type": "error", "message": "Luna is waiting for your answer first."})
            self.budget = TaskBudget(limit=self.settings.task_budget)
            return self._start({"messages": [{"role": "user", "content": text}]})

        if kind == "cancel":
            if self.busy:
                self.task.cancel()  # _run cleans up and sends "cancelled"
                return
            if self.pending:
                # Abandon the open pause: its tool calls get "cancelled" results.
                closed = await cancel_cleanup(self.agent, self._config)
                self.pending = {}
                self.budget = None
                return self.send({"type": "cancelled", "tools": closed})
            return self.send({"type": "cancelled", "tools": []})

        if kind == "resume":
            replies = msg.get("answers")
            if self.busy or not self.pending:
                return self.send({"type": "error", "message": "Nothing is waiting for an answer."})
            if not isinstance(replies, dict) or set(replies) != set(self.pending):
                return self.send({"type": "error", "message": "Answer every pending pause."})
            try:
                answers = {pid: build_answer(self.pending[pid], r) for pid, r in replies.items()}
            except ValueError as exc:
                return self.send({"type": "error", "message": str(exc)})
            return self._start(Command(resume=answers))

        if kind in {"new_thread", "thread", "delete_session"} and self.busy:
            return self.send({"type": "error", "message": "Finish or cancel the current task first."})

        if kind == "new_thread":
            self.thread_id = new_session_id()
            return await self.sync()

        if kind == "delete_session":
            thread_id = str(msg.get("id", "")).strip()
            if not thread_id or self.agent.checkpointer is None:
                return self.send({"type": "error", "message": "Session id required."})
            await delete_session(self.agent.checkpointer, thread_id)
            if thread_id == self.thread_id:
                # Deleted the open one: carry on in a fresh session.
                self.thread_id = new_session_id()
                await self.sync()
            return await self._send_sessions()

        if kind == "thread":
            thread_id = str(msg.get("id", "")).strip()
            if not thread_id:
                return self.send({"type": "error", "message": "Thread id required."})
            self.thread_id = thread_id
            return await self.sync()

        if kind == "models":
            provider = str(msg.get("provider", ""))
            try:
                models = await list_models(self.settings, provider)
            except Exception as exc:  # noqa: BLE001 — offline, bad key, Ollama not running…
                return self.send({"type": "models", "provider": provider, "models": [], "error": str(exc)})
            return self.send({"type": "models", "provider": provider, "models": models})

        if kind == "set_model":
            try:
                await self.host.switch(str(msg.get("provider", "")), str(msg.get("model", "")))
            except Exception as exc:  # noqa: BLE001 — e.g. missing API key
                return self.send({"type": "error", "message": str(exc)})
            return

        if kind == "memories":
            if self.host.memory is None:
                return self.send({"type": "memory_error", "message": "Long-term memory is off."})
            return self.send(self._memories())

        if kind in MEMORY_MESSAGES:
            return self._handle_memory(kind, msg)

        if kind == "sessions":
            return await self._send_sessions()

        self.send({"type": "error", "message": f"Unknown message type: {kind!r}"})


def _hello(host: AgentHost, settings: Settings) -> dict:
    tools = agent_tool_names(host.agent)
    return {
        "type": "hello",
        "provider": host.provider,
        "model": host.model,
        "providers": describe_providers(settings),
        "can_switch": host.can_switch,
        "tools": tools,
        "helpers": [t.removeprefix("ask_") for t in tools if t.startswith("ask_") and t != "ask_user"],
        "budget": settings.task_budget,
        # "piper": fetch audio from /api/tts; "browser": use speechSynthesis
        "tts": "piper" if host.tts is not None else "browser",
        # "whisper": send utterances to /api/stt (enables the wake word);
        # "browser": Chrome/Edge speech recognition
        "stt": "whisper" if host.stt is not None else "browser",
        # Long-term memory panel available
        "memory": host.memory is not None,
    }


async def luna_socket(ws: WebSocket) -> None:
    host: AgentHost = ws.app.state.host
    settings: Settings = ws.app.state.settings
    if not origin_allowed(ws.headers.get("origin"), ws.headers.get("host"), settings.web_allowed_origins):
        await ws.close(code=1008)  # policy violation
        return
    await ws.accept()

    # run_task's on_event is a plain function, so events go through a queue
    # and one sender task keeps them in order.
    outbox: asyncio.Queue[dict] = asyncio.Queue()

    async def pump() -> None:
        while True:
            await ws.send_json(await outbox.get())

    sender = asyncio.create_task(pump())
    session = Session(host, settings, outbox.put_nowait)
    session.send(_hello(host, settings))
    host.listeners.add(session.send)
    try:
        await session.sync()
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                session.send({"type": "error", "message": "Messages must be JSON."})
                continue
            await session.handle(msg)
    except WebSocketDisconnect:
        pass
    finally:
        host.listeners.discard(session.send)
        sender.cancel()


async def health(request: Request) -> JSONResponse:
    host: AgentHost = request.app.state.host
    return JSONResponse({"status": "ok", "provider": host.provider, "model": host.model})


async def tts(request: Request) -> Response:
    """Speak one sentence: {"text": "..."} → audio/wav."""
    settings: Settings = request.app.state.settings
    if not origin_allowed(request.headers.get("origin"), request.headers.get("host"), settings.web_allowed_origins):
        return JSONResponse({"error": "origin not allowed"}, status_code=403)
    engine = request.app.state.host.tts
    if engine is None:
        return JSONResponse({"error": "server speech is off (LUNA_TTS_ENGINE=browser)"}, status_code=404)
    try:
        body = await request.json()
        text = str(body.get("text", "")).strip() if isinstance(body, dict) else ""
    except ValueError:
        text = ""
    if not text or len(text) > MAX_TEXT_CHARS:
        return JSONResponse({"error": f"text must be 1-{MAX_TEXT_CHARS} characters"}, status_code=400)
    try:
        audio = await engine.asynthesize(text)
    except Exception as exc:  # noqa: BLE001 — the browser falls back to its own voice
        return JSONResponse({"error": str(exc)}, status_code=500)
    return Response(audio, media_type="audio/wav", headers={"Cache-Control": "no-store"})


async def stt(request: Request) -> Response:
    """Transcribe one utterance: 16 kHz mono WAV body → {"text": "..."}."""
    settings: Settings = request.app.state.settings
    if not origin_allowed(request.headers.get("origin"), request.headers.get("host"), settings.web_allowed_origins):
        return JSONResponse({"error": "origin not allowed"}, status_code=403)
    engine = request.app.state.host.stt
    if engine is None:
        return JSONResponse({"error": "server speech recognition is off (LUNA_STT_ENGINE=browser)"}, status_code=404)
    body = await request.body()
    try:
        samples = wav_to_samples(body)
    except ValueError as exc:
        return JSONResponse({"error": str(exc)}, status_code=400)
    try:
        text = await engine.atranscribe(samples)
    except Exception as exc:  # noqa: BLE001
        return JSONResponse({"error": str(exc)}, status_code=500)
    return JSONResponse({"text": text})


async def no_build(request: Request) -> HTMLResponse:
    return HTMLResponse(_NO_BUILD_PAGE)


async def _build_host(settings: Settings) -> AgentHost:
    """build_agent, but keeping the parts so the model can be swapped later."""
    model = make_model(settings)  # fails fast if the startup provider has no key
    checkpointer = await create_checkpointer(backend=settings.memory_backend, path=settings.checkpoint_path)
    mcp_groups = await load_mcp_groups(settings)
    memory = open_longterm_store(settings)

    async def rebuild(provider: str, model_name: str) -> Any:
        new_model = make_model(settings, provider, model_name)
        return (await assemble_agent(settings, new_model, checkpointer, mcp_groups, memory))[0]

    agent, _ = await assemble_agent(settings, model, checkpointer, mcp_groups, memory)
    default = get_provider(settings.provider).default_model(settings)
    host = AgentHost(agent, settings, settings.provider, default, rebuild)
    host.memory = memory
    return host


def create_app(
    agent: Any = None,
    settings: Settings | None = None,
    rebuild: Rebuild | None = None,
    tts_engine: Any = None,
    stt_engine: Any = None,
    memory_store: LongTermStore | None = None,
) -> Starlette:
    """Build the web app. Pass ``agent`` (and optionally ``rebuild`` /
    ``tts_engine`` / ``stt_engine`` / ``memory_store``) to skip building the
    real ones (tests do)."""
    settings = settings or get_settings()

    @asynccontextmanager
    async def lifespan(app: Starlette):
        app.state.settings = settings
        if agent is not None:
            default = get_provider(settings.provider).default_model(settings)
            host = AgentHost(agent, settings, settings.provider, default, rebuild)
            host.tts, host.stt = tts_engine, stt_engine
            host.memory = memory_store
        else:
            host = await _build_host(settings)
            host.tts, host.stt = create_tts(settings), create_stt(settings)
        app.state.host = host
        # Load the voice models in the background so startup stays fast.
        warm = [asyncio.create_task(e.warm_up()) for e in (host.tts, host.stt) if e is not None]
        try:
            yield
        finally:
            for task in warm:
                task.cancel()
            if agent is None:
                await close_checkpointers()
                if host.memory is not None:
                    host.memory.close()

    routes: list[Any] = [
        WebSocketRoute("/ws", luna_socket),
        Route("/api/health", health),
        Route("/api/tts", tts, methods=["POST"]),
        Route("/api/stt", stt, methods=["POST"]),
    ]
    if (DIST_DIR / "index.html").exists():
        routes.append(Mount("/", StaticFiles(directory=DIST_DIR, html=True)))
    else:
        routes.append(Route("/", no_build))
    return Starlette(routes=routes, lifespan=lifespan)


def main() -> None:
    import uvicorn

    settings = get_settings()
    print(f"LUNA web UI → http://{settings.web_host}:{settings.web_port}")
    uvicorn.run(create_app(settings=settings), host=settings.web_host, port=settings.web_port)


__all__ = ["AgentHost", "Session", "create_app", "main", "origin_allowed"]
