"""Web UI backend: event translation, pause answers, origin check, and the
/ws protocol end to end (fake models, no API key)."""

from langchain.agents import create_agent
from langchain.agents.middleware import HumanInTheLoopMiddleware
from langchain.tools import tool
from langchain_core.messages import AIMessage, AIMessageChunk, ToolMessage
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.types import Interrupt
import pytest
from starlette.testclient import TestClient

from conftest import tool_call
from luna.config import Settings
from luna.tools.builtin import ask_user, calculator
from luna.web.events import EventTranslator, build_answer, describe_pause
from luna.web.server import create_app, origin_allowed


def _settings(**overrides):
    return Settings(openrouter_api_key="test", task_budget=50, **overrides)


# --- EventTranslator ---------------------------------------------------------

def test_tokens_come_only_from_the_main_agents_model():
    t = EventTranslator()
    chunk = AIMessageChunk(content="Hi")
    assert t((), "messages", (chunk, {"langgraph_node": "model"})) == [{"type": "token", "text": "Hi"}]
    assert t(("tools:1",), "messages", (chunk, {"langgraph_node": "model"})) == []  # subagent text
    assert t((), "messages", (chunk, {"langgraph_node": "tools"})) == []


def test_updates_become_tool_calls_results_and_notices():
    t = EventTranslator()
    call = AIMessage(content="", tool_calls=[{"name": "calculator", "args": {"expression": "1+1"}, "id": "c1"}])
    result = ToolMessage(content="2", tool_call_id="c1", name="calculator")
    notice = AIMessage(content="Model call limits exceeded")

    assert t(("tools:x",), "updates", {"model": {"messages": [call]}}) == [
        {"type": "tool_call", "id": "c1", "name": "calculator", "args": {"expression": "1+1"}, "depth": 1}
    ]
    assert t((), "updates", {"tools": {"messages": [result]}}) == [
        {"type": "tool_result", "id": "c1", "name": "calculator", "preview": "2", "depth": 0}
    ]
    assert t((), "updates", {"limit": {"messages": [notice]}}) == [
        {"type": "notice", "text": "Model call limits exceeded", "depth": 0}
    ]
    assert t((), "updates", {"__interrupt__": (), "other": None}) == []


def test_long_tool_results_are_shortened():
    long = ToolMessage(content="x " * 500, tool_call_id="c1", name="read_file")
    (event,) = EventTranslator()((), "updates", {"tools": {"messages": [long]}})
    assert len(event["preview"]) <= 240 and event["preview"].endswith("…")


# --- describe_pause / build_answer -------------------------------------------

def _approval():
    return Interrupt(
        value={
            "action_requests": [{"name": "write_file", "args": {"path": "a.md"}, "description": "d"}],
            "review_configs": [{"action_name": "write_file", "allowed_decisions": ["approve", "reject"]}],
        },
        id="p1",
    )


def test_describe_pause_kinds():
    question = describe_pause(Interrupt(value={"type": "ask_user", "question": "Which?"}, id="q"))
    assert question == {"id": "q", "kind": "question", "question": "Which?"}
    approval = describe_pause(_approval())
    assert approval["kind"] == "approval"
    assert approval["actions"] == [
        {"name": "write_file", "args": {"path": "a.md"}, "description": "d", "allowed": ["approve", "reject"]}
    ]
    assert describe_pause(Interrupt(value=42, id="o"))["kind"] == "other"


def test_build_answer_matches_the_cli_formats():
    pause = describe_pause(_approval())
    assert build_answer(pause, {"decisions": [{"type": "approve"}]}) == {"decisions": [{"type": "approve"}]}
    assert build_answer(pause, {"decisions": [{"type": "reject", "message": "no"}]}) == {
        "decisions": [{"type": "reject", "message": "no"}]
    }
    assert build_answer(pause, {"decisions": [{"type": "reject", "message": " "}]}) == {"decisions": [{"type": "reject"}]}
    question = {"id": "q", "kind": "question", "question": "?"}
    assert build_answer(question, {"answer": "blue"}) == "blue"
    assert build_answer(question, "red") == "red"


def test_build_answer_edit_and_one_decision_for_many_actions():
    pause = {
        "id": "p",
        "kind": "approval",
        "actions": [
            {"name": "write_file", "args": {}, "allowed": ["approve", "edit", "reject"]},
            {"name": "edit_file", "args": {}, "allowed": ["approve", "edit", "reject"]},
        ],
    }
    assert build_answer(pause, {"decisions": [{"type": "approve"}]}) == {
        "decisions": [{"type": "approve"}, {"type": "approve"}]
    }
    single = {**pause, "actions": pause["actions"][:1]}
    assert build_answer(single, {"decisions": [{"type": "edit", "args": {"path": "b"}}]}) == {
        "decisions": [{"type": "edit", "edited_action": {"name": "write_file", "args": {"path": "b"}}}]
    }


@pytest.mark.parametrize(
    "reply",
    [
        {},
        {"decisions": []},
        {"decisions": [{"type": "edit"}]},  # edit not allowed here, and no args
        {"decisions": [{"type": "approve"}, {"type": "approve"}]},  # too many
    ],
)
def test_build_answer_rejects_bad_approvals(reply):
    with pytest.raises(ValueError):
        build_answer(describe_pause(_approval()), reply)


# --- origin check --------------------------------------------------------------

def test_origin_allowed():
    allowed = ["http://localhost:5173"]
    assert origin_allowed(None, "127.0.0.1:8765", allowed)  # not a browser
    assert origin_allowed("http://127.0.0.1:8765", "127.0.0.1:8765", allowed)  # served by us
    assert origin_allowed("http://localhost:5173/", "127.0.0.1:8765", allowed)  # dev server
    assert not origin_allowed("https://evil.example", "127.0.0.1:8765", allowed)


def test_settings_split_allowed_origins():
    s = _settings(web_allowed_origins="http://a:1/, http://b:2")
    assert s.web_allowed_origins == ["http://a:1", "http://b:2"]


# --- /ws end to end ------------------------------------------------------------

def _receive_until(ws, *types):
    """Collect events until one of ``types`` arrives; return them all."""
    events = []
    while True:
        event = ws.receive_json()
        events.append(event)
        if event["type"] in types:
            return events


def _connect(client):
    ws = client.websocket_connect("/ws")
    session = ws.__enter__()
    hello = session.receive_json()
    thread = session.receive_json()
    return ws, session, hello, thread


def test_socket_streams_a_reply(make_fake_model):
    model = make_fake_model(tool_call("calculator", expression="6*7"), "The answer is 42")
    agent = create_agent(model=model, tools=[calculator], checkpointer=InMemorySaver())
    with TestClient(create_app(agent=agent, settings=_settings())) as client:
        ws, session, hello, thread = _connect(client)
        assert hello["type"] == "hello" and "calculator" in hello["tools"]
        assert thread == {"type": "thread", "id": "default", "history": []}

        session.send_json({"type": "message", "text": "what is 6*7?"})
        events = _receive_until(session, "done", "error")
        types = [e["type"] for e in events]
        assert types[0] == "state" and types[-1] == "done"
        assert {"type": "tool_call", "id": "c1", "name": "calculator", "args": {"expression": "6*7"}, "depth": 0} in events
        assert any(e["type"] == "tool_result" and e["preview"] == "42" for e in events)
        assert "".join(e["text"] for e in events if e["type"] == "token") == "The answer is 42"
        ws.__exit__(None, None, None)


def test_socket_question_pause_and_resume(make_fake_model):
    model = make_fake_model(tool_call("ask_user", question="Which colour?"), "Blue it is")
    agent = create_agent(model=model, tools=[ask_user], checkpointer=InMemorySaver())
    with TestClient(create_app(agent=agent, settings=_settings())) as client:
        ws, session, *_ = _connect(client)
        session.send_json({"type": "message", "text": "pick a colour"})
        pause = _receive_until(session, "pause")[-1]
        (p,) = pause["pauses"]
        assert p["kind"] == "question" and p["question"] == "Which colour?"

        # A new message while paused is refused; the pause stays.
        session.send_json({"type": "message", "text": "hello?"})
        assert session.receive_json()["type"] == "error"

        session.send_json({"type": "resume", "answers": {p["id"]: {"answer": "blue"}}})
        events = _receive_until(session, "done", "error")
        assert events[-1]["type"] == "done"
        assert any(e["type"] == "tool_result" and e["preview"] == "blue" for e in events)
        ws.__exit__(None, None, None)


def test_socket_approval_reject_skips_the_action(make_fake_model):
    written = []

    @tool
    def write_file(path: str, content: str) -> str:
        """Write a file."""
        written.append(path)
        return "ok"

    model = make_fake_model(tool_call("write_file", path="a.md", content="x"), "fine, skipped")
    agent = create_agent(
        model=model,
        tools=[write_file],
        checkpointer=InMemorySaver(),
        middleware=[HumanInTheLoopMiddleware(interrupt_on={"write_file": True})],
    )
    with TestClient(create_app(agent=agent, settings=_settings())) as client:
        ws, session, *_ = _connect(client)
        session.send_json({"type": "message", "text": "save"})
        (p,) = _receive_until(session, "pause")[-1]["pauses"]
        assert p["kind"] == "approval" and p["actions"][0]["name"] == "write_file"

        session.send_json({"type": "resume", "answers": {p["id"]: {"decisions": [{"type": "reject"}]}}})
        assert _receive_until(session, "done", "error")[-1]["type"] == "done"
        assert written == []
        ws.__exit__(None, None, None)


def test_socket_pause_survives_a_reconnect(make_fake_model):
    model = make_fake_model(tool_call("ask_user", question="Name?"), "Hi Ada")
    agent = create_agent(model=model, tools=[ask_user], checkpointer=InMemorySaver())
    with TestClient(create_app(agent=agent, settings=_settings())) as client:
        ws, session, *_ = _connect(client)
        session.send_json({"type": "message", "text": "greet me"})
        (p,) = _receive_until(session, "pause")[-1]["pauses"]
        ws.__exit__(None, None, None)

        ws, session, _, thread = _connect(client)  # e.g. the page was reloaded
        assert thread["history"] == [{"role": "user", "text": "greet me"}]
        (again,) = session.receive_json()["pauses"]
        assert again["id"] == p["id"]
        session.send_json({"type": "resume", "answers": {p["id"]: "Ada"}})
        assert _receive_until(session, "done", "error")[-1]["type"] == "done"
        ws.__exit__(None, None, None)


def test_socket_threads_and_bad_input(make_fake_model):
    agent = create_agent(model=make_fake_model("hi"), tools=[], checkpointer=InMemorySaver())
    with TestClient(create_app(agent=agent, settings=_settings())) as client:
        ws, session, *_ = _connect(client)
        session.send_text("not json")
        assert session.receive_json()["type"] == "error"
        session.send_json({"type": "resume", "answers": {}})
        assert session.receive_json()["type"] == "error"  # nothing paused
        session.send_json({"type": "bogus"})
        assert session.receive_json()["type"] == "error"

        session.send_json({"type": "new_thread"})
        new = session.receive_json()
        assert new["type"] == "thread" and new["id"] != "default" and new["history"] == []
        session.send_json({"type": "thread", "id": "work"})
        assert session.receive_json()["id"] == "work"
        ws.__exit__(None, None, None)


def test_socket_refuses_foreign_origins(make_fake_model):
    from starlette.websockets import WebSocketDisconnect

    agent = create_agent(model=make_fake_model("hi"), tools=[], checkpointer=InMemorySaver())
    with TestClient(create_app(agent=agent, settings=_settings())) as client:
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect("/ws", headers={"origin": "https://evil.example"}) as ws:
                ws.receive_json()


def test_health_and_no_build_page(make_fake_model, monkeypatch, tmp_path):
    import luna.web.server as server

    monkeypatch.setattr(server, "DIST_DIR", tmp_path)  # no index.html → hint page
    agent = create_agent(model=make_fake_model("hi"), tools=[], checkpointer=InMemorySaver())
    with TestClient(create_app(agent=agent, settings=_settings())) as client:
        assert client.get("/api/health").json()["status"] == "ok"
        assert "npm run build" in client.get("/").text


# --- model switching -----------------------------------------------------------

def test_socket_switches_model_for_every_tab(make_fake_model):
    built = []

    async def rebuild(provider, model):
        built.append((provider, model))
        return create_agent(model=make_fake_model("from the new model"), tools=[], checkpointer=InMemorySaver())

    agent = create_agent(model=make_fake_model("old"), tools=[], checkpointer=InMemorySaver())
    settings = _settings(groq_api_key="gq")
    with TestClient(create_app(agent=agent, settings=settings, rebuild=rebuild)) as client:
        ws1, tab1, hello, _ = _connect(client)
        ws2, tab2, *_ = _connect(client)
        assert hello["provider"] == "openrouter" and hello["can_switch"] is True
        assert {p["id"] for p in hello["providers"]} == {"openrouter", "groq", "ollama"}

        tab1.send_json({"type": "set_model", "provider": "groq", "model": ""})
        expected = {"type": "model", "provider": "groq", "model": settings.groq_model}
        assert tab1.receive_json() == expected
        assert tab2.receive_json() == expected  # the other tab hears about it too
        assert built == [("groq", settings.groq_model)]

        tab2.send_json({"type": "message", "text": "hi"})
        events = _receive_until(tab2, "done", "error")
        assert "".join(e["text"] for e in events if e["type"] == "token") == "from the new model"
        assert client.get("/api/health").json()["provider"] == "groq"
        ws2.__exit__(None, None, None)
        ws1.__exit__(None, None, None)


def test_socket_switch_errors_and_model_list(make_fake_model, monkeypatch):
    import luna.web.server as server

    async def rebuild(provider, model):
        raise ValueError("Set LUNA_GROQ_API_KEY in your .env file to use Groq.")

    async def fake_list(settings, provider):
        if provider == "ollama":
            raise ConnectionError("connection refused")
        return ["m1", "m2"]

    monkeypatch.setattr(server, "list_models", fake_list)
    agent = create_agent(model=make_fake_model("hi"), tools=[], checkpointer=InMemorySaver())
    with TestClient(create_app(agent=agent, settings=_settings(), rebuild=rebuild)) as client:
        ws, session, *_ = _connect(client)
        session.send_json({"type": "set_model", "provider": "groq", "model": "x"})
        assert "LUNA_GROQ_API_KEY" in session.receive_json()["message"]
        session.send_json({"type": "models", "provider": "openrouter"})
        assert session.receive_json() == {"type": "models", "provider": "openrouter", "models": ["m1", "m2"]}
        session.send_json({"type": "models", "provider": "ollama"})
        reply = session.receive_json()
        assert reply["models"] == [] and "refused" in reply["error"]
        ws.__exit__(None, None, None)


def test_switching_needs_a_rebuild_function(make_fake_model):
    agent = create_agent(model=make_fake_model("hi"), tools=[], checkpointer=InMemorySaver())
    with TestClient(create_app(agent=agent, settings=_settings())) as client:
        ws, session, hello, _ = _connect(client)
        assert hello["can_switch"] is False
        session.send_json({"type": "set_model", "provider": "ollama", "model": "m"})
        assert session.receive_json()["type"] == "error"
        ws.__exit__(None, None, None)


# --- voice (/api/tts) ------------------------------------------------------------

class _FakeTTS:
    def __init__(self):
        self.said = []

    async def asynthesize(self, text):
        self.said.append(text)
        return b"RIFF....WAVEfake"

    async def warm_up(self):
        pass


def test_tts_endpoint_returns_audio(make_fake_model):
    engine = _FakeTTS()
    agent = create_agent(model=make_fake_model("hi"), tools=[], checkpointer=InMemorySaver())
    with TestClient(create_app(agent=agent, settings=_settings(), tts_engine=engine)) as client:
        ws, _, hello, _ = _connect(client)
        assert hello["tts"] == "piper"
        ws.__exit__(None, None, None)
        response = client.post("/api/tts", json={"text": "Hello there."})
        assert response.status_code == 200
        assert response.headers["content-type"] == "audio/wav"
        assert response.content == b"RIFF....WAVEfake"
        assert engine.said == ["Hello there."]

        assert client.post("/api/tts", json={"text": "  "}).status_code == 400
        assert client.post("/api/tts", json={"text": "x" * 5000}).status_code == 400
        assert client.post("/api/tts", content=b"not json").status_code == 400
        foreign = client.post("/api/tts", json={"text": "hi"}, headers={"origin": "https://evil.example"})
        assert foreign.status_code == 403


def test_tts_endpoint_off_means_browser_speech(make_fake_model):
    agent = create_agent(model=make_fake_model("hi"), tools=[], checkpointer=InMemorySaver())
    with TestClient(create_app(agent=agent, settings=_settings())) as client:
        ws, _, hello, _ = _connect(client)
        assert hello["tts"] == "browser"
        ws.__exit__(None, None, None)
        assert client.post("/api/tts", json={"text": "hi"}).status_code == 404


def test_tts_engine_errors_become_500(make_fake_model):
    class Broken(_FakeTTS):
        async def asynthesize(self, text):
            raise RuntimeError("voice model missing")

    agent = create_agent(model=make_fake_model("hi"), tools=[], checkpointer=InMemorySaver())
    with TestClient(create_app(agent=agent, settings=_settings(), tts_engine=Broken())) as client:
        response = client.post("/api/tts", json={"text": "hi"})
        assert response.status_code == 500 and "voice model missing" in response.json()["error"]


def test_tts_settings():
    from luna.voice import create_tts

    assert create_tts(_settings(tts_engine="browser")) is None
    engine = create_tts(_settings(tts_engine="PIPER", tts_voice="en_GB-alba-medium"))
    assert engine is not None and engine.model_path.name == "en_GB-alba-medium.onnx"
    with pytest.raises(ValueError):
        _settings(tts_engine="espeak")


# --- speech recognition (/api/stt) -------------------------------------------------

def _wav(seconds=0.5, rate=16000, channels=1):
    import io
    import wave

    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(b"\x00\x00" * int(seconds * rate) * channels)
    return buf.getvalue()


class _FakeSTT:
    def __init__(self, text="Hey Luna. What time is it?"):
        self.text = text
        self.heard = []

    async def atranscribe(self, samples, prompt=None):
        self.heard.append(len(samples))
        return self.text

    async def warm_up(self):
        pass


def test_stt_endpoint_transcribes_wav(make_fake_model):
    engine = _FakeSTT()
    agent = create_agent(model=make_fake_model("hi"), tools=[], checkpointer=InMemorySaver())
    with TestClient(create_app(agent=agent, settings=_settings(), stt_engine=engine)) as client:
        ws, _, hello, _ = _connect(client)
        assert hello["stt"] == "whisper"
        ws.__exit__(None, None, None)

        response = client.post("/api/stt", content=_wav(0.5), headers={"content-type": "audio/wav"})
        assert response.json() == {"text": "Hey Luna. What time is it?"}
        assert engine.heard == [8000]  # 0.5 s at 16 kHz

        assert client.post("/api/stt", content=b"nope").status_code == 400
        assert client.post("/api/stt", content=_wav(rate=44100)).status_code == 400  # must be 16 kHz
        assert client.post("/api/stt", content=_wav(channels=2)).status_code == 400
        assert client.post("/api/stt", content=_wav(seconds=31)).status_code == 400
        foreign = client.post("/api/stt", content=_wav(), headers={"origin": "https://evil.example"})
        assert foreign.status_code == 403


def test_stt_off_means_browser_recognition(make_fake_model):
    agent = create_agent(model=make_fake_model("hi"), tools=[], checkpointer=InMemorySaver())
    with TestClient(create_app(agent=agent, settings=_settings())) as client:
        ws, _, hello, _ = _connect(client)
        assert hello["stt"] == "browser"
        ws.__exit__(None, None, None)
        assert client.post("/api/stt", content=_wav()).status_code == 404


def test_wav_to_samples_scales_to_float():
    import io
    import wave

    from luna.voice.stt import wav_to_samples

    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes((16384).to_bytes(2, "little", signed=True) + (-32768).to_bytes(2, "little", signed=True))
    samples = wav_to_samples(buf.getvalue())
    assert samples.dtype.name == "float32"
    assert samples.tolist() == [0.5, -1.0]


def test_stt_settings():
    from luna.voice import create_stt

    assert create_stt(_settings(stt_engine="browser")) is None
    engine = create_stt(_settings(stt_engine="Whisper", stt_model="small.en"))
    assert engine is not None and engine.model_name == "small.en"
    with pytest.raises(ValueError):
        _settings(stt_engine="vosk")


# --- cancelling ------------------------------------------------------------------

def _slow_agent(make_fake_model, started, cancelled):
    import asyncio

    @tool
    async def long_job(title: str) -> str:
        """A slow job."""
        started.append(title)
        try:
            await asyncio.sleep(30)
        except asyncio.CancelledError:
            cancelled.append(title)
            raise
        return "finished"

    model = make_fake_model(tool_call("long_job", title="report"), "ready for the next thing")
    return create_agent(model=model, tools=[long_job], checkpointer=InMemorySaver())


def test_socket_cancel_stops_a_running_task_and_repairs_the_thread(make_fake_model):
    started, cancelled = [], []
    agent = _slow_agent(make_fake_model, started, cancelled)
    with TestClient(create_app(agent=agent, settings=_settings())) as client:
        ws, session, *_ = _connect(client)
        session.send_json({"type": "message", "text": "run the report"})
        _receive_until(session, "tool_call")

        # While it runs, the socket still answers — and refuses conflicting requests.
        session.send_json({"type": "message", "text": "and another"})
        assert "Still working" in session.receive_json()["message"]
        session.send_json({"type": "new_thread"})
        assert "cancel" in session.receive_json()["message"]

        session.send_json({"type": "cancel"})
        assert session.receive_json() == {"type": "cancelled", "tools": ["long_job"]}
        assert cancelled == ["report"]

        # The thread is usable again: the next message runs normally.
        session.send_json({"type": "message", "text": "hello"})
        events = _receive_until(session, "done", "error")
        assert events[-1]["type"] == "done"
        assert "".join(e["text"] for e in events if e["type"] == "token") == "ready for the next thing"
        ws.__exit__(None, None, None)


def test_socket_cancel_abandons_an_open_approval(make_fake_model):
    written = []

    @tool
    def write_file(path: str, content: str) -> str:
        """Write a file."""
        written.append(path)
        return "ok"

    model = make_fake_model(tool_call("write_file", path="a.md", content="x"), "what next?")
    agent = create_agent(
        model=model,
        tools=[write_file],
        checkpointer=InMemorySaver(),
        middleware=[HumanInTheLoopMiddleware(interrupt_on={"write_file": True})],
    )
    with TestClient(create_app(agent=agent, settings=_settings())) as client:
        ws, session, *_ = _connect(client)
        session.send_json({"type": "message", "text": "save"})
        _receive_until(session, "pause")
        session.send_json({"type": "cancel"})
        assert session.receive_json() == {"type": "cancelled", "tools": ["write_file"]}

        session.send_json({"type": "message", "text": "hi"})  # no longer "waiting for your answer"
        assert _receive_until(session, "done", "error")[-1]["type"] == "done"
        assert written == []
        ws.__exit__(None, None, None)


def test_socket_cancel_with_nothing_running(make_fake_model):
    agent = create_agent(model=make_fake_model("hi"), tools=[], checkpointer=InMemorySaver())
    with TestClient(create_app(agent=agent, settings=_settings())) as client:
        ws, session, *_ = _connect(client)
        session.send_json({"type": "cancel"})
        assert session.receive_json() == {"type": "cancelled", "tools": []}
        ws.__exit__(None, None, None)


async def test_cancel_cleanup_clears_a_helpers_approval(make_fake_model):
    """A pause inside a subagent (ask_files → write_file) is cleared too."""
    from luna.agent.subagents import SubagentSpec, make_delegate_tool
    from luna.web.server import CANCELLED, cancel_cleanup

    written = []

    @tool
    def write_file(path: str, content: str) -> str:
        """Write a file."""
        written.append(path)
        return "ok"

    helper = make_fake_model(tool_call("write_file", "w1", path="a.md", content="x"), "files done")
    delegate = make_delegate_tool(
        SubagentSpec(name="ask_files", description="Files.", system_prompt="p", tools=[write_file],
                     model=helper, interrupt_on={"write_file": True}),
        default_model=None,
    )
    agent = create_agent(model=make_fake_model(tool_call("ask_files", task="save"), "ok"), tools=[delegate],
                         checkpointer=InMemorySaver())
    config = {"configurable": {"thread_id": "t"}}
    await agent.ainvoke({"messages": [{"role": "user", "content": "save"}]}, config)
    assert len((await agent.aget_state(config)).interrupts) == 1

    assert await cancel_cleanup(agent, config) == ["ask_files"]
    state = await agent.aget_state(config)
    assert state.interrupts == ()
    assert state.values["messages"][-1].text == CANCELLED
    out = await agent.ainvoke({"messages": [{"role": "user", "content": "hi"}]}, config)
    assert out["messages"][-1].text == "ok" and written == []
