"""
A small async client for the Telegram Bot API (https://core.telegram.org/bots/api).

BEGINNER MAP
------------
Only the calls Luna's bot needs, over httpx (already installed with
langchain-openai), so there is no bot framework to learn:

  get_updates       long polling: waits up to ``timeout`` s for new messages
  send_message      text, optionally with inline buttons (approve / reject)
  send_voice        an OGG/Opus voice message
  send_chat_action  "typing…" while Luna works
  answer_callback   acknowledge a button press
  clear_buttons     remove the buttons once a pause is answered
  download          a file the user sent (voice note, photo, document)

Long polling means Luna asks Telegram for messages; Telegram never connects
to your machine, so no public URL, port forwarding or webhook is needed.

SECURITY: the bot token is part of every URL. httpx puts URLs into its error
messages, so every error here is re-raised as TelegramError with the token
replaced by "<token>", which keeps it out of logs and chat replies.
"""

from __future__ import annotations

import json
from typing import Any

import httpx

API_BASE = "https://api.telegram.org"
# The Bot API refuses downloads above 20 MB anyway.
MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024


class TelegramError(RuntimeError):
    """A failed Bot API call (network error or ok=false), token removed."""


class TelegramAPI:
    """Bot API calls for one bot token."""

    def __init__(self, token: str, client: httpx.AsyncClient | None = None, base: str = API_BASE) -> None:
        self._token = token
        self._base = base.rstrip("/")
        self._client = client or httpx.AsyncClient(timeout=httpx.Timeout(20.0))
        self._own_client = client is None

    def _hide(self, text: str) -> str:
        return text.replace(self._token, "<token>") if self._token else text

    async def call(
        self, method: str, params: dict[str, Any] | None = None, files: dict[str, Any] | None = None,
        timeout: float | None = None,
    ) -> Any:
        """POST one method; returns its ``result``. Raises TelegramError."""
        url = f"{self._base}/bot{self._token}/{method}"
        params = {k: v for k, v in (params or {}).items() if v is not None}
        extra = {"timeout": timeout} if timeout is not None else {}
        try:
            if files:
                # multipart: nested values (reply_markup) must be JSON text
                data = {k: v if isinstance(v, str) else json.dumps(v) for k, v in params.items()}
                response = await self._client.post(url, data=data, files=files, **extra)
            else:
                response = await self._client.post(url, json=params, **extra)
            body = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise TelegramError(self._hide(f"{method} failed: {exc}")) from None
        if not body.get("ok"):
            raise TelegramError(self._hide(f"{method}: {body.get('description', 'unknown error')}"))
        return body.get("result")

    async def get_updates(self, offset: int | None, timeout: int = 30) -> list[dict[str, Any]]:
        """New updates after ``offset`` (waits up to ``timeout`` seconds)."""
        return await self.call(
            "getUpdates",
            {"offset": offset, "timeout": timeout, "allowed_updates": ["message", "callback_query"]},
            timeout=timeout + 10,
        )

    async def send_message(self, chat_id: int, text: str, buttons: list[list[dict]] | None = None) -> dict:
        """Plain text (no Markdown: model output would break its escaping)."""
        markup = {"inline_keyboard": buttons} if buttons else None
        return await self.call("sendMessage", {"chat_id": chat_id, "text": text, "reply_markup": markup})

    async def send_voice(self, chat_id: int, ogg: bytes) -> dict:
        """An OGG/Opus voice message."""
        return await self.call(
            "sendVoice", {"chat_id": chat_id}, files={"voice": ("luna.ogg", ogg, "audio/ogg")}, timeout=60
        )

    async def send_chat_action(self, chat_id: int, action: str = "typing") -> None:
        """Show "typing…" (lasts ~5 s on the phone)."""
        await self.call("sendChatAction", {"chat_id": chat_id, "action": action})

    async def answer_callback(self, callback_id: str, text: str | None = None) -> None:
        """Stop the button's spinner, optionally with a short toast."""
        await self.call("answerCallbackQuery", {"callback_query_id": callback_id, "text": text})

    async def clear_buttons(self, chat_id: int, message_id: int) -> None:
        """Remove the inline buttons from a message."""
        await self.call(
            "editMessageReplyMarkup",
            {"chat_id": chat_id, "message_id": message_id, "reply_markup": {"inline_keyboard": []}},
        )

    async def download(self, file_id: str, max_bytes: int = MAX_DOWNLOAD_BYTES) -> bytes:
        """The bytes of a file the user sent. Raises TelegramError."""
        info = await self.call("getFile", {"file_id": file_id})
        if (info.get("file_size") or 0) > max_bytes:
            raise TelegramError(f"file is larger than {max_bytes // (1024 * 1024)} MB")
        path = info.get("file_path")
        if not path:
            raise TelegramError("Telegram gave no download path for that file")
        try:
            response = await self._client.get(f"{self._base}/file/bot{self._token}/{path}", timeout=60)
            response.raise_for_status()
        except httpx.HTTPError as exc:
            raise TelegramError(self._hide(f"download failed: {exc}")) from None
        if len(response.content) > max_bytes:
            raise TelegramError(f"file is larger than {max_bytes // (1024 * 1024)} MB")
        return response.content

    async def aclose(self) -> None:
        """Close the HTTP client (if this object created it)."""
        if self._own_client:
            await self._client.aclose()


__all__ = ["API_BASE", "MAX_DOWNLOAD_BYTES", "TelegramAPI", "TelegramError"]
