# Spec 11 — Messaging: control Luna from Telegram

**Date:** 2026-10-18  
**Status:** Implemented (Telegram). WhatsApp: planned (§6).  
**Scope:** Talk to Luna from your phone. Send text, voice notes, photos
and files, and get text and voice replies. Approve or reject her risky
actions and answer her questions from the chat. Get routine results as
messages.

Decision: [`DECISIONS.md`](../DECISIONS.md) D39. User guide: [`docs/messaging.md`](../docs/messaging.md).

---

## 1. Goal

- Everything you can do in the web UI by voice, you can do from your
  phone, away from the computer.
- No new trust boundary: the same approvals (D9) and the same
  auto-approve list. Nobody except allow-listed users reaches the agent.
- No public server: works from a laptop behind NAT.

## 2. Shape

```
src/luna/channels/
  telegram.py       TelegramBridge, Chat, start_telegram
                    reply_kind / answers_from_text (text → pause answers),
                    describe_action, pause_token (button data)
  telegram_api.py   TelegramAPI: getUpdates, sendMessage (+ inline keyboard),
                    sendVoice, sendChatAction, answerCallbackQuery,
                    editMessageReplyMarkup, getFile + download; TelegramError
  media.py          decode_audio, wav_to_ogg_opus, pick_photo, split_text, safe_filename
web/server.py       lifespan: host.telegram = start_telegram(host, data/telegram.json); stop on exit
config/settings.py  LUNA_TELEGRAM_BOT_TOKEN, _ALLOWED_USERS, _VOICE_REPLIES,
                    _ROUTINE_ALERTS, LUNA_MODEL_VISION
config/schema.py    "messaging" group (Control Center → General → Messaging);
                    the token is a secret, applied on restart; the rest are live
```

Flow of one message:

```
getUpdates ─▶ offset saved ─▶ handle_update
   ├─ callback_query (button) ─▶ token matches pending? ─▶ Command(resume) ─▶ _run
   └─ message ─▶ private? allowed user? fresh (< 15 min)? ─▶ /command? ─▶ busy?
          └─ _process: _read (voice → Whisper + echo, photo/file → workspace,
                       photo → image block if vision) ─▶ pending? answer : new task
                 └─ _run: run_task (TaskBudget, typing…) ─▶ reply text
                          (+ voice note) ─▶ pauses → question / approval card
```

## 3. Rules

1. Only `message` and `callback_query` updates. Only private chats. Only
   `from.id` in `LUNA_TELEGRAM_ALLOWED_USERS` (read live). Anyone else
   gets their user id and nothing else.
2. The offset is saved before handling an update.
3. One run per chat at a time. A message while busy gets "Still working…
   /stop cancels it."
4. A pending pause: buttons decide all approvals together. Text or voice
   answers all questions. For approvals, "yes"-words approve, "no"-words
   reject, and anything else rejects with that text as the message.
   Buttons are refused while a question is also pending.
5. Button `callback_data` = `approve|reject:<first 16 chars of the
   smallest pending pause id>`. A mismatch means "already answered".
6. Cancel (`/stop`) and errors leave the thread valid (`cancel_cleanup`).
7. Plain text only (no parse mode), split at 4096 characters.
8. Voice notes ≤ 5 minutes. Uploads ≤ 20 MB (the Bot API limit).
   Uploads are saved under `<first workspace dir>/telegram/` with
   cleaned-up file names.
9. Images go to the model only with `LUNA_MODEL_VISION=true`.
10. Messages older than 15 minutes aren't run.
11. The bot token never appears in logs or replies.
12. Usage counts (`host.record_usage`) and the memory inbox broadcast work
    as they do for a tab.

## 4. Tests (`tests/test_telegram.py`, offline)

- media: WAV → Opus → 16 kHz samples round trip; garbage and over-long
  audio refused; `split_text` limits and breaks; `pick_photo`;
  `safe_filename` strips paths.
- pause replies: approve / reject words; reject with reason; questions;
  the pause token.
- settings: token secret and restart-only; allowed users and vision live;
  comma-separated ids.
- API client (httpx MockTransport): download path, reply_markup JSON,
  `ok=false` errors, token scrubbed from network errors.
- conversations (fake Telegram, fake models): strangers and groups
  refused; text reply on a saved thread with usage counted; stale
  messages skipped; approval by button (and a second press refused);
  rejection with a reason that the model sees; question answered by the
  next message; a pending approval surviving a restart; voice note →
  echo + reply + OGG voice note; voice note without Whisper; photo saved
  and shown to a vision model; file path given without vision; `/start`
  `/stop` `/new`; `/stop` abandoning an approval; routine alerts (with
  and without notify).

## 5. Later

- Stream long replies by editing one message every few seconds.
- An "Edit" decision via a reply template (`edit: {...}`).
- Show memory suggestions in the chat, with accept / decline buttons.

## 6. WhatsApp (planned)

The WhatsApp Cloud API (Meta) delivers messages only to an HTTPS webhook,
so it needs a tunnel (e.g. Cloudflare Tunnel) or a small relay, plus a
Meta business app and a verified number. Plan: `channels/whatsapp.py`
with the same Chat / `_run` flow. Before then, move the transport-neutral
parts of `TelegramBridge` (Chat, `_run`, pause replies) into a shared
base: send text, send voice, buttons → WhatsApp "reply buttons" (max 3),
download media by id. Verify the webhook with the app secret
(`X-Hub-Signature-256`). Unofficial WhatsApp Web clients are out (terms of
service).
