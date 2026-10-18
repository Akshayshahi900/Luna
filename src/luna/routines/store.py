"""
RoutineStore — routines, their run history and API usage counters, in SQLite.

BEGINNER MAP
------------
Three tables in data/luna_routines.sqlite:

  routines  what to run and when (a cron line), enabled or not
            kind "builtin" = a data-only check (builtin.py, no LLM)
            kind "agent"   = a prompt the agent runs (agent.py, uses LLM quota)
  runs      one row per run: status, a one-line summary, the data the
            dashboard shows; only the newest KEEP_RUNS per routine are kept
  usage     model calls / tool calls / errors per day, provider and model,
            for the Control Center charts (counted in luna/web/server.py)

Same style as luna/agent/longterm.py: plain sqlite3 behind a lock, because
the scheduler, the HTTP routes and worker threads all use it.

Times are stored as UTC ISO text, so comparing strings compares times.
Schedules are read in your timezone (LUNA_TIMEZONE, else the machine's).

Read next: luna/routines/builtin.py
"""

from __future__ import annotations

import json
import sqlite3
import threading
from datetime import UTC, date, datetime, timedelta, tzinfo
from pathlib import Path
from typing import Any

from luna.routines.builtin import BUILTINS
from luna.routines.cron import describe, next_run, parse

KINDS = ("builtin", "agent")
KEEP_RUNS = 50
MAX_PROMPT_CHARS = 4000

_SCHEMA = """
CREATE TABLE IF NOT EXISTS routines (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    builtin TEXT,
    prompt TEXT NOT NULL DEFAULT '',
    cron TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 0,
    notify INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    next_run_at TEXT
);
CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY,
    routine_id INTEGER NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    status TEXT NOT NULL DEFAULT 'running',
    summary TEXT NOT NULL DEFAULT '',
    data TEXT,
    error TEXT
);
CREATE INDEX IF NOT EXISTS runs_by_routine ON runs (routine_id, id);
CREATE TABLE IF NOT EXISTS usage (
    day TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    runs INTEGER NOT NULL DEFAULT 0,
    model_calls INTEGER NOT NULL DEFAULT 0,
    tool_calls INTEGER NOT NULL DEFAULT 0,
    errors INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, provider, model)
);
"""


def _now() -> datetime:
    return datetime.now(UTC)


def _iso(when: datetime) -> str:
    return when.astimezone(UTC).isoformat(timespec="seconds")


class RoutineRefused(ValueError):
    """A routine change the store refuses (bad schedule, unknown id, ...)."""


class RoutineStore:
    """The routines database (see the module docstring)."""

    def __init__(self, path: Path | str = ":memory:", tz: tzinfo | None = None) -> None:
        if str(path) != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.tz = tz
        self._conn = sqlite3.connect(str(path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._lock = threading.Lock()
        with self._lock:
            self._conn.executescript(_SCHEMA)
            # A run still "running" was cut off by a restart.
            self._conn.execute(
                "UPDATE runs SET status = 'error', error = 'Interrupted by a restart', finished_at = ? "
                "WHERE status = 'running'",
                (_iso(_now()),),
            )
            self._conn.commit()

    def close(self) -> None:
        """Close the database connection."""
        with self._lock:
            self._conn.close()

    # --- schedules -----------------------------------------------------------

    def local_now(self) -> datetime:
        """Now, in the timezone schedules are read in."""
        return datetime.now(self.tz).astimezone(self.tz)

    def next_after(self, cron: str, after: datetime | None = None) -> str:
        """UTC ISO time of the next run of ``cron`` after ``after`` (default now)."""
        start = (after or _now()).astimezone(self.tz)
        return _iso(next_run(cron, start))

    # --- routines ------------------------------------------------------------

    def _routine(self, row: sqlite3.Row) -> dict[str, Any]:
        last = self._conn.execute(
            "SELECT * FROM runs WHERE routine_id = ? ORDER BY id DESC LIMIT 1", (row["id"],)
        ).fetchone()
        return {
            "id": row["id"],
            "name": row["name"],
            "kind": row["kind"],
            "builtin": row["builtin"],
            "prompt": row["prompt"],
            "cron": row["cron"],
            "schedule": describe(row["cron"]),
            "enabled": bool(row["enabled"]),
            "notify": bool(row["notify"]),
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
            "next_run_at": row["next_run_at"] if row["enabled"] else None,
            "last_run": self._run(last) if last else None,
        }

    @staticmethod
    def _run(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": row["id"],
            "routine_id": row["routine_id"],
            "started_at": row["started_at"],
            "finished_at": row["finished_at"],
            "status": row["status"],
            "summary": row["summary"],
            "data": json.loads(row["data"]) if row["data"] else None,
            "error": row["error"],
        }

    def _row(self, routine_id: int) -> sqlite3.Row:
        row = self._conn.execute("SELECT * FROM routines WHERE id = ?", (routine_id,)).fetchone()
        if row is None:
            raise RoutineRefused(f"No routine {routine_id}.")
        return row

    def list(self) -> list[dict[str, Any]]:
        """Every routine: built-ins first, then by id."""
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM routines ORDER BY kind = 'agent', id"
            ).fetchall()
            return [self._routine(r) for r in rows]

    def get(self, routine_id: int) -> dict[str, Any]:
        """One routine by id; RoutineRefused if missing."""
        with self._lock:
            return self._routine(self._row(routine_id))

    @staticmethod
    def _check_cron(cron: str) -> str:
        try:
            return parse(cron).expr
        except ValueError as exc:
            raise RoutineRefused(str(exc)) from exc

    def add(
        self,
        name: str,
        kind: str,
        cron: str,
        prompt: str = "",
        builtin: str | None = None,
        enabled: bool = False,
        notify: bool = True,
    ) -> dict[str, Any]:
        """Create a routine. Agent routines need a prompt; built-ins a known key."""
        name = " ".join(name.split())
        if not name:
            raise RoutineRefused("A routine needs a name.")
        if kind not in KINDS:
            raise RoutineRefused(f"Kind must be one of: {', '.join(KINDS)}.")
        prompt = prompt.strip()
        if kind == "agent" and not prompt:
            raise RoutineRefused("An agent routine needs a prompt.")
        if len(prompt) > MAX_PROMPT_CHARS:
            raise RoutineRefused(f"Prompts are limited to {MAX_PROMPT_CHARS} characters.")
        if kind == "builtin" and builtin not in BUILTINS:
            raise RoutineRefused(f"Unknown built-in routine: {builtin!r}")
        cron = self._check_cron(cron)
        now = _iso(_now())
        with self._lock:
            cur = self._conn.execute(
                "INSERT INTO routines (name, kind, builtin, prompt, cron, enabled, notify, created_at, "
                "updated_at, next_run_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (name, kind, builtin if kind == "builtin" else None, prompt, cron, int(enabled),
                 int(notify), now, now, self.next_after(cron)),
            )
            self._conn.commit()
            return self._routine(self._row(cur.lastrowid))

    def update(self, routine_id: int, **changes: Any) -> dict[str, Any]:
        """Change name / prompt / cron / enabled / notify. Built-ins keep their kind."""
        allowed = {"name", "prompt", "cron", "enabled", "notify"}
        unknown = set(changes) - allowed
        if unknown:
            raise RoutineRefused(f"Can't change: {', '.join(sorted(unknown))}")
        with self._lock:
            row = self._row(routine_id)
            name = " ".join(str(changes.get("name", row["name"])).split())
            prompt = str(changes.get("prompt", row["prompt"])).strip()
            cron = self._check_cron(str(changes.get("cron", row["cron"])))
            if not name:
                raise RoutineRefused("A routine needs a name.")
            if row["kind"] == "agent" and not prompt:
                raise RoutineRefused("An agent routine needs a prompt.")
            if len(prompt) > MAX_PROMPT_CHARS:
                raise RoutineRefused(f"Prompts are limited to {MAX_PROMPT_CHARS} characters.")
            enabled = bool(changes.get("enabled", bool(row["enabled"])))
            notify = bool(changes.get("notify", bool(row["notify"])))
            # A new schedule, or switching on, counts from now.
            next_at = row["next_run_at"]
            if cron != row["cron"] or (enabled and not row["enabled"]):
                next_at = self.next_after(cron)
            self._conn.execute(
                "UPDATE routines SET name = ?, prompt = ?, cron = ?, enabled = ?, notify = ?, "
                "updated_at = ?, next_run_at = ? WHERE id = ?",
                (name, prompt, cron, int(enabled), int(notify), _iso(_now()), next_at, routine_id),
            )
            self._conn.commit()
            return self._routine(self._row(routine_id))

    def delete(self, routine_id: int) -> None:
        """Remove an agent routine and its runs. Built-ins can only be disabled."""
        with self._lock:
            row = self._row(routine_id)
            if row["kind"] == "builtin":
                raise RoutineRefused("Built-in routines can be turned off, not deleted.")
            self._conn.execute("DELETE FROM runs WHERE routine_id = ?", (routine_id,))
            self._conn.execute("DELETE FROM routines WHERE id = ?", (routine_id,))
            self._conn.commit()

    def seed_builtins(self) -> None:
        """Add any built-in routine that isn't there yet (switched off)."""
        with self._lock:
            have = {r[0] for r in self._conn.execute("SELECT builtin FROM routines WHERE kind = 'builtin'")}
        for key, spec in BUILTINS.items():
            if key not in have:
                self.add(spec.name, "builtin", spec.cron, builtin=key, enabled=False)

    def due(self, now: datetime | None = None) -> list[dict[str, Any]]:
        """Enabled routines whose next run time has come."""
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM routines WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? "
                "ORDER BY next_run_at, id",
                (_iso(now or _now()),),
            ).fetchall()
            return [self._routine(r) for r in rows]

    def schedule_next(self, routine_id: int, after: datetime | None = None) -> None:
        """Move a routine's next run past ``after`` (default now)."""
        with self._lock:
            row = self._row(routine_id)
            self._conn.execute(
                "UPDATE routines SET next_run_at = ? WHERE id = ?",
                (self.next_after(row["cron"], after), routine_id),
            )
            self._conn.commit()

    # --- runs ----------------------------------------------------------------

    def start_run(self, routine_id: int) -> int:
        """Record that a run started; returns its id."""
        with self._lock:
            self._row(routine_id)
            cur = self._conn.execute(
                "INSERT INTO runs (routine_id, started_at) VALUES (?, ?)", (routine_id, _iso(_now()))
            )
            self._conn.commit()
            return cur.lastrowid

    def finish_run(
        self,
        run_id: int,
        status: str,
        summary: str = "",
        data: Any = None,
        error: str | None = None,
    ) -> dict[str, Any]:
        """Record how a run ended and drop the oldest runs past KEEP_RUNS."""
        with self._lock:
            self._conn.execute(
                "UPDATE runs SET finished_at = ?, status = ?, summary = ?, data = ?, error = ? WHERE id = ?",
                (_iso(_now()), status, summary, json.dumps(data, default=str) if data is not None else None,
                 error, run_id),
            )
            row = self._conn.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
            self._conn.execute(
                "DELETE FROM runs WHERE routine_id = ? AND id NOT IN "
                "(SELECT id FROM runs WHERE routine_id = ? ORDER BY id DESC LIMIT ?)",
                (row["routine_id"], row["routine_id"], KEEP_RUNS),
            )
            self._conn.commit()
            return self._run(row)

    def runs(self, routine_id: int, limit: int = 20) -> list[dict[str, Any]]:
        """A routine's runs, newest first."""
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM runs WHERE routine_id = ? ORDER BY id DESC LIMIT ?", (routine_id, limit)
            ).fetchall()
            return [self._run(r) for r in rows]

    def recent_runs(self, limit: int = 12) -> list[dict[str, Any]]:
        """The newest runs of every routine, with the routine's name."""
        with self._lock:
            rows = self._conn.execute(
                "SELECT runs.*, routines.name AS name, routines.kind AS kind FROM runs "
                "JOIN routines ON routines.id = runs.routine_id ORDER BY runs.id DESC LIMIT ?",
                (limit,),
            ).fetchall()
            return [{**self._run(r), "name": r["name"], "kind": r["kind"]} for r in rows]

    def insights(self) -> dict[str, Any]:
        """The last successful result of each enabled built-in, keyed by its
        key (mail_check, agenda, todos): what the HUD widgets show."""
        out: dict[str, Any] = {}
        with self._lock:
            rows = self._conn.execute(
                "SELECT routines.builtin AS key, runs.* FROM routines JOIN runs ON runs.id = ("
                "  SELECT id FROM runs WHERE routine_id = routines.id AND status = 'ok' ORDER BY id DESC LIMIT 1"
                ") WHERE routines.kind = 'builtin' AND routines.enabled = 1"
            ).fetchall()
            for r in rows:
                out[r["key"]] = self._run(r)
        return out

    # --- usage ---------------------------------------------------------------

    def add_usage(
        self,
        provider: str,
        model: str,
        runs: int = 0,
        model_calls: int = 0,
        tool_calls: int = 0,
        errors: int = 0,
        day: date | None = None,
    ) -> None:
        """Add to today's counters for this provider and model."""
        key = (day or self.local_now().date()).isoformat()
        with self._lock:
            self._conn.execute(
                "INSERT INTO usage (day, provider, model, runs, model_calls, tool_calls, errors) "
                "VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (day, provider, model) DO UPDATE SET "
                "runs = runs + excluded.runs, model_calls = model_calls + excluded.model_calls, "
                "tool_calls = tool_calls + excluded.tool_calls, errors = errors + excluded.errors",
                (key, provider, model, runs, model_calls, tool_calls, errors),
            )
            self._conn.commit()

    def usage(self, days: int = 14) -> dict[str, Any]:
        """Per-day totals for the last ``days`` days (oldest first, gaps as 0)
        and per-provider/model totals over the same window."""
        today = self.local_now().date()
        first = today - timedelta(days=days - 1)
        with self._lock:
            rows = self._conn.execute(
                "SELECT day, SUM(runs) runs, SUM(model_calls) model_calls, SUM(tool_calls) tool_calls, "
                "SUM(errors) errors FROM usage WHERE day >= ? GROUP BY day",
                (first.isoformat(),),
            ).fetchall()
            models = self._conn.execute(
                "SELECT provider, model, SUM(runs) runs, SUM(model_calls) model_calls, "
                "SUM(tool_calls) tool_calls, SUM(errors) errors FROM usage WHERE day >= ? "
                "GROUP BY provider, model ORDER BY model_calls DESC",
                (first.isoformat(),),
            ).fetchall()
        by_day = {r["day"]: dict(r) for r in rows}
        series = []
        for i in range(days):
            key = (first + timedelta(days=i)).isoformat()
            r = by_day.get(key, {})
            series.append({
                "day": key,
                "runs": r.get("runs", 0),
                "model_calls": r.get("model_calls", 0),
                "tool_calls": r.get("tool_calls", 0),
                "errors": r.get("errors", 0),
            })
        return {"days": series, "models": [dict(r) for r in models]}


__all__ = ["KEEP_RUNS", "KINDS", "RoutineRefused", "RoutineStore"]
