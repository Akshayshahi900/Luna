"""
Luna settings — one place for all configuration knobs.

BEGINNER MAP
------------
Hard-coding "phi4-mini:latest" in ten files is painful to change.
Instead, Settings holds defaults, and you can override them with
environment variables that start with LUNA_:

  export LUNA_MODEL_NAME=llama3.2:latest
  export LUNA_MEMORY_BACKEND=memory
  export LUNA_ENABLE_MCP_TOOLS=false

Or put the same keys in a `.env` file in the project root.
See config/env.example for a full list.

get_settings() is cached (lru_cache): the first call reads env/defaults;
later calls reuse the same object for speed.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

# This file lives at: src/luna/config/settings.py
# parents[0]=config, [1]=luna, [2]=src, [3]=project root (Luna/)
PROJECT_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_MCP_CONFIG = PROJECT_ROOT / "config" / "mcp_servers.json"
DEFAULT_CHECKPOINT_PATH = PROJECT_ROOT / "data" / "luna_memory.sqlite"


class Settings(BaseSettings):
    """All runtime options for the chatbot.

    Field names map to env vars automatically:
      model_name  →  LUNA_MODEL_NAME
      memory_backend → LUNA_MEMORY_BACKEND
      ...
    """

    model_config = SettingsConfigDict(
        env_prefix="LUNA_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",  # ignore unknown env vars instead of crashing
    )

    # --- LLM (the brain) ---
    model_name: str = Field(
        default="phi4-mini:latest",
        description="Ollama model tag, e.g. phi4-mini:latest",
    )
    system_prompt: str = Field(
        default=(
            "You are Luna, a helpful assistant. "
            "Use tools when they help you answer accurately. "
            "Remember prior turns in this conversation."
        ),
        description="Instructions the model always sees first",
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

    # --- Tools ---
    mcp_config_path: Path = Field(
        default=DEFAULT_MCP_CONFIG,
        description="JSON file listing MCP servers to connect",
    )
    enable_builtin_tools: bool = Field(
        default=True,
        description="Load calculator / time / echo tools from this repo",
    )
    enable_mcp_tools: bool = Field(
        default=True,
        description="Connect to MCP servers from mcp_servers.json",
    )

    # --- Chat ---
    default_thread_id: str = Field(
        default="default",
        description="Conversation id used when you first start the CLI",
    )


@lru_cache
def get_settings() -> Settings:
    """Return the shared Settings instance (created once)."""
    return Settings()
