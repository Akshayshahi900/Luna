"""Telegram bridge: media helpers, the Bot API client, and whole conversations
(text, voice notes, photos, approvals, questions, commands) against a fake
Telegram and fake models — no network, no API key."""

import io
import json
import time
import wave

import httpx
import numpy as np
import pytest
from langchain.agents import create_agent
from langchain.agents.middleware import HumanInTheLoopMiddleware
from langchain.tools import tool
from langgraph.checkpoint.memory import InMemorySaver

from conftest import tool_call
from luna.channels.media import decode_audio, pick_photo, safe_filename, split_text, wav_to_ogg_opus
from luna.channels.telegram import TelegramBridge, answers_from_text, pause_token, reply_kind
from luna.channels.telegram_api import TelegramAPI, TelegramError
from luna.config import Settings
from luna.config.schema import SECRETS, applies
from luna.tools.builtin import ask_user
from luna.web.server import AgentHost

OWNER = 42


def _wav(seconds: float = 1.0, rate: int = 22050) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        t = np.arange(int(rate * seconds))
        w.writeframes((np.sin(t / 10) * 8000).astype(np.int16).tobytes())
    return buf.getvalue()


# --- media -------------------------------------------------------------------

def test_voice_round_trip_wav_to_opus_to_whisper_samples():
    ogg = wav_to_ogg_opus(_wav(1.0))
    assert ogg[:4] == b"OggS"
    samples = decode_audio(ogg)
    assert samples.dtype == np.float32
    assert 15_000 < len(samples) < 17_500  # ~1 s at 16 kHz (Opus adds a little padding)
    assert 0.1 < np.abs(samples).max() <= 1.0


def test_decode_audio_refuses_garbage_and_long_notes():
    with pytest.raises(ValueError):
        decode_audio(b"definitely not audio")
    with pytest.raises(ValueError, match="longer than"):
        decode_audio(_wav(2.0), max_seconds=1)


def test_split_text_prefers_breaks_and_respects_the_limit():
    assert split_text("hello") == ["hello"]
    parts = split_text("word " * 50, limit=40)
    assert all(len(p) <= 40 for p in parts) and " ".join(parts).split() == ["word"] * 50
    assert split_text("x" * 100, limit=40) == ["x" * 40, "x" * 40, "x" * 20]  # no break: hard cut
    assert split_text("a\n\nb", limit=3) == ["a", "b"]


def test_pick_photo_and_safe_filename():
    sizes = [{"file_id": "s", "width": 90, "height": 60}, {"file_id": "m", "width": 1280, "height": 853},
             {"file_id": "l", "width": 2560, "height": 1706}]
    assert pick_photo(sizes)["file_id"] == "m"
    assert pick_photo(sizes[2:])["file_id"] == "l"  # nothing fits: the smallest there is
    assert pick_photo([]) is None
    assert safe_filename("../../etc/passwd") == "passwd"
    assert safe_filename("my report (final).pdf") == "my_report_final_.pdf"
    assert safe_filename("...") == "file"


# --- replies to pauses -------------------------------------------------------

APPROVAL = {"id": "p1", "kind": "approval",
            "actions": [{"name": "write_file", "args": {}, "description": None, "allowed": ["approve", "edit", "reject"]}]}


def test_reply_words():
    assert reply_kind("Yes!") == "approve" and reply_kind("go ahead.") == "approve"
    assert reply_kind("No") == "reject" and reply_kind("cancel") == "reject"
    assert reply_kind("no, call it b.txt") == "other"


def test_text_answers_for_approvals_and_questions():
    question = {"id": "q1", "kind": "question", "question": "Which?"}
    assert answers_from_text({"p1": APPROVAL}, "yes") == {"p1": {"decisions": [{"type": "approve"}]}}
    assert answers_from_text({"p1": APPROVAL}, "nope") == {"p1": {"decisions": [{"type": "reject"}]}}
    assert answers_from_text({"p1": APPROVAL, "q1": question}, "use b.txt") == {
        "p1": {"decisions": [{"type": "reject", "message": "use b.txt"}]},
        "q1": "use b.txt",
    }
    assert pause_token({"b" * 40: {}, "a" * 40: {}}) == "a" * 16


def test_telegram_settings_in_the_control_center():
    assert "telegram_bot_token" in SECRETS and applies("telegram_bot_token") == "restart"
    assert applies("telegram_allowed_users") == "live" and applies("model_vision") == "live"
    assert Settings(telegram_allowed_users="42, 7").telegram_allowed_users == [42, 7]


# --- Bot API client ----------------------------------------------------------

async def test_api_calls_and_token_never_leaks():
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.url.path.endswith("/getFile"):
            return httpx.Response(200, json={"ok": True, "result": {"file_path": "voice/1.oga", "file_size": 3}})
        if "/file/" in request.url.path:
            return httpx.Response(200, content=b"abc")
        if request.url.path.endswith("/sendMessage"):
            return httpx.Response(200, json={"ok": False, "description": "Bad Request: chat not found"})
        raise httpx.ConnectError(f"boom {request.url}")

    api = TelegramAPI("123:SECRET", client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    assert await api.download("f1") == b"abc"
    assert seen[1].url.path == "/file/bot123:SECRET/voice/1.oga"
    with pytest.raises(TelegramError, match="chat not found"):
        await api.send_message(1, "hi", [[{"text": "ok", "callback_data": "x"}]])
    assert json.loads(seen[2].content)["reply_markup"] == {"inline_keyboard": [[{"text": "ok", "callback_data": "x"}]]}
    with pytest.raises(TelegramError) as info:
        await api.get_updates(None, timeout=1)
    assert "SECRET" not in str(info.value) and "<token>" in str(info.value)


# --- whole conversations -----------------------------------------------------

class FakeTelegram:
    """Records what the bot sends; serves uploaded files from ``files``."""

    def __init__(self, files: dict[str, bytes] | None = None) -> None:
        self.files = files or {}
        self.sent: list[dict] = []
        self.voices: list[bytes] = []
        self.acks: list[str | None] = []
        self.cleared: list[int] = []

    async def send_message(self, chat_id, text, buttons=None):
        self.sent.append({"chat": chat_id, "text": text, "buttons": buttons})
        return {"message_id": len(self.sent)}

    async def send_voice(self, chat_id, ogg):
        self.voices.append(ogg)

    async def send_chat_action(self, chat_id, action="typing"):
        pass

    async def answer_callback(self, callback_id, text=None):
        self.acks.append(text)

    async def clear_buttons(self, chat_id, message_id):
        self.cleared.append(message_id)

    async def download(self, file_id, max_bytes=0):
        return self.files[file_id]

    async def aclose(self):
        pass

    @property
    def texts(self) -> list[str]:
        return [m["text"] for m in self.sent]


class FakeSTT:
    def __init__(self, text: str) -> None:
        self.text, self.samples = text, None

    async def atranscribe(self, samples, prompt=None):
        self.samples = samples
        return self.text


class FakeTTS:
    async def asynthesize(self, text):
        return _wav(0.3)


written: list[dict] = []


@tool
def write_file(path: str, text: str) -> str:
    """Write a file."""
    written.append({"path": path, "text": text})
    return f"wrote {path}"


def _settings(tmp_path, **overrides):
    values = dict(openrouter_api_key="test", task_budget=50, telegram_allowed_users=[OWNER],
                  workspace_dirs=[tmp_path / "ws"], telegram_voice_replies=True,
                  telegram_routine_alerts=True, model_vision=False)
    return Settings(**{**values, **overrides})


def _bridge(tmp_path, agent, api=None, **overrides):
    host = AgentHost(agent, _settings(tmp_path, **overrides), "openrouter", "fake")
    return TelegramBridge(host, api or FakeTelegram(), tmp_path / "telegram.json")


def _msg(text=None, user=OWNER, chat_type="private", date=None, **extra):
    msg = {"message_id": 1, "date": date or int(time.time()), "chat": {"id": user, "type": chat_type},
           "from": {"id": user}, **extra}
    if text is not None:
        msg["text"] = text
    return {"update_id": 1, "message": msg}


def _press(data, user=OWNER, message_id=99):
    return {"update_id": 2, "callback_query": {"id": "cb", "from": {"id": user}, "data": data,
                                               "message": {"message_id": message_id, "chat": {"id": user}}}}


async def _send(bridge, update):
    await bridge.handle_update(update)
    chat = bridge.chats.get(OWNER)
    if chat is not None and chat.task is not None:
        await chat.task


async def test_strangers_get_their_id_and_groups_are_ignored(tmp_path, make_fake_model):
    model = make_fake_model("should never run")
    bridge = _bridge(tmp_path, create_agent(model=model, tools=[], checkpointer=InMemorySaver()))
    await _send(bridge, _msg("hi", user=7))
    (reply,) = bridge.api.texts
    assert "Your Telegram user id is 7" in reply
    await _send(bridge, _msg("hi", chat_type="group"))
    assert len(bridge.api.sent) == 1 and model.received == []


async def test_text_message_gets_a_reply_on_a_saved_thread(tmp_path, make_fake_model):
    agent = create_agent(model=make_fake_model("Hello, Sir."), tools=[], checkpointer=InMemorySaver())
    bridge = _bridge(tmp_path, agent)
    await _send(bridge, _msg("hello"))
    assert bridge.api.texts == ["Hello, Sir."]
    thread = json.loads((tmp_path / "telegram.json").read_text())["threads"][str(OWNER)]
    assert thread == bridge.chats[OWNER].thread_id
    assert bridge.host.usage["runs"] == 1 and bridge.host.usage["model_calls"] == 1


async def test_stale_messages_are_skipped(tmp_path, make_fake_model):
    model = make_fake_model("late")
    bridge = _bridge(tmp_path, create_agent(model=model, tools=[], checkpointer=InMemorySaver()))
    await _send(bridge, _msg("send the report", date=int(time.time()) - 3600))
    assert "offline" in bridge.api.texts[0] and model.received == []


async def test_approval_with_buttons(tmp_path, make_fake_model):
    written.clear()
    model = make_fake_model(tool_call("write_file", path="a.txt", text="hi"), "Saved it.")
    agent = create_agent(model=model, tools=[write_file], checkpointer=InMemorySaver(),
                         middleware=[HumanInTheLoopMiddleware(interrupt_on={"write_file": True})])
    bridge = _bridge(tmp_path, agent)
    await _send(bridge, _msg("save a note"))
    card = bridge.api.sent[-1]
    assert "write_file" in card["text"] and "a.txt" in card["text"] and written == []
    approve, reject = card["buttons"][0]
    assert approve["text"].endswith("Approve") and reject["text"].endswith("Reject")

    await _send(bridge, _press(approve["callback_data"]))
    assert written == [{"path": "a.txt", "text": "hi"}]
    assert bridge.api.texts[-1] == "Saved it." and bridge.api.acks == ["Approved"]
    assert bridge.api.cleared == [len(bridge.api.sent) - 1]  # the card lost its buttons
    assert bridge.chats[OWNER].pending == {}

    await _send(bridge, _press(approve["callback_data"]))  # pressed again
    assert bridge.api.acks[-1] == "That was already answered." and len(written) == 1


async def test_reply_text_rejects_with_a_reason(tmp_path, make_fake_model):
    written.clear()
    model = make_fake_model(tool_call("write_file", path="a.txt", text="hi"), "OK, I won't.")
    agent = create_agent(model=model, tools=[write_file], checkpointer=InMemorySaver(),
                         middleware=[HumanInTheLoopMiddleware(interrupt_on={"write_file": True})])
    bridge = _bridge(tmp_path, agent)
    await _send(bridge, _msg("save a note"))
    await _send(bridge, _msg("no, call it b.txt"))
    assert written == [] and bridge.api.texts[-1] == "OK, I won't."
    assert any("call it b.txt" in text for text in model.inputs[-1])  # Luna saw why


async def test_question_is_answered_by_the_next_message(tmp_path, make_fake_model):
    model = make_fake_model(tool_call("ask_user", question="Which colour?"), "Blue it is.")
    agent = create_agent(model=model, tools=[ask_user], checkpointer=InMemorySaver())
    bridge = _bridge(tmp_path, agent)
    await _send(bridge, _msg("pick a colour"))
    assert bridge.api.texts[-1] == "❓ Which colour?"
    await _send(bridge, _msg("blue"))
    assert bridge.api.texts[-1] == "Blue it is."


async def test_pending_approval_survives_a_restart(tmp_path, make_fake_model):
    written.clear()
    model = make_fake_model(tool_call("write_file", path="a.txt", text="hi"), "Done after restart.")
    agent = create_agent(model=model, tools=[write_file], checkpointer=InMemorySaver(),
                         middleware=[HumanInTheLoopMiddleware(interrupt_on={"write_file": True})])
    first = _bridge(tmp_path, agent)
    await _send(first, _msg("save a note"))
    approve = first.api.sent[-1]["buttons"][0][0]["callback_data"]

    second = _bridge(tmp_path, agent)  # same state file and checkpointer
    await _send(second, _press(approve))
    assert written == [{"path": "a.txt", "text": "hi"}] and second.api.texts[-1] == "Done after restart."


async def test_voice_note_is_transcribed_and_answered_by_voice(tmp_path, make_fake_model):
    model = make_fake_model("It is noon.")
    agent = create_agent(model=model, tools=[], checkpointer=InMemorySaver())
    api = FakeTelegram({"v1": wav_to_ogg_opus(_wav(1.0))})
    bridge = _bridge(tmp_path, agent, api)
    bridge.host.stt, bridge.host.tts = FakeSTT("what time is it"), FakeTTS()
    await _send(bridge, _msg(voice={"file_id": "v1", "duration": 1}))
    assert api.texts == ["🎙 “what time is it”", "It is noon."]
    assert model.inputs[-1][-1] == "what time is it"
    assert len(bridge.host.stt.samples) > 15_000  # real 16 kHz samples reached Whisper
    (voice,) = api.voices
    assert voice[:4] == b"OggS"


async def test_voice_note_without_whisper_explains(tmp_path, make_fake_model):
    model = make_fake_model("unused")
    bridge = _bridge(tmp_path, create_agent(model=model, tools=[], checkpointer=InMemorySaver()))
    await _send(bridge, _msg(voice={"file_id": "v1"}))
    assert "LUNA_STT_ENGINE=whisper" in bridge.api.texts[-1] and model.received == []


async def test_photo_is_saved_and_shown_to_a_vision_model(tmp_path, make_fake_model):
    model = make_fake_model("A cat.")
    agent = create_agent(model=model, tools=[], checkpointer=InMemorySaver())
    api = FakeTelegram({"big": b"\xff\xd8jpeg"})
    bridge = _bridge(tmp_path, agent, api, model_vision=True)
    photo = [{"file_id": "small", "width": 90, "height": 90},
             {"file_id": "big", "file_unique_id": "u1", "width": 800, "height": 800}]
    await _send(bridge, _msg(photo=photo, caption="what is this?"))
    assert api.texts == ["A cat."]
    (saved,) = (tmp_path / "ws" / "telegram").iterdir()
    assert saved.read_bytes() == b"\xff\xd8jpeg" and saved.name.endswith("photo-u1.jpg")
    state = await agent.aget_state({"configurable": {"thread_id": bridge.chats[OWNER].thread_id}})
    content = state.values["messages"][0].content
    assert content[0]["text"].startswith("what is this?") and f"telegram/{saved.name}" in content[0]["text"]
    assert content[1]["image_url"]["url"].startswith("data:image/jpeg;base64,")


async def test_file_without_vision_only_gives_the_path(tmp_path, make_fake_model):
    model = make_fake_model("Got the PDF.")
    agent = create_agent(model=model, tools=[], checkpointer=InMemorySaver())
    api = FakeTelegram({"d1": b"%PDF"})
    bridge = _bridge(tmp_path, agent, api)
    await _send(bridge, _msg(document={"file_id": "d1", "file_name": "../Q3 report.pdf", "mime_type": "application/pdf"}))
    (saved,) = (tmp_path / "ws" / "telegram").iterdir()
    assert saved.name.endswith("Q3_report.pdf")
    assert f"saved in the workspace as telegram/{saved.name}" in model.inputs[-1][-1]


async def test_commands(tmp_path, make_fake_model):
    agent = create_agent(model=make_fake_model("hi"), tools=[], checkpointer=InMemorySaver())
    bridge = _bridge(tmp_path, agent)
    await _send(bridge, _msg("/start"))
    assert "/new" in bridge.api.texts[-1]
    await _send(bridge, _msg("/stop"))
    assert bridge.api.texts[-1] == "Nothing to stop."
    old = bridge.chats[OWNER].thread_id
    await _send(bridge, _msg("/new"))
    assert bridge.chats[OWNER].thread_id != old
    assert json.loads((tmp_path / "telegram.json").read_text())["threads"][str(OWNER)] == bridge.chats[OWNER].thread_id


async def test_stop_abandons_a_pending_approval(tmp_path, make_fake_model):
    written.clear()
    model = make_fake_model(tool_call("write_file", path="a.txt", text="hi"), "Next task done.")
    agent = create_agent(model=model, tools=[write_file], checkpointer=InMemorySaver(),
                         middleware=[HumanInTheLoopMiddleware(interrupt_on={"write_file": True})])
    bridge = _bridge(tmp_path, agent)
    await _send(bridge, _msg("save a note"))
    await _send(bridge, _msg("/stop"))
    assert bridge.api.texts[-1] == "Cancelled." and bridge.chats[OWNER].pending == {}
    await _send(bridge, _msg("something else"))
    assert bridge.api.texts[-1] == "Next task done." and written == []


async def test_routine_results_are_forwarded(tmp_path, make_fake_model):
    bridge = _bridge(tmp_path, create_agent(model=make_fake_model(), tools=[], checkpointer=InMemorySaver()))
    bridge.on_host_event({"type": "routine_result", "routine": {"name": "Mail check", "notify": True},
                          "run": {"status": "ok", "summary": "2 new emails"}})
    bridge.on_host_event({"type": "routine_result", "routine": {"name": "Quiet", "notify": False},
                          "run": {"status": "ok", "summary": "x"}})
    bridge.on_host_event({"type": "model", "provider": "groq"})
    for task in list(bridge._background):
        await task
    assert bridge.api.sent == [{"chat": OWNER, "text": "⏰ Mail check: 2 new emails", "buttons": None}]
