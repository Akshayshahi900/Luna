"""
To-do / reminder MCP server — a local list, two-way synced with Google Tasks.

BEGINNER MAP
------------
Like servers/demo_mcp_server.py, this is a separate program that Luna
starts and talks to over stdio. config/mcp_servers.json tags it with
"agent": "assistant", so its tools go to the assistant helper (not the
main agent), and that is what turns ask_assistant on.

Tasks live in one JSON file (default data/tasks.json, override with
LUNA_TASKS_PATH). The file is the source of truth, so the list works
offline and without a Google account.

Google Tasks sync (LUNA_TASKS_GOOGLE_SYNC, on by default): when you are
signed in (`uv run luna-google-auth`), every tool call first syncs the file
with one Google task list (LUNA_GOOGLE_TASKLIST_ID) both ways:

  local only          → created in Google
  changed locally     → pushed to Google
  changed in Google   → pulled into the file
  changed in both     → the newer change wins
  deleted on one side → deleted on the other
  new open Google task→ added to the file (completed ones are not imported)

Not signed in, or Google unreachable: the tools keep working on the file
alone; unsynced changes go up on the next successful sync. Each task says
"synced": true once Google has its latest version.

Tools:
  list_tasks           read-only, runs without asking
  add_task             ┐
  set_task_done        │ names contain add/set/delete → Luna asks for approval
  delete_task          │ (unless listed in LUNA_AUTO_APPROVE)
  add_task_from_email  ┘ a to-do from an email (mail server), linked back to it

Try it alone::

    uv run python servers/tasks_mcp_server.py
"""

from __future__ import annotations

import json
import os
import re
import sys
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any

from fastmcp import FastMCP

from luna.config import Settings
from luna.integrations import google as google_api

# servers/ is not a package: make the sibling mail server importable both when
# Luna starts this script and when tests load it by path.
_HERE = str(Path(__file__).resolve().parent)
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)
import mail_mcp_server as mail  # noqa: E402

DEFAULT_PATH = Path(__file__).resolve().parent.parent / "data" / "tasks.json"
# Line in a task's notes that links it to the email it came from.
_EMAIL_MARKER = re.compile(r"\[luna-email:(.+?)\]")

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


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _touch(task: dict[str, Any]) -> None:
    """Mark a local change, so the next sync pushes it."""
    task["updated"] = _now()
    task["dirty"] = True


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
        if task["id"] == task_id and not task.get("deleted"):
            return task
    raise ValueError(f"No task with id {task_id}. Call list_tasks to see ids.")


def _public(task: dict[str, Any]) -> dict[str, Any]:
    """What the model sees (sync bookkeeping left out)."""
    linked = _EMAIL_MARKER.search(task.get("notes") or "")
    return {
        "id": task["id"],
        "title": task["title"],
        "due": task.get("due"),
        "notes": task.get("notes", ""),
        "done": task.get("done", False),
        "created": task.get("created"),
        "synced": bool(task.get("google_id")) and not task.get("dirty"),
        "from_email": linked.group(1) if linked else "",
    }


# --- Google Tasks sync -------------------------------------------------------

def _stamp(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _remote_body(task: dict[str, Any]) -> dict[str, Any]:
    """The Google Tasks fields for a local task (Google keeps only the due date)."""
    body: dict[str, Any] = {
        "title": task["title"],
        "notes": task.get("notes", ""),
        "due": f"{task['due'][:10]}T00:00:00.000Z" if task.get("due") else None,
        "status": "completed" if task.get("done") else "needsAction",
    }
    if not task.get("done"):
        body["completed"] = None  # clearing it is what reopens a Google task
    return body


def _pull(task: dict[str, Any], remote: dict[str, Any]) -> None:
    """Copy a Google task into the local one."""
    task["title"] = remote.get("title", "")
    task["notes"] = remote.get("notes", "")
    remote_day = (remote.get("due") or "")[:10] or None
    if (task.get("due") or "")[:10] != (remote_day or ""):
        task["due"] = remote_day  # a local time is kept while the day still matches
    task["done"] = remote.get("status") == "completed"
    task["updated"] = remote.get("updated", _now())
    task["google_updated"] = remote.get("updated", "")
    task["dirty"] = False


def _remote_tasks(api: Any, tasklist: str) -> dict[str, dict[str, Any]]:
    """Every task in the Google list, including completed, hidden and deleted ones."""
    found: dict[str, dict[str, Any]] = {}
    page = None
    while True:
        params: dict[str, Any] = {
            "tasklist": tasklist, "showCompleted": True, "showHidden": True,
            "showDeleted": True, "maxResults": 100,
        }
        if page:
            params["pageToken"] = page
        response = google_api.execute(api.list(**params))
        found.update({item["id"]: item for item in response.get("items", [])})
        page = response.get("nextPageToken")
        if not page:
            return found


def sync_with_google(tasks: list[dict[str, Any]], settings: Settings) -> bool:
    """Two-way sync ``tasks`` (in place) with Google Tasks. False when sync is off.

    Raises on Google errors; every step records its result on the task right
    after Google accepts it, so a sync cut short leaves a consistent file.
    """
    if not settings.tasks_google_sync or not google_api.is_connected(settings):
        return False
    api = google_api.service("tasks", "v1", settings).tasks()
    tasklist = settings.google_tasklist_id
    remote = _remote_tasks(api, tasklist)
    linked: set[str] = set()

    for task in list(tasks):
        google_id = task.get("google_id")
        theirs = remote.get(google_id) if google_id else None
        if google_id:
            linked.add(google_id)
        if task.get("deleted"):  # deleted here while offline
            if theirs and not theirs.get("deleted"):
                google_api.execute(api.delete(tasklist=tasklist, task=google_id))
            tasks.remove(task)
        elif not google_id:  # new here
            created = google_api.execute(api.insert(tasklist=tasklist, body=_remote_body(task)))
            task["google_id"] = created["id"]
            task["google_updated"] = created.get("updated", "")
            task["dirty"] = False
            linked.add(created["id"])
        elif theirs is None or theirs.get("deleted"):  # deleted in Google
            tasks.remove(task)
        else:
            changed_there = theirs.get("updated", "") != task.get("google_updated")
            if task.get("dirty") and changed_there and _stamp(theirs["updated"]) > _stamp(task["updated"]):
                _pull(task, theirs)  # both changed, Google's is newer
            elif task.get("dirty"):
                pushed = google_api.execute(
                    api.patch(tasklist=tasklist, task=google_id, body=_remote_body(task))
                )
                task["google_updated"] = pushed.get("updated", "")
                task["dirty"] = False
            elif changed_there:
                _pull(task, theirs)

    next_id = max((t["id"] for t in tasks), default=0) + 1
    for google_id, theirs in remote.items():
        if google_id in linked or theirs.get("deleted") or theirs.get("status") == "completed":
            continue
        if not theirs.get("title", "").strip():
            continue  # Google keeps empty placeholder rows
        task = {"id": next_id, "title": "", "due": None, "notes": "", "done": False,
                "created": _now(), "google_id": google_id}
        _pull(task, theirs)
        tasks.append(task)
        next_id += 1
    return True


def _synced(tasks: list[dict[str, Any]]) -> None:
    """Sync if possible; on any Google problem keep working locally."""
    try:
        sync_with_google(tasks, Settings())
    except Exception as exc:  # noqa: BLE001 — offline / expired sign-in must not break to-dos
        print(f"Google Tasks sync skipped: {exc}", file=sys.stderr)


def _new_task(tasks: list[dict[str, Any]], title: str, due: str | None, notes: str) -> dict[str, Any]:
    title = title.strip()
    if not title:
        raise ValueError("title must not be empty")
    task = {
        "id": max((t["id"] for t in tasks), default=0) + 1,
        "title": title,
        "due": _check_due(due) if due else None,
        "notes": notes,
        "done": False,
        "created": _now(),
    }
    _touch(task)
    tasks.append(task)
    return task


# --- Tools -------------------------------------------------------------------

@mcp.tool()
def list_tasks(include_done: bool = False) -> list[dict[str, Any]]:
    """List to-dos and reminders, soonest due first (undated ones last).
    Synced with Google Tasks when the user is signed in."""
    tasks = _load()
    _synced(tasks)
    _save(tasks)
    shown = [t for t in tasks if not t.get("deleted") and (include_done or not t["done"])]
    return [_public(t) for t in sorted(shown, key=lambda t: (t["due"] is None, t["due"] or "", t["id"]))]


@mcp.tool()
def add_task(title: str, due: str | None = None, notes: str = "") -> dict[str, Any]:
    """Add a to-do. due is optional: YYYY-MM-DD or YYYY-MM-DDTHH:MM (local time;
    Google Tasks shows the date only)."""
    tasks = _load()
    task = _new_task(tasks, title, due, notes)
    _synced(tasks)
    _save(tasks)
    return _public(task)


@mcp.tool()
def set_task_done(task_id: int, done: bool = True) -> dict[str, Any]:
    """Mark a to-do done (or not done again with done=false)."""
    tasks = _load()
    task = _find(tasks, task_id)
    task["done"] = done
    _touch(task)
    _synced(tasks)
    _save(tasks)
    return _public(task)


@mcp.tool()
def delete_task(task_id: int) -> str:
    """Delete a to-do permanently (also from Google Tasks)."""
    tasks = _load()
    task = _find(tasks, task_id)
    if task.get("google_id"):
        task["deleted"] = True  # kept until Google has deleted it too
        _touch(task)
    else:
        tasks.remove(task)
    _synced(tasks)
    _save(tasks)
    return f"Deleted task {task_id}: {task['title']}"


@mcp.tool()
def add_task_from_email(uid: str, title: str = "", due: str | None = None, folder: str = "INBOX") -> dict[str, Any]:
    """Make a to-do from an email (uid from list_inbox / search_emails).
    title defaults to the subject; the notes link back to the email. If a
    to-do for this email exists already, it is returned instead."""
    ref = mail.email_reference(mail.fetch_email(uid, folder), uid, folder)
    tasks = _load()
    _synced(tasks)
    for task in tasks:
        if not task.get("deleted") and _public(task)["from_email"] == ref["id"]:
            _save(tasks)
            return {"created": False, "note": "A to-do for this email already exists", "task": _public(task)}
    task = _new_task(
        tasks,
        title.strip() or ref["subject"] or f"Email from {ref['from']}",
        due,
        f"{mail.reference_text(ref)}\n[luna-email:{ref['id']}]",
    )
    _synced(tasks)
    _save(tasks)
    return {"created": True, "task": _public(task)}


if __name__ == "__main__":
    mcp.run(transport="stdio")
