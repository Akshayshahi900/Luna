# Configuration reference

Every setting is a field on `Settings` in `src/luna/config/settings.py`.
Set it as an environment variable with the `LUNA_` prefix, or put the same
line in `.env` at the project root (found from any working directory).
Start from `.env.example`. Restart `luna` / `luna-web` after a change.

Lists (`LUNA_WORKSPACE_DIRS`, `LUNA_AUTO_APPROVE`, `LUNA_WEB_ALLOWED_ORIGINS`)
are comma-separated. Relative paths are relative to the project root.

## Model provider

All three providers speak the OpenAI API (`src/luna/agent/providers.py`).
The web UI can switch provider and model live (**M**).

| Variable | Default | What it does |
| --- | --- | --- |
| `LUNA_PROVIDER` | `openrouter` | Startup provider: `openrouter`, `groq` or `ollama` |
| `LUNA_MODEL_NAME` | `nvidia/nemotron-3-ultra-550b-a55b` | OpenRouter model slug |
| `LUNA_OPENROUTER_API_KEY` | — | OpenRouter key (<https://openrouter.ai/keys>) |
| `LUNA_GROQ_API_KEY` | — | Groq key (<https://console.groq.com/keys>) |
| `LUNA_GROQ_MODEL` | `llama-3.3-70b-versatile` | Groq model id |
| `LUNA_OLLAMA_BASE_URL` | `http://localhost:11434/v1` | Ollama's OpenAI-compatible URL |
| `LUNA_OLLAMA_MODEL` | `qwen3:8b` | Ollama model tag (must support tool calling) |
| `LUNA_MODEL_MAX_RETRIES` | `1` | Retries for a failed request; each is another API call |
| `LUNA_SYSTEM_PROMPT` | (built-in) | Luna's base role; persona settings are added to it |

## Persona

See [`personalization.md`](personalization.md) for examples.

| Variable | Default | What it does |
| --- | --- | --- |
| `LUNA_RESPONSE_STYLE` | `concise` | `concise` (one or two spoken sentences) or `detailed` |
| `LUNA_USER_TITLE` | `Sir` | How Luna addresses you; empty = not used |
| `LUNA_USER_NAME` | — | Your name |
| `LUNA_USER_LOCATION` | — | Default place for weather / local questions |
| `LUNA_UNITS` | `metric` | `metric` or `imperial` |
| `LUNA_TIMEZONE` | — | IANA timezone, e.g. `Europe/London` |
| `LUNA_PERSONA_PATH` | `config/persona.md` | Optional Markdown file of extra instructions |

## Loop limits and cost

Kept low on purpose: every model call is one API request (DECISIONS.md D25).

| Variable | Default | What it does |
| --- | --- | --- |
| `LUNA_MAX_MODEL_CALLS` | `10` | Main-agent model calls per message; the run then ends politely |
| `LUNA_MAX_TOOL_CALLS` | `20` | Tool calls per message; extra calls are refused |
| `LUNA_TASK_BUDGET` | `30` | Model calls per message across the main agent **and** all helpers |

## Conversation memory (short-term)

| Variable | Default | What it does |
| --- | --- | --- |
| `LUNA_MEMORY_BACKEND` | `sqlite` | `sqlite` (saved to disk) or `memory` (lost on exit) |
| `LUNA_CHECKPOINT_PATH` | `data/luna_memory.sqlite` | Thread checkpoints |
| `LUNA_SUMMARY_TRIGGER_TOKENS` | `12000` | Summarize old messages past this size; `0` = never |
| `LUNA_SUMMARY_KEEP_TOKENS` | `4000` | Recent history kept word-for-word after a summary |

## Long-term memory

See [`memory.md`](memory.md).

| Variable | Default | What it does |
| --- | --- | --- |
| `LUNA_ENABLE_LONGTERM_MEMORY` | `true` | Remember facts across threads (you approve every change) |
| `LUNA_LONGTERM_MEMORY_PATH` | `data/luna_longterm.sqlite` | Long-term memory database |
| `LUNA_MEMORY_RECALL_LIMIT` | `5` | Keyword matches shown to Luna per message, besides pinned ones |
| `LUNA_MEMORY_PROMPT_CHARS` | `1500` | Max characters of memories in the system prompt |
| `LUNA_MEMORY_MAX_SUGGESTIONS` | `3` | Max memory suggestions per message |

## Tools, helpers and approval

| Variable | Default | What it does |
| --- | --- | --- |
| `LUNA_ENABLE_BUILTIN_TOOLS` | `true` | Load `calculator`, `get_current_time`, `ask_user` |
| `LUNA_ENABLE_MCP_TOOLS` | `true` | Connect the servers in the MCP config |
| `LUNA_MCP_CONFIG_PATH` | `config/mcp_servers.json` | MCP server list |
| `LUNA_TAVILY_API_KEY` | — | Enables the researcher helper (<https://app.tavily.com>) |
| `LUNA_WORKSPACE_DIRS` | `workspace` | Folders the files and coder helpers may touch |
| `LUNA_AUTO_APPROVE` | (empty) | Tool names that run **without** asking, e.g. `write_file` |

## Mail, Google and to-dos

Read by the MCP servers themselves. Details: [`mail.md`](mail.md),
[`google.md`](google.md).

| Variable | Default | What it does |
| --- | --- | --- |
| `LUNA_TASKS_PATH` | `data/tasks.json` | Local to-do file |
| `LUNA_MAIL_BACKEND` | `gmail` | `gmail` (Gmail API) or `imap` (IMAP/SMTP) |
| `LUNA_MAIL_ADDRESS` | — | Your address (IMAP backend / sender) |
| `LUNA_MAIL_PASSWORD` | — | App password (IMAP backend) |
| `LUNA_MAIL_USERNAME` | — | Login, if different from the address |
| `LUNA_MAIL_IMAP_HOST` / `_PORT` | `imap.gmail.com` / `993` | IMAP server |
| `LUNA_MAIL_SMTP_HOST` / `_PORT` | `smtp.gmail.com` / `465` | SMTP server (465 = SSL, else STARTTLS) |
| `LUNA_MAIL_MAX_BODY_CHARS` | `4000` | Longer bodies are cut before the model sees them |
| `LUNA_GOOGLE_CREDENTIALS_PATH` | `data/google/credentials.json` | OAuth "Desktop app" client file |
| `LUNA_GOOGLE_TOKEN_PATH` | `data/google/token.json` | Saved sign-in (`uv run luna-google-auth`) |
| `LUNA_GOOGLE_CALENDAR_ID` | `primary` | Calendar the assistant uses |
| `LUNA_GOOGLE_TASKLIST_ID` | `@default` | Google Tasks list synced with the local to-dos |
| `LUNA_TASKS_GOOGLE_SYNC` | `true` | Two-way to-do sync when signed in |

## Web UI and voice

See [`web-ui.md`](web-ui.md).

| Variable | Default | What it does |
| --- | --- | --- |
| `LUNA_WEB_HOST` | `127.0.0.1` | Listen address. Keep it local: the agent can run commands |
| `LUNA_WEB_PORT` | `8765` | Port |
| `LUNA_WEB_ALLOWED_ORIGINS` | Vite dev server | Extra origins allowed to open the WebSocket |
| `LUNA_WEB_OPEN_WINDOW` | `true` | Open Luna in its own app window on start (`--no-window` skips it once) |
| `LUNA_WEB_CLOSE_WITH_WINDOW` | `true` | Stop luna-web when that window closes |
| `LUNA_WEB_BROWSER` | first found | Chrome / Chromium / Edge / Brave command or path for the window |
| `LUNA_STT_ENGINE` | `whisper` | `whisper` (local, wake word) or `browser` |
| `LUNA_STT_MODEL` | `base.en` | `tiny.en`, `base.en` or `small.en` |
| `LUNA_STT_MODELS_DIR` | `data/models/whisper` | Whisper model cache |
| `LUNA_STT_THREADS` | `4` | CPU threads for Whisper |
| `LUNA_TTS_ENGINE` | `piper` | `piper` (local voice) or `browser` |
| `LUNA_TTS_VOICE` | `en_US-lessac-medium` | Piper voice name |
| `LUNA_TTS_VOICES_DIR` | `data/voices` | Piper voice cache |
| `LUNA_TTS_LENGTH_SCALE` | `0.95` | Speaking pace: < 1 faster, > 1 slower |

## Routines

Scheduled jobs that run inside `luna-web` ([`control-center.md`](control-center.md#routines)).

| Variable | Default | What it does |
| --- | --- | --- |
| `LUNA_ROUTINES_ENABLED` | `true` | Run scheduled routines while luna-web runs |
| `LUNA_ROUTINES_PATH` | `data/luna_routines.sqlite` | Routines, their runs and API usage counters |

## Messaging (Telegram)

Use Luna from your phone ([`messaging.md`](messaging.md)). The bot runs inside `luna-web`.

| Variable | Default | What it does |
| --- | --- | --- |
| `LUNA_TELEGRAM_BOT_TOKEN` | unset (off) | Bot token from @BotFather (restart to apply) |
| `LUNA_TELEGRAM_ALLOWED_USERS` | empty | Comma-separated Telegram user ids allowed to use the bot |
| `LUNA_TELEGRAM_VOICE_REPLIES` | `true` | Answer voice notes with a voice note (Piper) |
| `LUNA_TELEGRAM_ROUTINE_ALERTS` | `true` | Send routine results with notifications on to the allowed users |
| `LUNA_MODEL_VISION` | `false` | The model can see images: Telegram photos go to it as images |

Every setting on this page can also be changed in the web UI's Control
Center, which writes `.env` in place (comments kept) and says whether a
change applies at once or after a restart.

## What lives where

| Path | Contents | In git? |
| --- | --- | --- |
| `.env` | your keys and overrides | no |
| `config/mcp_servers.json` | MCP servers | yes |
| `config/persona.md` | personal instructions | no |
| `data/` | checkpoints, long-term memory, to-dos, Google token, voice models, routines, `dashboard.json` (HUD widget preferences), `app-window/` (the app window's browser profile), `telegram.json` (bot update offset, chat → thread) | no |
| `workspace/` | default sandbox for the files / coder helpers; `workspace/telegram/` holds photos and files sent over Telegram | no |
