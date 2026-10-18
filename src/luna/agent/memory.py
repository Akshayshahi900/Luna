"""
Conversation memory for Luna (short-term / per-chat).

BEGINNER MAP
------------
Problem: LLMs do not remember past turns by themselves.
Solution: LangGraph saves the message list after every turn (a "checkpoint")
and reloads it next time using the same thread_id.

Two backends:
  - "sqlite"  → file on disk (default). Survives restart.
  - "memory"  → RAM only. Forgotten when the process exits.

IMPORTANT: the CLI uses ``agent.astream(...)`` (async).
SQLite memory must therefore be ``AsyncSqliteSaver``, not the sync
``SqliteSaver`` — otherwise you get:
  "The SqliteSaver does not support async methods."

You do NOT append to a history list yourself. Pass checkpointer into
create_agent(...), then pass thread_id when you invoke. LangGraph handles
load/save.

Read next: luna/config/settings.py (how to switch backends).
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import aiosqlite
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver

# Keep aiosqlite connections alive for the process lifetime.
# If they get garbage-collected, later ainvoke calls fail.
_OPEN_CONNECTIONS: list[Any] = []


async def create_checkpointer(
    backend: str = "sqlite",
    path: Path | str | None = None,
) -> Any:
    """Build the memory object LangGraph will use (async-safe).

    Parameters
    ----------
    backend:
        ``"sqlite"`` (durable) or ``"memory"`` (temporary).
    path:
        File path for SQLite. Ignored for the in-memory backend.

    Returns
    -------
    A checkpointer instance passed to ``create_agent(..., checkpointer=...)``.
    """
    backend = backend.lower().strip()

    if backend == "memory":
        # Fast, good for experiments. History dies with the process.
        # InMemorySaver works with both invoke and ainvoke.
        return InMemorySaver()

    if backend == "sqlite":
        if path is None:
            raise ValueError("sqlite memory backend requires a checkpoint path")
        checkpoint_path = Path(path)
        # Make sure data/ exists before opening the DB file.
        checkpoint_path.parent.mkdir(parents=True, exist_ok=True)

        # Async connection — required because the CLI streams with agent.astream().
        conn = await aiosqlite.connect(str(checkpoint_path))
        _OPEN_CONNECTIONS.append(conn)
        saver = AsyncSqliteSaver(conn)
        # Creates tables the first time (checkpoints, writes, ...).
        await saver.setup()
        return saver

    raise ValueError(
        f"Unknown memory backend '{backend}'. Use 'memory' or 'sqlite'."
    )


async def close_checkpointers() -> None:
    """Close any open SQLite connections. Call once when the app exits."""
    while _OPEN_CONNECTIONS:
        await _OPEN_CONNECTIONS.pop().close()


__all__ = ["close_checkpointers", "create_checkpointer"]
