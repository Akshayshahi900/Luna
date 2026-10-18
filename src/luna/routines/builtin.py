"""
Built-in routines: quick data-only checks for the dashboard (no LLM).

BEGINNER MAP
------------
Each built-in calls ONE read-only MCP tool directly, the same tool objects
the assistant helper uses (loaded once by luna-web), and turns the answer
into a one-line summary plus a little data for the HUD widgets:

  mail_check  list_inbox(unread_only=True)  → unread count, newest senders
  agenda      get_agenda()                  → today's events, the next one
  todos       list_tasks()                  → open / due today / overdue

No model is involved, so these cost no LLM quota. Only tools whose names
are not risky (luna/mcp/loader.py) may be called here: a routine runs with
nobody watching, so it must never change anything.

A missing tool (the server isn't configured) gives status "skipped"; a
tool error (e.g. not signed in to Google) gives "error". Neither stops the
scheduler.

Read next: luna/routines/agent.py
"""

from __future__ import annotations

import json
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from luna.mcp.loader import is_risky_tool_name

# (status, summary, data) — status is "ok", "skipped" or "error".
Result = tuple[str, str, Any]
Collect = Callable[[Any, datetime], Result]


@dataclass(frozen=True)
class BuiltinSpec:
    """One built-in routine: its default name and schedule, and its tool."""

    name: str
    cron: str
    tool: str
    args: dict[str, Any]
    description: str
    collect: Collect


def decode_tool_output(output: Any) -> Any:
    """An MCP tool's answer as plain JSON.

    MCP tools return text content (a string, or a list of content blocks);
    FastMCP servers put JSON in it. Several blocks that each hold JSON are
    returned as a list.
    """
    if isinstance(output, tuple):  # (content, artifact)
        output = output[0]
    if isinstance(output, (dict, int, float, bool)) or output is None:
        return output
    if isinstance(output, list):
        texts = []
        for block in output:
            if isinstance(block, dict):
                texts.append(block.get("text", ""))
            elif isinstance(block, str):
                texts.append(block)
            else:
                texts.append(getattr(block, "text", ""))
        parsed = [_maybe_json(t) for t in texts]
        if len(parsed) == 1:
            return parsed[0]
        return parsed
    return _maybe_json(str(output))


def _maybe_json(text: str) -> Any:
    try:
        return json.loads(text)
    except (TypeError, ValueError):
        return text


def _as_list(value: Any) -> list[Any]:
    if isinstance(value, list):
        return value
    if isinstance(value, dict) and isinstance(value.get("result"), list):
        return value["result"]  # FastMCP wraps lists as {"result": [...]} in structured output
    return []


def _clip(text: Any, limit: int = 60) -> str:
    text = " ".join(str(text or "").split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _sender(value: Any) -> str:
    """'Ann Lee <ann@x.com>' → 'Ann Lee'."""
    text = str(value or "").strip()
    name = text.split("<", 1)[0].strip().strip('"')
    return name or text


# --- collectors --------------------------------------------------------------

def _mail(output: Any, now: datetime) -> Result:
    items = _as_list(output)
    if not items and not isinstance(output, list):
        return "error", _clip(output, 160) or "No answer from the mail server.", None
    mails = [
        {"from": _sender(m.get("from")), "subject": _clip(m.get("subject"), 90), "date": m.get("date")}
        for m in items if isinstance(m, dict)
    ]
    if not mails:
        return "ok", "Inbox zero: no unread mail.", {"unread": 0, "items": []}
    latest = mails[0]
    more = f" (+{len(mails) - 1} more)" if len(mails) > 1 else ""
    summary = f"{len(mails)} unread · latest from {latest['from']}: {latest['subject']}{more}"
    return "ok", summary, {"unread": len(mails), "items": mails[:5]}


def _event_start(event: dict[str, Any]) -> str:
    start = event.get("start")
    if isinstance(start, dict):  # raw Google shape
        return str(start.get("dateTime") or start.get("date") or "")
    return str(start or "")


def _not_over(event: dict[str, Any], now: datetime) -> bool:
    """All-day events count all day; timed ones until they end (or start)."""
    for key in ("end", "start"):
        text = event.get(key) or ""
        if len(text) <= 10:
            continue
        try:
            moment = datetime.fromisoformat(text)
        except ValueError:
            continue
        if moment.tzinfo is None:
            moment = moment.replace(tzinfo=now.tzinfo)
        return moment >= now
    return bool(event.get("start"))


def _agenda(output: Any, now: datetime) -> Result:
    if not isinstance(output, dict):
        return "error", _clip(output, 160) or "No answer from the calendar server.", None
    events = [e for e in output.get("events", []) if isinstance(e, dict)]
    slim = [
        {"title": _clip(e.get("title") or e.get("summary"), 80), "start": _event_start(e),
         "end": str(e.get("end") or ""), "location": _clip(e.get("location"), 60)}
        for e in events
    ]
    upcoming = [e for e in slim if _not_over(e, now)]
    nxt = upcoming[0] if upcoming else None
    due, overdue = output.get("tasks_due") or [], output.get("overdue") or []
    data = {"events": slim, "next": nxt, "tasks_due": len(due), "overdue": len(overdue), "date": output.get("date")}
    if not slim:
        summary = "Nothing on the calendar today."
    else:
        when = nxt["start"][11:16] if nxt and len(nxt["start"]) > 10 else "all day"
        summary = f"{len(slim)} event{'s' if len(slim) != 1 else ''} today"
        summary += f" · next: {nxt['title']} ({when})" if nxt else " · all done"
    return "ok", summary, data


def _todos(output: Any, now: datetime) -> Result:
    items = _as_list(output)
    if not items and not isinstance(output, list):
        return "error", _clip(output, 160) or "No answer from the to-do server.", None
    tasks = [t for t in items if isinstance(t, dict) and not t.get("done")]
    today = now.date().isoformat()
    due_today = [t for t in tasks if (t.get("due") or "")[:10] == today]
    overdue = [t for t in tasks if t.get("due") and t["due"][:10] < today]
    top = [{"title": _clip(t.get("title"), 80), "due": t.get("due")} for t in (overdue + due_today + tasks)[:5]]
    seen: set[str] = set()
    top = [t for t in top if not (t["title"] in seen or seen.add(t["title"]))]
    data = {"open": len(tasks), "due_today": len(due_today), "overdue": len(overdue), "items": top}
    if not tasks:
        return "ok", "No open to-dos.", data
    parts = [f"{len(tasks)} open"]
    if due_today:
        parts.append(f"{len(due_today)} due today")
    if overdue:
        parts.append(f"{len(overdue)} overdue")
    return "ok", " · ".join(parts), data


BUILTINS: dict[str, BuiltinSpec] = {
    "mail_check": BuiltinSpec(
        name="Check email",
        cron="*/15 * * * *",
        tool="list_inbox",
        args={"limit": 10, "unread_only": True},
        description="Unread mail count and the newest senders (mail server)",
        collect=_mail,
    ),
    "agenda": BuiltinSpec(
        name="Today's agenda",
        cron="*/30 * * * *",
        tool="get_agenda",
        args={},
        description="Today's calendar events and the next one (Google server)",
        collect=_agenda,
    ),
    "todos": BuiltinSpec(
        name="To-dos",
        cron="*/30 * * * *",
        tool="list_tasks",
        args={},
        description="Open, due-today and overdue to-dos (tasks server)",
        collect=_todos,
    ),
}


def find_tool(tools: dict[str, Any], name: str) -> Any:
    """The tool called ``name``, or ``<server>_<name>``: when one helper has
    several MCP servers, the adapter prefixes each tool with its server's
    name (e.g. ``mail_list_inbox``). None when missing or ambiguous."""
    if name in tools:
        return tools[name]
    matches = [tool for key, tool in tools.items() if key.endswith(f"_{name}")]
    return matches[0] if len(matches) == 1 else None


async def run_builtin(
    key: str,
    tools: dict[str, Any],
    now: datetime,
    call: Callable[[Any, dict[str, Any]], Awaitable[Any]] | None = None,
) -> Result:
    """Run one built-in: call its tool (no LLM) and summarize the answer."""
    spec = BUILTINS.get(key)
    if spec is None:
        return "error", f"Unknown built-in routine: {key}", None
    if is_risky_tool_name(spec.tool):  # guard: routines must never change anything
        return "error", f"{spec.tool} is not read-only", None
    tool = find_tool(tools, spec.tool)
    if tool is None:
        return "skipped", f"Not connected: no {spec.tool} tool (check MCP connectors).", None
    try:
        raw = await (call(tool, spec.args) if call else tool.ainvoke(spec.args))
    except Exception as exc:  # noqa: BLE001 — a failing server must not stop the scheduler
        return "error", _clip(str(exc) or type(exc).__name__, 200), None
    return spec.collect(decode_tool_output(raw), now)


__all__ = ["BUILTINS", "BuiltinSpec", "Result", "decode_tool_output", "find_tool", "run_builtin"]
