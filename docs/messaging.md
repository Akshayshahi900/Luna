# Messaging: use Luna from Telegram

Message Luna from your phone the way you'd talk to her in the web UI. You
can send text, **voice notes**, **photos** and **files**, and approve her
risky actions with a tap. The bot runs inside `luna-web`, on the same
agent, memory and tools, so your computer has to be on with Luna running.

Design: [`spec/spec11.md`](../spec/spec11.md) · decision D39 in
[`DECISIONS.md`](../DECISIONS.md) · code in `src/luna/channels/`.

## Set up (5 minutes)

1. In Telegram, open **@BotFather**, send `/newbot` and follow the steps.
   It gives you a token like `123456789:AA…`.
2. Put the token in `.env`, or in Control Center → **General → Messaging**:

   ```bash
   LUNA_TELEGRAM_BOT_TOKEN=123456789:AA...
   ```

3. Restart `luna-web` (the token is read at startup). To keep it running
   without a window, for example on a home server, use
   `uv run luna-web --no-window`.
4. Send your bot any message. It replies with **your Telegram user id**.
   Add the id to the allow-list. This one applies straight away, no
   restart needed:

   ```bash
   LUNA_TELEGRAM_ALLOWED_USERS=123456789
   ```

5. Message the bot again and Luna answers.

The bot uses **long polling**: Luna asks Telegram for new messages, and
Telegram never connects to your machine. You don't need a public URL,
port forwarding or a webhook, and it works behind home routers and
university networks.

## What you can send

| You send | What happens |
| --- | --- |
| Text | A normal request, like typing it in the web UI |
| Voice note | Transcribed locally by Whisper. Luna first echoes what she heard (🎙 "…"), then answers in text **and** with a voice note (Piper) |
| Photo | Saved to `workspace/telegram/`. With `LUNA_MODEL_VISION=true` the model also *sees* it; otherwise Luna only gets the file path |
| File / document | Saved to `workspace/telegram/` and the path is given to Luna, so the files and coder helpers can work with it |
| Caption | Becomes the request that goes with the photo or file |

Commands: `/new` starts a fresh conversation, `/stop` cancels the current
task (or a waiting approval), and `/help` shows help.

Each chat keeps **one conversation** across restarts until you send
`/new`. It also shows up in the web UI's SESSIONS list, so you can carry
on at your desk.

## Approvals and questions

Risky actions still need you (D9). Luna sends a card showing the tool
and its arguments, with **✅ Approve** and **❌ Reject** buttons. You can
also reply in text or by voice:

| Reply | Result |
| --- | --- |
| "yes", "ok", "go ahead", "do it", 👍 | approve |
| "no", "reject", "cancel", 👎 | reject |
| anything else, e.g. "no, send it to Priya instead" | reject **with that reason**, so Luna can try again your way |

If Luna asked a question (`ask_user`), your next message is the answer.
A waiting approval survives a restart, and the old buttons still work.
Tools listed in `LUNA_AUTO_APPROVE` never ask, here or anywhere else.

## Routine alerts

Routines that have notifications turned on (Control Center → Routines)
also send their result to you on Telegram. Examples: "⏰ Mail check: 2 new
emails", or "⚠️" when a run failed. Turn this off with
`LUNA_TELEGRAM_ROUTINE_ALERTS=false`.

## Settings

| Variable | Default | When it applies | What it does |
| --- | --- | --- | --- |
| `LUNA_TELEGRAM_BOT_TOKEN` | unset (off) | restart | Bot token from @BotFather |
| `LUNA_TELEGRAM_ALLOWED_USERS` | empty (nobody) | live | Comma-separated Telegram user ids allowed to use the bot |
| `LUNA_TELEGRAM_VOICE_REPLIES` | `true` | live | Answer a voice note with a voice note (needs `LUNA_TTS_ENGINE=piper`) |
| `LUNA_TELEGRAM_ROUTINE_ALERTS` | `true` | live | Send routine results to the allowed users |
| `LUNA_MODEL_VISION` | `false` | live | Send photos to the model as images. Only turn it on for a model that accepts images |

Voice notes need `LUNA_STT_ENGINE=whisper` (the default). They can be up
to 5 minutes long.

## Security

- **Only allow-listed users.** Every other user is refused. They only
  learn their own id, and no message of theirs reaches the agent. Group
  chats are ignored entirely.
- **Treat the bot token like a password.** Anyone who has it can read
  what your bot receives. It's stored as a secret (masked in the Control
  Center) and never printed: Bot API errors have it replaced by
  `<token>`. If it leaks, send `/revoke` to @BotFather.
- **Your Telegram account becomes a remote control.** Whoever holds your
  unlocked phone can approve Luna's actions. Keep `LUNA_AUTO_APPROVE`
  short.
- **Messages go through Telegram's servers** (normal cloud chats, not
  end-to-end encrypted). Speech recognition and speech output stay on
  your machine. The model provider sees what it always sees.
- **Messages sent while Luna was off** for more than 15 minutes are not
  run late. Luna tells you and asks you to resend.
- Uploads are saved with cleaned-up file names inside the workspace and
  never outside it. The Bot API caps them at 20 MB.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| No reply at all | Is `luna-web` running? Is the token right? The terminal prints `Telegram: …` errors |
| "Sorry, I only work for my owner" | Add the id it shows to `LUNA_TELEGRAM_ALLOWED_USERS` |
| "voice notes need Whisper" | Set `LUNA_STT_ENGINE=whisper` and restart |
| No voice replies | Needs Piper (`LUNA_TTS_ENGINE=piper`) and `LUNA_TELEGRAM_VOICE_REPLIES=true` |
| Error after sending a photo | Your model can't read images: set `LUNA_MODEL_VISION=false` |
| Two Luna instances, one token | Telegram serves updates to one poller only. Run one `luna-web` per bot |

## WhatsApp?

Not built yet. WhatsApp's official route (the Meta Cloud API) needs a
Meta business account, a verified phone number and a **public HTTPS
webhook**, so it doesn't fit a local-first assistant without a tunnel.
The unofficial WhatsApp Web libraries break WhatsApp's terms of service
and can get the number banned. The channel code is laid out so a
WhatsApp bridge can be added next to `telegram.py` later (see spec11 §6).
