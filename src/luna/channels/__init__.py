"""
Chat-app channels: use Luna from your phone.

BEGINNER MAP
------------
  - telegram.py      TelegramBridge: one private chat = one session (like a
                     browser tab): text, voice notes, photos, files, approvals
  - telegram_api.py  the few Bot API calls it needs, over httpx (long polling)
  - media.py         voice note ⇄ Whisper / Piper audio, photo sizes, long text

The bridge runs inside luna-web (started in web/server.py when
LUNA_TELEGRAM_BOT_TOKEN is set). Setup: docs/messaging.md.
"""

from luna.channels.telegram import TelegramBridge, start_telegram

__all__ = ["TelegramBridge", "start_telegram"]
