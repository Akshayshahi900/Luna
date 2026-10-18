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

All tabs share one AgentHost: switching the model switches it for everyone
(the memory and MCP connections are reused, so threads carry on).

Full protocol: docs/web-ui.md.

Voice: POST /api/tts {"text"} → WAV from Piper (luna/voice/tts.py), so the
browser can analyse the real audio and the core moves with Luna's voice.

SECURITY: the agent can write files and (after approval) run commands, and
any web page you visit could try to open ws://127.0.0.1:8765. So the socket
only accepts browsers whose Origin is this server itself or one listed in
LUNA_WEB_ALLOWED_ORIGINS, and the server listens on 127.0.0.1 by default.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from collections.abc import Awaitable, Callable
from contextlib import asynccontextmanager
from typing import Any
from urllib.parse import urlsplit

from langgraph.types import Command, Interrupt
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import HTMLResponse, JSONResponse, Response
from starlette.routing import Mount, Route, WebSocketRoute
from starlette.staticfiles import StaticFiles
from starlette.websockets import WebSocket, WebSocketDisconnect

from luna.agent.budget import TaskBudget
from luna.agent.builder import assemble_agent, load_mcp_groups, recursion_limit
from luna.agent.memory import close_checkpointers, create_checkpointer
from luna.agent.providers import describe_providers, get_provider, list_models, make_model
from luna.agent.runner import run_task
from luna.cli.chat import agent_tool_names, list_threads
from luna.config import Settings, get_settings
from luna.config.settings import PROJECT_ROOT
from luna.voice.tts import MAX_TEXT_CHARS, create_tts
from luna.web.events import EventTranslator, build_answer, describe_pause

# `npm run build` in web/ writes the frontend here.
DIST_DIR = PROJECT_ROOT / "web" / "dist"
# How many past messages to send when a tab connects or switches thread.
HISTORY_LIMIT = 40

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
        # Text-to-speech engine for /api/tts (luna/voice/tts.py), or None.
        self.tts: Any = None
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


class Session:
    """One browser connection: its thread, pending pauses and task budget."""

    def __init__(self, host: AgentHost, settings: Settings, send: Callable[[dict], None]) -> None:
        self.host = host
        self.settings = settings
        self.send = send
        self.thread_id = settings.default_thread_id
        self.pending: dict[str, dict] = {}  # pause id → describe_pause() output
        self.budget: TaskBudget | None = None
        self._translate = EventTranslator()

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
        self._set_pending(list(state.interrupts) if state else [])
        if self.pending:
            self.budget = TaskBudget(limit=self.settings.task_budget)
            self.send({"type": "pause", "pauses": list(self.pending.values())})

    async def _run(self, payload: Any) -> None:
        self.send({"type": "state", "value": "thinking"})
        try:
            interrupts = await run_task(
                self.agent, payload, self._config, budget=self.budget, on_event=self._forward
            )
        except Exception as exc:  # noqa: BLE001 — report to the browser, keep the socket open
            self.pending = {}
            self.budget = None
            self.send({"type": "error", "message": str(exc) or type(exc).__name__})
            return
        self._set_pending(interrupts)
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
            if self.pending:
                # A new message now would leave the paused tool call unanswered.
                return self.send({"type": "error", "message": "Luna is waiting for your answer first."})
            self.budget = TaskBudget(limit=self.settings.task_budget)
            return await self._run({"messages": [{"role": "user", "content": text}]})

        if kind == "resume":
            replies = msg.get("answers")
            if not self.pending:
                return self.send({"type": "error", "message": "Nothing is waiting for an answer."})
            if not isinstance(replies, dict) or set(replies) != set(self.pending):
                return self.send({"type": "error", "message": "Answer every pending pause."})
            try:
                answers = {pid: build_answer(self.pending[pid], r) for pid, r in replies.items()}
            except ValueError as exc:
                return self.send({"type": "error", "message": str(exc)})
            return await self._run(Command(resume=answers))

        if kind == "new_thread":
            self.thread_id = str(uuid.uuid4())
            return await self.sync()

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

        if kind == "threads":
            threads = await list_threads(self.agent.checkpointer) if self.agent.checkpointer else []
            return self.send({"type": "threads", "ids": threads[::-1]})  # newest first

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


async def no_build(request: Request) -> HTMLResponse:
    return HTMLResponse(_NO_BUILD_PAGE)


async def _build_host(settings: Settings) -> AgentHost:
    """build_agent, but keeping the parts so the model can be swapped later."""
    model = make_model(settings)  # fails fast if the startup provider has no key
    checkpointer = await create_checkpointer(backend=settings.memory_backend, path=settings.checkpoint_path)
    mcp_groups = await load_mcp_groups(settings)

    async def rebuild(provider: str, model_name: str) -> Any:
        new_model = make_model(settings, provider, model_name)
        return (await assemble_agent(settings, new_model, checkpointer, mcp_groups))[0]

    agent, _ = await assemble_agent(settings, model, checkpointer, mcp_groups)
    default = get_provider(settings.provider).default_model(settings)
    return AgentHost(agent, settings, settings.provider, default, rebuild)


def create_app(
    agent: Any = None,
    settings: Settings | None = None,
    rebuild: Rebuild | None = None,
    tts_engine: Any = None,
) -> Starlette:
    """Build the web app. Pass ``agent`` (and optionally ``rebuild`` /
    ``tts_engine``) to skip building the real ones (tests do)."""
    settings = settings or get_settings()

    @asynccontextmanager
    async def lifespan(app: Starlette):
        app.state.settings = settings
        if agent is not None:
            default = get_provider(settings.provider).default_model(settings)
            host = AgentHost(agent, settings, settings.provider, default, rebuild)
            host.tts = tts_engine
        else:
            host = await _build_host(settings)
            host.tts = create_tts(settings)
        app.state.host = host
        # Load the voice in the background so startup stays fast.
        warm = asyncio.create_task(host.tts.warm_up()) if host.tts is not None else None
        try:
            yield
        finally:
            if warm is not None:
                warm.cancel()
            if agent is None:
                await close_checkpointers()

    routes: list[Any] = [
        WebSocketRoute("/ws", luna_socket),
        Route("/api/health", health),
        Route("/api/tts", tts, methods=["POST"]),
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
