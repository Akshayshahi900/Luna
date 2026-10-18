"""
Luna settings — one place for all configuration knobs.

BEGINNER MAP
------------
Hard-coding a model name in ten files is painful to change.
Instead, Settings holds defaults, and you can override them with
environment variables that start with LUNA_:

  export LUNA_MODEL_NAME=nvidia/nemotron-3-ultra-550b-a55b
  export LUNA_OPENROUTER_API_KEY=sk-or-...
  export LUNA_MEMORY_BACKEND=memory
  export LUNA_ENABLE_MCP_TOOLS=false

Or put the same keys in a `.env` file in the project root
(it is found no matter which directory you run `luna` from).
See env.example for a full list.

get_settings() is cached (lru_cache): the first call reads env/defaults;
later calls reuse the same object for speed.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from typing import Annotated

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

# This file lives at: src/luna/config/settings.py
# parents[0]=config, [1]=luna, [2]=src, [3]=project root (Luna/)
PROJECT_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_MCP_CONFIG = PROJECT_ROOT / "config" / "mcp_servers.json"
DEFAULT_CHECKPOINT_PATH = PROJECT_ROOT / "data" / "luna_memory.sqlite"
DEFAULT_LONGTERM_PATH = PROJECT_ROOT / "data" / "luna_longterm.sqlite"
DEFAULT_WORKSPACE = PROJECT_ROOT / "workspace"
DEFAULT_VOICES_DIR = PROJECT_ROOT / "data" / "voices"
DEFAULT_STT_DIR = PROJECT_ROOT / "data" / "models" / "whisper"
DEFAULT_PERSONA_PATH = PROJECT_ROOT / "config" / "persona.md"
DEFAULT_GOOGLE_DIR = PROJECT_ROOT / "data" / "google"
DEFAULT_ROUTINES_PATH = PROJECT_ROOT / "data" / "luna_routines.sqlite"
DEFAULT_DASHBOARD_PATH = PROJECT_ROOT / "data" / "dashboard.json"
DEFAULT_ENV_PATH = PROJECT_ROOT / ".env"
DEFAULT_TELEGRAM_STATE_PATH = PROJECT_ROOT / "data" / "telegram.json"


class Settings(BaseSettings):
    """All runtime options for the chatbot.

    Field names map to env vars automatically:
      model_name  →  LUNA_MODEL_NAME
      memory_backend → LUNA_MEMORY_BACKEND
      ...
    """

    model_config = SettingsConfigDict(
        env_prefix="LUNA_",
        # Absolute path so `luna` works from any working directory.
        env_file=DEFAULT_ENV_PATH,
        env_file_encoding="utf-8",
        extra="ignore",  # ignore unknown env vars instead of crashing
    )

    # --- LLM (the brain) ---
    # Which API serves the model at startup; the web UI can switch later.
    # All three speak the OpenAI API (see luna/agent/providers.py).
    provider: str = Field(
        default="openrouter",
        description="'openrouter', 'groq' or 'ollama'",
    )
    model_name: str = Field(
        default="nvidia/nemotron-3-ultra-550b-a55b",
        description="OpenRouter model slug",
    )
    # Loaded from LUNA_OPENROUTER_API_KEY in the project-root .env file.
    openrouter_api_key: str | None = Field(default=None, repr=False)
    # Groq (https://console.groq.com/keys)
    groq_api_key: str | None = Field(default=None, repr=False)
    groq_model: str = Field(default="llama-3.3-70b-versatile", description="Groq model id")
    # Ollama (local, no key). Its OpenAI-compatible endpoint ends in /v1.
    ollama_base_url: str = Field(default="http://localhost:11434/v1", description="Ollama /v1 URL")
    ollama_model: str = Field(default="qwen3:8b", description="Ollama model tag (must support tools)")

    model_max_retries: int = Field(
        default=1,
        description=(
            "How often a failed model request (rate limit, network) is retried. "
            "Each retry is another API request."
        ),
    )
    model_vision: bool = Field(
        default=False,
        description=(
            "The model can see images: photos sent over Telegram go to it as images. "
            "Off = they are only saved to the workspace"
        ),
    )

    @field_validator("provider")
    @classmethod
    def _known_provider(cls, value: str) -> str:
        value = value.strip().lower()
        if value not in {"openrouter", "groq", "ollama"}:
            raise ValueError("provider must be 'openrouter', 'groq' or 'ollama'")
        return value
    system_prompt: str = Field(
        default=(
            "You are Luna, a helpful assistant. "
            "Use tools when they help you answer accurately, "
            "and remember prior turns in this conversation. "
            "Every model call costs an API request, so be economical: answer "
            "directly from what you know when you can, and when you need several "
            "independent tools, call them all in the same step. "
            "Do quick things yourself; hand bigger self-contained jobs to your "
            "ask_* helper tools, giving them every detail they need in one call. "
            "Ask the user only when you truly cannot proceed without them."
        ),
        description=(
            "Luna's role. The persona settings below are added to it "
            "(see luna/agent/persona.py)"
        ),
    )

    # --- Persona (how Luna talks, who she talks to; see luna/agent/persona.py) ---
    response_style: str = Field(
        default="concise",
        description="'concise' (one or two spoken sentences) or 'detailed'",
    )
    user_title: str = Field(
        default="Sir",
        description="How Luna addresses you, e.g. 'Sir', 'Ma'am', 'Boss'. Empty = not used",
    )
    user_name: str | None = Field(default=None, description="Your name (optional)")
    user_location: str | None = Field(
        default=None,
        description="Default place for weather / local questions, e.g. 'Agra, India'",
    )
    units: str = Field(default="metric", description="'metric' or 'imperial'")
    timezone: str | None = Field(
        default=None,
        description="Your IANA timezone, e.g. 'Asia/Kolkata' (used for the local time)",
    )
    persona_path: Path | None = Field(
        default=DEFAULT_PERSONA_PATH,
        description="Optional Markdown file with extra instructions for Luna",
    )

    @field_validator("response_style")
    @classmethod
    def _known_style(cls, value: str) -> str:
        value = value.strip().lower()
        if value not in {"concise", "detailed"}:
            raise ValueError("response_style must be 'concise' or 'detailed'")
        return value

    @field_validator("mail_backend")
    @classmethod
    def _known_mail_backend(cls, value: str) -> str:
        value = value.strip().lower()
        if value not in {"gmail", "imap"}:
            raise ValueError("mail_backend must be 'gmail' or 'imap'")
        return value

    @field_validator("units")
    @classmethod
    def _known_units(cls, value: str) -> str:
        value = value.strip().lower()
        if value not in {"metric", "imperial"}:
            raise ValueError("units must be 'metric' or 'imperial'")
        return value

    # --- Loop limits (stop runaway think → tool → think loops) ---
    # Defaults are kept low on purpose: every model call is one API request,
    # and free LLM tiers run out fast (see DECISIONS.md D25).
    max_model_calls: int = Field(
        default=10,
        description="Max model calls per user message; the run then ends cleanly",
    )
    max_tool_calls: int = Field(
        default=20,
        description="Max tool calls per user message; extra calls are refused",
    )
    task_budget: int = Field(
        default=30,
        description=(
            "Max model calls for one user message across the main agent AND "
            "all subagents together"
        ),
    )

    # --- Memory (the notebook) ---
    memory_backend: str = Field(
        default="sqlite",
        description="'sqlite' (saved to disk) or 'memory' (RAM only)",
    )
    checkpoint_path: Path = Field(
        default=DEFAULT_CHECKPOINT_PATH,
        description="Where to store the SQLite memory file",
    )

    summary_trigger_tokens: int = Field(
        default=12000,
        description=(
            "Summarize older messages once a thread's history passes this many "
            "tokens (keeps cost and context size bounded). 0 disables."
        ),
    )
    summary_keep_tokens: int = Field(
        default=4000,
        description=(
            "How many tokens of recent messages to keep word-for-word after "
            "summarizing. Kept well below summary_trigger_tokens so one summary "
            "buys many turns instead of re-summarizing on every model call."
        ),
    )

    # --- Long-term memory (across threads; see luna/agent/longterm.py) ---
    enable_longterm_memory: bool = Field(
        default=True,
        description="Remember facts about you across threads (you approve every change)",
    )
    longterm_memory_path: Path = Field(
        default=DEFAULT_LONGTERM_PATH,
        description="SQLite file for long-term memory (separate from thread checkpoints)",
    )
    memory_recall_limit: int = Field(
        default=5,
        description="Keyword matches shown to Luna per message, besides pinned memories",
    )
    memory_prompt_chars: int = Field(
        default=1500,
        description="Max characters of memories added to the system prompt",
    )
    memory_max_suggestions: int = Field(
        default=3,
        description="Max memory suggestions Luna may make for one message",
    )

    # --- Tools ---
    # Tavily web search (https://app.tavily.com). Unset = no researcher subagent.
    tavily_api_key: str | None = Field(default=None, repr=False)
    mcp_config_path: Path = Field(
        default=DEFAULT_MCP_CONFIG,
        description="JSON file listing MCP servers to connect",
    )
    enable_builtin_tools: bool = Field(
        default=True,
        description="Load calculator / time / ask_user tools from this repo",
    )
    enable_mcp_tools: bool = Field(
        default=True,
        description="Connect to MCP servers from mcp_servers.json",
    )

    # --- Mail (servers/mail_mcp_server.py, used by ask_assistant; docs/mail.md) ---
    # Read by the mail MCP server itself: stdio servers don't inherit Luna's env.
    # gmail = Gmail API with the Google sign-in (luna-google-auth);
    # imap = IMAP/SMTP with an app password (the LUNA_MAIL_* below).
    mail_backend: str = Field(default="gmail", description="'gmail' or 'imap'")
    mail_address: str | None = Field(default=None, description="Your email address (sender of Luna's mail)")
    mail_password: str | None = Field(default=None, repr=False)  # an app password, not your login password
    mail_username: str | None = Field(default=None, description="IMAP/SMTP login if not the address")
    mail_imap_host: str = Field(default="imap.gmail.com", description="IMAP server (reading)")
    mail_imap_port: int = Field(default=993, description="IMAP over SSL port")
    mail_smtp_host: str = Field(default="smtp.gmail.com", description="SMTP server (sending)")
    mail_smtp_port: int = Field(default=465, description="465 = SSL, anything else = STARTTLS (e.g. 587)")
    mail_max_body_chars: int = Field(
        default=4000,
        description="Longer email bodies are cut before they reach the model",
    )

    # --- Google: Gmail, Calendar, Tasks sync (luna/integrations/google.py; docs/google.md) ---
    # OAuth: the client file comes from Google Cloud Console; the token is written
    # by `uv run luna-google-auth`. Both stay in data/ (git-ignored).
    google_credentials_path: Path = Field(
        default=DEFAULT_GOOGLE_DIR / "credentials.json",
        description="OAuth client file (Desktop app) downloaded from Google Cloud",
    )
    google_token_path: Path = Field(
        default=DEFAULT_GOOGLE_DIR / "token.json",
        description="Saved Google sign-in (created by the auth command)",
    )
    google_calendar_id: str = Field(default="primary", description="Calendar the assistant uses")
    google_tasklist_id: str = Field(default="@default", description="Google Tasks list the local to-dos sync with")
    tasks_google_sync: bool = Field(
        default=True,
        description="Two-way sync of the local to-dos (LUNA_TASKS_PATH) with Google Tasks when signed in",
    )

    # --- Files / coding sandbox ---
    # NoDecode: read these as plain comma-separated text, not JSON lists.
    workspace_dirs: Annotated[list[Path], NoDecode] = Field(
        default_factory=lambda: [DEFAULT_WORKSPACE],
        description=(
            "Comma-separated folders the files and coder helpers may touch. "
            "Relative paths in tool calls resolve against the first one."
        ),
    )
    auto_approve: Annotated[list[str], NoDecode] = Field(
        default_factory=list,
        description=(
            "Comma-separated tool names that run WITHOUT asking you first, "
            "e.g. 'write_file'. Leave empty to approve every risky action."
        ),
    )

    @field_validator("workspace_dirs", "auto_approve", mode="before")
    @classmethod
    def _split_commas(cls, value: object) -> object:
        if isinstance(value, str):
            return [part.strip() for part in value.split(",") if part.strip()]
        return value

    @field_validator("workspace_dirs")
    @classmethod
    def _absolute_dirs(cls, value: list[Path]) -> list[Path]:
        # Relative entries are relative to the project root, like other paths here.
        return [
            (p.expanduser() if p.expanduser().is_absolute() else PROJECT_ROOT / p).resolve()
            for p in value
        ]

    # --- Web UI (luna-web) ---
    web_host: str = Field(
        default="127.0.0.1",
        description="Address the web server listens on (keep it local: it can run tools)",
    )
    web_port: int = Field(default=8765, description="Port for the web server")
    web_allowed_origins: Annotated[list[str], NoDecode] = Field(
        default_factory=lambda: ["http://localhost:5173", "http://127.0.0.1:5173"],
        description=(
            "Comma-separated browser origins allowed to open the WebSocket, besides "
            "the server's own address. Default = the Vite dev server."
        ),
    )

    # App window (luna/web/window.py): luna-web opens the UI like a desktop app.
    web_open_window: bool = Field(
        default=True,
        description="Open Luna in its own app window when luna-web starts (--no-window skips it once)",
    )
    web_close_with_window: bool = Field(
        default=True,
        description="Stop luna-web when the app window is closed, like quitting an app",
    )
    web_browser: str | None = Field(
        default=None,
        description=(
            "Chromium-family browser for the app window (command or path). "
            "Empty = the first of Chrome, Chromium, Edge, Brave found"
        ),
    )

    # --- Voice output (web UI) ---
    tts_engine: str = Field(
        default="piper",
        description="'piper' (local neural voice, core follows the real audio) or 'browser'",
    )
    tts_voice: str = Field(
        default="en_US-lessac-medium",
        description="Piper voice name, downloaded once into tts_voices_dir",
    )
    tts_voices_dir: Path = Field(default=DEFAULT_VOICES_DIR, description="Where Piper voices are kept")
    tts_length_scale: float = Field(
        default=0.95,
        description="Piper speaking pace: < 1 faster, > 1 slower",
    )

    # --- Voice input (web UI) ---
    stt_engine: str = Field(
        default="whisper",
        description=(
            "'whisper' (local, any browser, enables the 'Hey Luna' wake word) or "
            "'browser' (Chrome/Edge recognition, no wake word)"
        ),
    )
    stt_model: str = Field(
        default="base.en",
        description="Whisper model: tiny.en (fastest), base.en, small.en (most accurate)",
    )
    stt_models_dir: Path = Field(default=DEFAULT_STT_DIR, description="Where Whisper models are kept")
    stt_threads: int = Field(default=4, description="CPU threads for Whisper")

    # --- Routines (luna/routines/; docs/control-center.md) ---
    # Scheduled jobs that run inside luna-web: data-only checks (mail, agenda,
    # to-dos) and prompts run by the agent. Only while luna-web is running.
    routines_enabled: bool = Field(
        default=True,
        description="Run scheduled routines while luna-web is running",
    )
    routines_path: Path = Field(
        default=DEFAULT_ROUTINES_PATH,
        description="SQLite file for routines, their runs and API usage counters",
    )

    # --- Messaging (luna/channels/; docs/messaging.md) ---
    # Control Luna from your phone over Telegram while luna-web runs.
    telegram_bot_token: str | None = Field(default=None, repr=False)  # from @BotFather; unset = off
    telegram_allowed_users: Annotated[list[int], NoDecode] = Field(
        default_factory=list,
        description=(
            "Comma-separated Telegram user ids that may use the bot. Empty = nobody "
            "(the bot replies with your id so you can add it)"
        ),
    )
    telegram_voice_replies: bool = Field(
        default=True,
        description="Answer a voice note with a voice note too (needs Piper, LUNA_TTS_ENGINE=piper)",
    )
    telegram_routine_alerts: bool = Field(
        default=True,
        description="Send routine results (with notifications on) to the allowed Telegram users",
    )

    @field_validator("telegram_allowed_users", mode="before")
    @classmethod
    def _split_user_ids(cls, value: object) -> object:
        if isinstance(value, str):
            return [int(part) for part in value.replace(" ", "").split(",") if part]
        return value

    @field_validator("stt_engine")
    @classmethod
    def _known_stt(cls, value: str) -> str:
        value = value.strip().lower()
        if value not in {"whisper", "browser"}:
            raise ValueError("stt_engine must be 'whisper' or 'browser'")
        return value

    @field_validator("tts_engine")
    @classmethod
    def _known_tts(cls, value: str) -> str:
        value = value.strip().lower()
        if value not in {"piper", "browser"}:
            raise ValueError("tts_engine must be 'piper' or 'browser'")
        return value

    @field_validator("web_allowed_origins", mode="before")
    @classmethod
    def _split_origins(cls, value: object) -> object:
        if isinstance(value, str):
            return [part.strip().rstrip("/") for part in value.split(",") if part.strip()]
        return value


@lru_cache
def get_settings() -> Settings:
    """Return the shared Settings instance (created once)."""
    return Settings()
