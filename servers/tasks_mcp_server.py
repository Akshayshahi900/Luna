"""
Local to-do / reminder MCP server — the default backend for ask_assistant.

BEGINNER MAP
------------
Like servers/demo_mcp_server.py, this is a separate program that Luna
starts and talks to over stdio. config/mcp_servers.json tags it with
"agent": "assistant", so its tools go to the assistant helper (not the
main agent), and that is what turns ask_assistant on.

Tasks live in one JSON file (default data/tasks.json, override with
LUNA_TASKS_PATH). No accounts, no network.

Tools:
  list_tasks     read-only, runs without asking
  add_task       ┐
  set_task_done  ├ names contain add/set/delete → Luna asks for approval
  delete_task    ┘ (unless listed in LUNA_AUTO_APPROVE)

Try it alone::

    uv run python servers/tasks_mcp_server.py
"""

from __future__ import annotations

import json
import os
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any

from fastmcp import FastMCP

DEFAULT_PATH = Path(__file__).resolve().parent.parent / "data" / "tasks.json"

mcp = FastMCP("luna-tasks")


def _path() -> Path:
    # Read per call so tests (and users) can point it elsewhere.
    return Path(os.environ.get("LUNA_TASKS_PATH") or DEFAULT_PATH)


def _load() -> list[dict[str, Any]]:
    path = _path()
    if not path.exists():
        return []
    return json.loads(path.read_text(encoding="utf-8"))


def _save(tasks: list[dict[str, Any]]) -> None:
    path = _path()
    path.parent.mkdir(parents=True, exist_ok=True)
    # Write a temp file then rename, so a crash never leaves half a file.
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(tasks, indent=2), encoding="utf-8")
    tmp.replace(path)


def _check_due(due: str) -> str:
    """Accept YYYY-MM-DD or an ISO date-time; return it normalized."""
    try:
        if len(due) == 10:
            return date.fromisoformat(due).isoformat()
        return datetime.fromisoformat(due).isoformat(timespec="minutes")
    except ValueError as exc:
        raise ValueError(f"due must be YYYY-MM-DD or YYYY-MM-DDTHH:MM, got {due!r}") from exc


def _find(tasks: list[dict[str, Any]], task_id: int) -> dict[str, Any]:
    for task in tasks:
        if task["id"] == task_id:
            return task
    raise ValueError(f"No task with id {task_id}. Call list_tasks to see ids.")


@mcp.tool()
def list_tasks(include_done: bool = False) -> list[dict[str, Any]]:
    """List to-dos and reminders, soonest due first (undated ones last)."""
    tasks = [t for t in _load() if include_done or not t["done"]]
    return sorted(tasks, key=lambda t: (t["due"] is None, t["due"] or "", t["id"]))


@mcp.tool()
def add_task(title: str, due: str | None = None, notes: str = "") -> dict[str, Any]:
    """Add a to-do. due is optional: YYYY-MM-DD or YYYY-MM-DDTHH:MM (local time)."""
    title = title.strip()
    if not title:
        raise ValueError("title must not be empty")
    tasks = _load()
    task = {
        "id": max((t["id"] for t in tasks), default=0) + 1,
        "title": title,
        "due": _check_due(due) if due else None,
        "notes": notes,
        "done": False,
        "created": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    tasks.append(task)
    _save(tasks)
    return task


@mcp.tool()
def set_task_done(task_id: int, done: bool = True) -> dict[str, Any]:
    """Mark a to-do done (or not done again with done=false)."""
    tasks = _load()
    task = _find(tasks, task_id)
    task["done"] = done
    _save(tasks)
    return task


@mcp.tool()
def delete_task(task_id: int) -> str:
    """Delete a to-do permanently."""
    tasks = _load()
    task = _find(tasks, task_id)
    tasks.remove(task)
    _save(tasks)
    return f"Deleted task {task_id}: {task['title']}"


if __name__ == "__main__":
    mcp.run(transport="stdio")
