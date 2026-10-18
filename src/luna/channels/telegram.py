"""
TelegramBridge — use Luna from your phone through a Telegram bot.

BEGINNER MAP
------------
While luna-web runs (with LUNA_TELEGRAM_BOT_TOKEN set), the bridge long-polls
Telegram and treats each private chat like a browser tab (web/server.py
Session): same agent, same memory, same approvals.

  text        → a new task (run_task with a fresh TaskBudget)
  voice note  → Whisper (luna/voice/stt.py) → text; Luna echoes what she heard,
                and answers with a voice note too (LUNA_TELEGRAM_VOICE_REPLIES)
  photo       → saved to <workspace>/telegram/; sent to the model as an image
                when LUNA_MODEL_VISION=true, else Luna only gets the file path
  document    → saved to <workspace>/telegram/; Luna gets the file path
  /new /stop /help  → new thread, cancel, help

Pauses (D9: risky actions need a human):
  approval  → a card with Approve / Reject buttons; a text or voice reply
              works too: "yes" / "approve" approves, "no" / "reject" rejects,
              anything else rejects WITH that text as the reason, so Luna can
              try again your way
  question  → your next reply is the answer

Who may use it: only private chats with users listed in
LUNA_TELEGRAM_ALLOWED_USERS. Anyone else gets their own user id back (so the
owner can find theirs) and nothing else. Groups are ignored.

State: data/telegram.json keeps the update offset (so a message is never
handled twice) and each chat's thread id (so the conversation carries on
after a restart; it also shows up in the web UI's SESSIONS list). Pauses
live in the checkpoint, so a pending approval survives a restart too.

Routine results with notifications on are sent to the allowed users
(LUNA_TELEGRAM_ROUTINE_ALERTS).

Read next: luna/channels/telegram_api.py (the HTTP calls), docs/messaging.md.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Any

from langgraph.types import Command, Interrupt

from luna.agent.budget import TaskBudget
from luna.agent.builder import recursion_limit
from luna.agent.runner import run_task
from luna.agent.sessions import new_session_id
from luna.channels.media import decode_audio, pick_photo, safe_filename, split_text, wav_to_ogg_opus
from luna.channels.telegram_api import TelegramAPI, TelegramError
from luna.voice.tts import MAX_TEXT_CHARS
from luna.web.events import EventTranslator, build_answer, describe_pause
from luna.web.server import AgentHost, cancel_cleanup

_LOGGER = logging.getLogger(__name__)

POLL_TIMEOUT = 30  # seconds one getUpdates call waits for news
RETRY_SECONDS = 5  # after a network error
TYPING_SECONDS = 4  # "typing…" fades after ~5 s on the phone
# Messages that waited this long (Luna was off) are skipped, not run late.
STALE_SECONDS = 15 * 60
INBOX_DIR = "telegram"  # under the first workspace folder
ARGS_PREVIEW = 700  # characters of tool arguments shown on an approval card

APPROVE_WORDS = {"yes", "y", "approve", "approved", "ok", "okay", "go", "go ahead", "do it", "sure", "yes please", "👍"}
REJECT_WORDS = {"no", "n", "reject", "nope", "don't", "dont", "cancel", "👎"}

HELP = (
    "I'm Luna. Send me a message, a voice note, a photo or a file and I'll get on it.\n\n"
    "When I need your OK for something risky (sending mail, writing files, running commands) "
    "I'll ask with Approve / Reject buttons. You can also just reply \"yes\" or \"no\", or say "
    "what to do instead.\n\n"
    "/new  start a fresh conversation\n"
    "/stop  cancel what I'm doing\n"
    "/help  this message"
)


def _normal(text: str) -> str:
    return " ".join(text.lower().strip(" .!?,").split())


def reply_kind(text: str) -> str:
    """How a typed / spoken reply to an approval reads: approve, reject or other."""
    word = _normal(text)
    if word in APPROVE_WORDS:
        return "approve"
    if word in REJECT_WORDS:
        return "reject"
    return "other"


def answers_from_text(pending: dict[str, dict], text: str) -> dict[str, Any]:
    """Resume values for every pending pause from one text reply."""
    kind = reply_kind(text)
    answers = {}
    for pause_id, pause in pending.items():
        if pause["kind"] == "approval":
            if kind == "approve" and all("approve" in a["allowed"] for a in pause["actions"]):
                decision: dict = {"type": "approve"}
            elif kind == "approve" or kind == "reject":
                decision = {"type": "reject"}
            else:
                decision = {"type": "reject", "message": text}
            answers[pause_id] = build_answer(pause, {"decisions": [decision]})
        else:
            answers[pause_id] = build_answer(pause, {"answer": text})
    return answers


def describe_action(action: dict) -> str:
    """One line per tool call waiting for approval."""
    args = action.get("args") or {}
    shown = json.dumps(args, ensure_ascii=False, indent=1, default=str) if args else ""
    if len(shown) > ARGS_PREVIEW:
        shown = shown[: ARGS_PREVIEW - 1] + "…"
    return f"• {action['name']}" + (f"\n{shown}" if shown else "")


def pause_token(pending: dict[str, dict]) -> str:
    """A short, stable id for the current set of pauses (for button data).

    Pause ids live in the checkpoint, so buttons sent before a restart still
    match; buttons from an older, already answered pause don't.
    """
    return min(pending)[:16] if pending else ""


class Chat:
    """One Telegram chat: its thread, pending pauses and running task."""

    def __init__(self, chat_id: int, thread_id: str) -> None:
        self.chat_id = chat_id
        self.thread_id = thread_id
        self.pending: dict[str, dict] = {}  # pause id → describe_pause() output
        self.budget: TaskBudget | None = None
        self.task: asyncio.Task | None = None
        self.card: int | None = None  # message id of the approval card with buttons
        self.loaded = False  # pending pauses read from the checkpoint

    @property
    def busy(self) -> bool:
        return self.task is not None and not self.task.done()


class TelegramBridge:
    """Long-polls one bot and runs every allowed chat through the agent."""

    def __init__(self, host: AgentHost, api: TelegramAPI, state_path: Path | str) -> None:
        self.host = host
        self.api = api
        self.state_path = Path(state_path)
        self.offset: int | None = None
        self.threads: dict[str, str] = {}  # chat id (as text) → thread id
        self.chats: dict[int, Chat] = {}
        self._poller: asyncio.Task | None = None
        self._background: set[asyncio.Task] = set()
        self._load_state()

    @property
    def settings(self) -> Any:
        """The host's settings: allowed users and voice replies apply right away."""
        return self.host.settings

    # --- state file ----------------------------------------------------------

    def _load_state(self) -> None:
        try:
            data = json.loads(self.state_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return
        self.offset = data.get("offset") if isinstance(data.get("offset"), int) else None
        threads = data.get("threads")
        self.threads = {str(k): str(v) for k, v in threads.items()} if isinstance(threads, dict) else {}

    def _save_state(self) -> None:
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.state_path.with_name(self.state_path.name + ".tmp")
        tmp.write_text(json.dumps({"offset": self.offset, "threads": self.threads}, indent=2), encoding="utf-8")
        tmp.replace(self.state_path)

    # --- lifecycle -----------------------------------------------------------

    def start(self) -> None:
        """Start polling and listen for routine results."""
        self.host.listeners.add(self.on_host_event)
        self._poller = asyncio.create_task(self._poll(), name="luna-telegram")

    async def stop(self) -> None:
        """Stop polling and cancel every chat's run."""
        self.host.listeners.discard(self.on_host_event)
        tasks = [t for t in (self._poller, *self._background, *(c.task for c in self.chats.values())) if t]
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await self.api.aclose()

    def _spawn(self, coro: Any) -> asyncio.Task:
        task = asyncio.create_task(coro)
        self._background.add(task)
        task.add_done_callback(self._background.discard)
        return task

    async def _poll(self) -> None:
        while True:
            try:
                updates = await self.api.get_updates(self.offset, timeout=POLL_TIMEOUT)
            except asyncio.CancelledError:
                raise
            except TelegramError as exc:
                print(f"Telegram: {exc} (retrying in {RETRY_SECONDS} s)", file=sys.stderr)
                await asyncio.sleep(RETRY_SECONDS)
                continue
            for update in updates or []:
                self.offset = int(update["update_id"]) + 1
                self._save_state()  # before handling: a crash never repeats a command
                try:
                    await self.handle_update(update)
                except asyncio.CancelledError:
                    raise
                except Exception as exc:  # noqa: BLE001 — one bad update must not stop the bot
                    _LOGGER.exception("Telegram update failed: %s", exc)

    # --- sending -------------------------------------------------------------

    async def send(self, chat_id: int, text: str, buttons: list[list[dict]] | None = None) -> dict | None:
        """Send text (split at Telegram's limit); returns the last message. Never raises."""
        sent = None
        parts = split_text(text) or ["…"]
        for i, part in enumerate(parts):
            try:
                sent = await self.api.send_message(chat_id, part, buttons if i == len(parts) - 1 else None)
            except TelegramError as exc:
                print(f"Telegram: couldn't send a message ({exc})", file=sys.stderr)
                return None
        return sent

    async def _send_voice(self, chat_id: int, text: str) -> None:
        engine = self.host.tts
        if engine is None:
            return
        try:
            wav = await engine.asynthesize(text[:MAX_TEXT_CHARS])
            ogg = await asyncio.to_thread(wav_to_ogg_opus, wav)
            await self.api.send_voice(chat_id, ogg)
        except Exception as exc:  # noqa: BLE001 — the text reply was already sent
            print(f"Telegram: voice reply failed ({exc})", file=sys.stderr)

    async def _typing(self, chat_id: int) -> None:
        while True:
            try:
                await self.api.send_chat_action(chat_id)
            except TelegramError:
                pass
            await asyncio.sleep(TYPING_SECONDS)

    def on_host_event(self, event: dict) -> None:
        """AgentHost listener: forward routine results to the allowed users."""
        if event.get("type") != "routine_result" or not self.settings.telegram_routine_alerts:
            return
        routine, run = event.get("routine") or {}, event.get("run") or {}
        if not routine.get("notify", True):
            return
        mark = "⚠️" if run.get("status") == "error" else "⏰"
        text = f"{mark} {routine.get('name', 'Routine')}: {run.get('summary') or run.get('error') or 'done'}"
        for user_id in self.settings.telegram_allowed_users:
            self._spawn(self.send(user_id, text))  # private chat id = user id

    # --- chats ---------------------------------------------------------------

    def _config(self, chat: Chat) -> dict[str, Any]:
        return {"configurable": {"thread_id": chat.thread_id}, "recursion_limit": recursion_limit(self.settings)}

    def _set_pending(self, chat: Chat, interrupts: list[Interrupt]) -> None:
        chat.pending = {i.id: describe_pause(i) for i in interrupts}

    async def _chat(self, chat_id: int) -> Chat:
        """The chat's session; on first use, its thread and any pause still waiting."""
        chat = self.chats.get(chat_id)
        if chat is None:
            thread_id = self.threads.get(str(chat_id))
            if thread_id is None:
                thread_id = self.threads[str(chat_id)] = new_session_id()
                self._save_state()
            chat = self.chats[chat_id] = Chat(chat_id, thread_id)
        if not chat.loaded:
            chat.loaded = True
            agent = self.host.agent
            if agent.checkpointer is not None:
                state = await agent.aget_state(self._config(chat))
                self._set_pending(chat, list(state.interrupts))
                if chat.pending:
                    chat.budget = TaskBudget(limit=self.settings.task_budget)
        return chat

    def _new_thread(self, chat: Chat) -> None:
        chat.thread_id = self.threads[str(chat.chat_id)] = new_session_id()
        chat.pending, chat.budget, chat.card = {}, None, None
        self._save_state()

    # --- incoming ------------------------------------------------------------

    async def handle_update(self, update: dict) -> None:
        """React to one Telegram update (a message or a button press)."""
        if "callback_query" in update:
            return await self._on_button(update["callback_query"])
        msg = update.get("message")
        if not isinstance(msg, dict):
            return
        chat_id = (msg.get("chat") or {}).get("id")
        if (msg.get("chat") or {}).get("type") != "private" or chat_id is None:
            return  # groups and channels: never
        user_id = (msg.get("from") or {}).get("id")
        if user_id not in self.settings.telegram_allowed_users:
            await self.send(
                chat_id,
                f"Sorry, I only work for my owner.\nYour Telegram user id is {user_id}. "
                "To use me, add it to LUNA_TELEGRAM_ALLOWED_USERS (Control Center → General → Messaging).",
            )
            return
        if time.time() - msg.get("date", time.time()) > STALE_SECONDS:
            what = (msg.get("text") or msg.get("caption") or "a message")[:80]
            await self.send(chat_id, f"I was offline when you sent “{what}”. Send it again if you still need it.")
            return

        chat = await self._chat(chat_id)
        text = (msg.get("text") or "").strip()
        if text.startswith("/"):
            return await self._command(chat, text)
        if chat.busy:
            await self.send(chat_id, "Still working on your last message. /stop cancels it.")
            return
        chat.task = asyncio.create_task(self._process(chat, msg))

    async def _command(self, chat: Chat, text: str) -> None:
        command = text.split()[0].split("@")[0].lower()
        if command == "/stop":
            if chat.busy:
                chat.task.cancel()  # _run cleans up and says so
                return
            if chat.pending:
                await cancel_cleanup(self.host.agent, self._config(chat))
                await self._drop_card(chat)
                chat.pending, chat.budget = {}, None
                await self.send(chat.chat_id, "Cancelled.")
                return
            await self.send(chat.chat_id, "Nothing to stop.")
            return
        if command == "/new":
            if chat.busy:
                await self.send(chat.chat_id, "Finish or /stop the current task first.")
                return
            await self._drop_card(chat)
            self._new_thread(chat)
            await self.send(chat.chat_id, "Fresh start. What can I do for you?")
            return
        await self.send(chat.chat_id, HELP)  # /start, /help and anything unknown

    async def _on_button(self, query: dict) -> None:
        user_id = (query.get("from") or {}).get("id")
        message = query.get("message") or {}
        chat_id = (message.get("chat") or {}).get("id")
        if user_id not in self.settings.telegram_allowed_users or chat_id is None:
            await self._ack(query, "Not allowed.")
            return
        chat = await self._chat(chat_id)
        decision, _, token = str(query.get("data", "")).partition(":")
        if chat.busy or not chat.pending or token != pause_token(chat.pending):
            await self._ack(query, "That was already answered.")
            await self._clear(chat_id, message.get("message_id"))
            return
        if any(p["kind"] != "approval" for p in chat.pending.values()):
            await self._ack(query, "Reply with a message to answer my question too.")
            return
        await self._ack(query, "Approved" if decision == "approve" else "Rejected")
        try:
            answers = {
                pid: build_answer(p, {"decisions": [{"type": "approve" if decision == "approve" else "reject"}]})
                for pid, p in chat.pending.items()
            }
        except ValueError as exc:
            await self.send(chat_id, f"Can't do that: {exc}")
            return
        await self._drop_card(chat)
        chat.task = asyncio.create_task(self._run(chat, Command(resume=answers)))

    async def _ack(self, query: dict, text: str) -> None:
        try:
            await self.api.answer_callback(str(query.get("id")), text)
        except TelegramError:
            pass

    async def _clear(self, chat_id: int, message_id: int | None) -> None:
        if message_id is None:
            return
        try:
            await self.api.clear_buttons(chat_id, message_id)
        except TelegramError:
            pass  # already gone, or too old to edit

    async def _drop_card(self, chat: Chat) -> None:
        card, chat.card = chat.card, None
        await self._clear(chat.chat_id, card)

    async def _process(self, chat: Chat, msg: dict) -> None:
        """Turn one message into text / an image, then start or resume a run."""
        try:
            text, image, voice = await self._read(msg)
        except asyncio.CancelledError:
            await self.send(chat.chat_id, "Stopped.")  # /stop while downloading or transcribing
            return
        except (TelegramError, ValueError) as exc:
            await self.send(chat.chat_id, f"I couldn't read that: {exc}")
            return
        if not text and image is None:
            await self.send(chat.chat_id, "I can read text, voice notes, photos and files. Try one of those.")
            return

        if chat.pending:
            if not text:
                await self.send(chat.chat_id, "I'm waiting for your answer first (or /stop).")
                return
            try:
                answers = answers_from_text(chat.pending, text)
            except ValueError as exc:
                await self.send(chat.chat_id, f"Can't do that: {exc}")
                return
            await self._drop_card(chat)
            return await self._run(chat, Command(resume=answers), voice=voice)

        content: Any = text
        if image is not None:
            content = [{"type": "text", "text": text}, image]
        chat.budget = TaskBudget(limit=self.settings.task_budget)
        await self._run(chat, {"messages": [{"role": "user", "content": content}]}, voice=voice)

    async def _read(self, msg: dict) -> tuple[str, dict | None, bool]:
        """(text, image block for the model or None, came as a voice note)."""
        text = (msg.get("text") or msg.get("caption") or "").strip()
        notes: list[str] = []
        image = None

        audio = msg.get("voice") or msg.get("audio")
        if audio:
            heard = await self._transcribe(audio["file_id"])
            if not heard:
                raise ValueError("I couldn't make out any words in that voice note")
            await self.send(msg["chat"]["id"], f"🎙 “{heard}”")
            text = f"{text}\n{heard}".strip()
            if msg.get("voice"):
                return text, None, True

        if msg.get("photo"):
            size = pick_photo(msg["photo"])
            data = await self.api.download(size["file_id"])
            rel = self._save_upload(data, f"photo-{size.get('file_unique_id', 'x')}.jpg")
            notes.append(f"[The user sent a photo, saved in the workspace as {rel}]")
            if self.settings.model_vision:
                image = self._image_block(data, "image/jpeg")

        document = msg.get("document")
        if document:
            data = await self.api.download(document["file_id"])
            rel = self._save_upload(data, document.get("file_name") or "file")
            mime = document.get("mime_type") or "unknown type"
            notes.append(f"[The user sent a file ({mime}), saved in the workspace as {rel}]")
            if self.settings.model_vision and mime in {"image/jpeg", "image/png", "image/webp"}:
                image = self._image_block(data, mime)

        if notes:
            text = "\n".join([text, *notes]).strip()
        return text, image, False

    async def _transcribe(self, file_id: str) -> str:
        if self.host.stt is None:
            raise ValueError("voice notes need Whisper (set LUNA_STT_ENGINE=whisper)")
        data = await self.api.download(file_id)
        samples = await asyncio.to_thread(decode_audio, data)
        return (await self.host.stt.atranscribe(samples, prompt=None)).strip()

    def _save_upload(self, data: bytes, name: str) -> str:
        """Write an upload to <workspace>/telegram/; returns the workspace-relative path."""
        root = self.settings.workspace_dirs[0]
        folder = root / INBOX_DIR
        folder.mkdir(parents=True, exist_ok=True)
        path = folder / f"{datetime.now():%Y%m%d-%H%M%S}-{safe_filename(name)}"
        path.write_bytes(data)
        return path.relative_to(root).as_posix()

    @staticmethod
    def _image_block(data: bytes, mime: str) -> dict:
        url = f"data:{mime};base64,{base64.b64encode(data).decode('ascii')}"
        return {"type": "image_url", "image_url": {"url": url}}

    # --- runs ----------------------------------------------------------------

    async def _run(self, chat: Chat, payload: Any, voice: bool = False) -> None:
        """One run_task: collect the reply text, then send it and any pauses."""
        agent, config = self.host.agent, self._config(chat)  # fixed for this run
        translate = EventTranslator()
        reply: list[str] = []
        counts = {"model_calls": 0, "tool_calls": 0}

        def on_event(namespace: tuple[str, ...], mode: str, data: Any) -> None:
            if mode == "updates" and isinstance(data, dict) and "model" in data:
                counts["model_calls"] += 1
            for event in translate(namespace, mode, data):
                if event["type"] == "token":
                    reply.append(event["text"])
                elif event["type"] == "tool_call":
                    counts["tool_calls"] += 1

        typing = asyncio.create_task(self._typing(chat.chat_id))
        try:
            interrupts = await run_task(agent, payload, config, budget=chat.budget, on_event=on_event)
        except asyncio.CancelledError:
            typing.cancel()
            self.host.record_usage(runs=1, **counts)
            await cancel_cleanup(agent, config)
            chat.pending, chat.budget = {}, None
            await self.send(chat.chat_id, "Stopped.")
            return
        except Exception as exc:  # noqa: BLE001 — tell the user, keep the bot running
            typing.cancel()
            self.host.record_usage(runs=1, errors=1, **counts)
            chat.pending, chat.budget = {}, None
            await self.send(chat.chat_id, f"Something went wrong: {exc or type(exc).__name__}")
            return
        typing.cancel()
        self.host.record_usage(runs=1, **counts)

        text = "".join(reply).strip()
        if text:
            await self.send(chat.chat_id, text)
            if voice and self.settings.telegram_voice_replies:
                await self._send_voice(chat.chat_id, text)
        self._set_pending(chat, interrupts)
        if chat.pending:
            await self._send_pauses(chat)
        else:
            chat.budget = None
            if not text:
                await self.send(chat.chat_id, "Done.")
        self.host.broadcast_inbox()  # Luna may have suggested a memory

    async def _send_pauses(self, chat: Chat) -> None:
        actions = [a for p in chat.pending.values() if p["kind"] == "approval" for a in p["actions"]]
        for pause in chat.pending.values():
            if pause["kind"] == "question":
                await self.send(chat.chat_id, f"❓ {pause['question']}")
            elif pause["kind"] == "other":
                await self.send(chat.chat_id, f"⏸ {pause['text']}\n(Reply to continue.)")
        if not actions:
            return
        token = pause_token(chat.pending)
        buttons = [{"text": "✅ Approve", "callback_data": f"approve:{token}"}]
        if not all("approve" in a["allowed"] for a in actions):
            buttons = []
        buttons.append({"text": "❌ Reject", "callback_data": f"reject:{token}"})
        lines = "\n".join(describe_action(a) for a in actions)
        sent = await self.send(
            chat.chat_id,
            f"I need your OK for:\n{lines}\n\nTap a button, or reply \"yes\", \"no\" or what to do instead.",
            [buttons],
        )
        chat.card = (sent or {}).get("message_id")


def start_telegram(host: AgentHost, state_path: Path | str) -> TelegramBridge | None:
    """Start the bot if LUNA_TELEGRAM_BOT_TOKEN is set (called by luna-web)."""
    token = host.settings.telegram_bot_token
    if not token:
        return None
    if not host.settings.telegram_allowed_users:
        print(
            "Telegram: no LUNA_TELEGRAM_ALLOWED_USERS yet; message the bot to get your user id.",
            file=sys.stderr,
        )
    bridge = TelegramBridge(host, TelegramAPI(token), state_path)
    bridge.start()
    return bridge


__all__ = [
    "Chat",
    "TelegramBridge",
    "answers_from_text",
    "describe_action",
    "pause_token",
    "reply_kind",
    "start_telegram",
]
