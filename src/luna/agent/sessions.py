"""
Sessions — saved conversations you can list, resume and delete.

BEGINNER MAP
------------
A session is a thread: every checkpoint saved under one thread_id
(luna/agent/memory.py). Luna starts a NEW session every time (each CLI
start, each browser tab / reload), and you resume an old one on purpose:

  CLI   luna --resume [id]   /sessions   /resume <n|id>   /delete <n|id>
  Web   transcript drawer → SESSIONS list (resume, delete)

A session only exists once something was said in it (a fresh thread has
no checkpoint), so opening Luna and closing it again leaves no clutter.

There is no separate table of sessions: the list is built from the
checkpoints, so it can never disagree with what is actually saved.
Titles come from the first thing you said.
"""

from __future__ import annotations

import uuid
from typing import Any

TITLE_CHARS = 60


def new_session_id() -> str:
    """A fresh, unique thread id for a new session."""
    return str(uuid.uuid4())


def _title(messages: list[Any]) -> str:
    first = next((m for m in messages if getattr(m, "type", None) == "human" and m.text.strip()), None)
    if first is None:
        return "(no messages)"
    text = " ".join(first.text.split())
    return text if len(text) <= TITLE_CHARS else text[: TITLE_CHARS - 1] + "…"


async def list_sessions(checkpointer: Any) -> list[dict[str, Any]]:
    """Every saved session, most recently used first.

    Each item: ``{"id", "title", "updated_at", "turns"}`` (turns = user
    messages still in the thread; summarization may have folded older ones).
    """
    latest: dict[str, Any] = {}  # thread id → newest main-graph checkpoint
    async for item in checkpointer.alist(None):
        configurable = item.config["configurable"]
        if configurable.get("checkpoint_ns", ""):
            continue  # a helper's checkpoint inside the thread
        thread_id = configurable["thread_id"]
        best = latest.get(thread_id)
        if best is None or item.checkpoint["ts"] > best.checkpoint["ts"]:
            latest[thread_id] = item

    sessions = []
    for thread_id, item in latest.items():
        messages = item.checkpoint.get("channel_values", {}).get("messages", [])
        sessions.append({
            "id": thread_id,
            "title": _title(messages),
            "updated_at": item.checkpoint["ts"],
            "turns": sum(1 for m in messages if getattr(m, "type", None) == "human"),
        })
    sessions.sort(key=lambda s: s["updated_at"], reverse=True)
    return sessions


def resolve_session(ref: str, sessions: list[dict[str, Any]]) -> str | None:
    """A session id from what the user typed: a list number (1 = newest),
    a full id, or the start of one. None when nothing (or several) match."""
    ref = ref.strip()
    if not ref:
        return None
    if ref.isdigit() and 1 <= int(ref) <= len(sessions):
        return sessions[int(ref) - 1]["id"]
    if any(s["id"] == ref for s in sessions):
        return ref
    matches = [s["id"] for s in sessions if s["id"].startswith(ref)]
    return matches[0] if len(matches) == 1 else None


async def delete_session(checkpointer: Any, thread_id: str) -> None:
    """Remove every checkpoint of a session (its messages, notes, pauses).

    Long-term memory is separate and is not touched.
    """
    await checkpointer.adelete_thread(thread_id)


__all__ = ["delete_session", "list_sessions", "new_session_id", "resolve_session"]
