"""
Long-term memory — facts about the user that outlive any one thread.

BEGINNER MAP
------------
Short-term memory (luna/agent/memory.py + scratchpad.py) belongs to one
thread: switch thread and it's gone. Long-term memory is one small SQLite
file (data/luna_longterm.sqlite) shared by every thread:

  memories        what Luna knows ("Prefers tea over coffee"). ONLY the user
                  changes this table: from the web UI Memory panel or the
                  CLI /memory command.
  suggestions     what the agent *proposes*: add / update / forget. Nothing
                  happens until the user accepts one, so the model can never
                  spoil the memories on its own.
  memory_history  every change with the state before and after it, so any
                  change can be undone. Deletes are soft (deleted_at).
  memories_fts    full-text index (SQLite FTS5) for keyword search.

How it reaches the model (long → short):
  LongTermMemoryMiddleware adds a "Long-term memory" block to the main
  agent's system prompt on every model call: pinned memories first, then the
  best keyword matches for the latest user message, within a character cap.
  It reads the table fresh each call, so an edit applies immediately.

How it grows (short → long):
  The agent calls remember / suggest_update / suggest_forget. Each one only
  adds a suggestion, after code-level checks: not too long, not a secret,
  not a duplicate (or something the user already rejected), at most a few
  per user message. recall searches memories (read-only).

No embeddings and no extra model calls: search is keyword-based.

Read next: luna/agent/scratchpad.py (the same middleware pattern).
"""

from __future__ import annotations

import json
import re
import sqlite3
import threading
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from langchain.agents.middleware import AgentMiddleware
from langchain.agents.middleware.types import ModelRequest, ModelResponse
from langchain.tools import ToolRuntime, tool
from langchain_core.messages import SystemMessage

from luna.agent.budget import current_budget

KINDS = ("fact", "preference", "person", "project")
MAX_MEMORY_CHARS = 300

# Text that looks like a credential never becomes a suggestion.
_SECRET_PATTERNS = [
    re.compile(r"\b(password|passwd|passcode|pwd|otp|pin|cvv|api[ _-]?key|secret|token)\b\s*(is|:|=)", re.I),
    re.compile(r"\b(sk|pk|ghp|gho|xox[abp]|AKIA)[-_A-Za-z0-9]{12,}"),
    re.compile(r"\b[A-Za-z0-9+/_-]{32,}\b"),  # long random-looking strings
    re.compile(r"\b(?:\d[ -]?){13,19}\b"),  # card numbers
]

# Common words dropped from search queries (they match everything).
_STOPWORDS = frozenset(
    "a an and are as at be but by can could did do does for from had has have he her his how i "
    "if in is it its me my of on or our please she so that the their them then there these they "
    "this to was we were what when where which who why will with would you your yes no not luna "
    "about tell know just like get want".split()
)
_MAX_QUERY_TERMS = 12

_SCHEMA = """
CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY,
    text TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'fact',
    pinned INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
);
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
    text, content='memories', content_rowid='id'
);
CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE OF text ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, text) VALUES ('delete', old.id, old.text);
    INSERT INTO memories_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TABLE IF NOT EXISTS memory_history (
    id INTEGER PRIMARY KEY,
    memory_id INTEGER NOT NULL,
    action TEXT NOT NULL,
    before TEXT,
    after TEXT,
    source TEXT NOT NULL,
    at TEXT NOT NULL,
    undone INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS suggestions (
    id INTEGER PRIMARY KEY,
    action TEXT NOT NULL,
    target_id INTEGER,
    text TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL DEFAULT 'fact',
    reason TEXT NOT NULL DEFAULT '',
    thread_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL
);
"""


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def normalize(text: str) -> str:
    """Comparison form: lower case, single spaces, no trailing punctuation."""
    return " ".join(text.lower().split()).rstrip(".!?;, ")


def looks_secret(text: str) -> bool:
    return any(p.search(text) for p in _SECRET_PATTERNS)


def fts_query(text: str) -> str:
    """Turn free text into a safe FTS5 query: quoted words joined by OR.

    Quoting every word means punctuation, quotes or FTS keywords in the
    user's message can never break the query. Longer words also match as a
    prefix ("coffee" finds "coffees"). '' when nothing is worth searching.
    """
    terms: list[str] = []
    for word in re.findall(r"\w+", text.lower()):
        if len(word) < 2 or word in _STOPWORDS or word in terms:
            continue
        terms.append(word)
    parts = [f'"{w}"*' if len(w) >= 4 else f'"{w}"' for w in terms[:_MAX_QUERY_TERMS]]
    return " OR ".join(parts)


class MemoryRefused(ValueError):
    """A memory operation the store refuses (unknown id, empty text, ...)."""


class LongTermStore:
    """The long-term memory database.

    Plain ``sqlite3`` (every query is local and takes well under a
    millisecond), shared across threads behind a lock, because LangGraph
    runs sync tools in worker threads.
    """

    def __init__(self, path: Path | str = ":memory:") -> None:
        if str(path) != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._lock = threading.Lock()
        with self._lock:
            self._conn.executescript(_SCHEMA)
            self._conn.commit()

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    # --- reading -------------------------------------------------------------

    def _row(self, memory_id: int, include_deleted: bool = False) -> sqlite3.Row:
        row = self._conn.execute("SELECT * FROM memories WHERE id = ?", (memory_id,)).fetchone()
        if row is None or (row["deleted_at"] and not include_deleted):
            raise MemoryRefused(f"No memory m{memory_id}.")
        return row

    @staticmethod
    def _as_dict(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": row["id"],
            "text": row["text"],
            "kind": row["kind"],
            "pinned": bool(row["pinned"]),
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }

    def get(self, memory_id: int) -> dict[str, Any]:
        with self._lock:
            return self._as_dict(self._row(memory_id))

    def list(self) -> list[dict[str, Any]]:
        """Every active memory: pinned first, then newest first."""
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM memories WHERE deleted_at IS NULL ORDER BY pinned DESC, updated_at DESC, id DESC"
            ).fetchall()
        return [self._as_dict(r) for r in rows]

    def search(self, text: str, limit: int = 5) -> list[dict[str, Any]]:
        """Active memories matching the words in ``text``, best first."""
        query = fts_query(text)
        if not query or limit <= 0:
            return []
        with self._lock:
            rows = self._conn.execute(
                "SELECT m.* FROM memories_fts JOIN memories m ON m.id = memories_fts.rowid "
                "WHERE memories_fts MATCH ? AND m.deleted_at IS NULL ORDER BY bm25(memories_fts) LIMIT ?",
                (query, limit),
            ).fetchall()
        return [self._as_dict(r) for r in rows]

    def pinned(self) -> list[dict[str, Any]]:
        return [m for m in self.list() if m["pinned"]]

    def history(self, memory_id: int) -> list[dict[str, Any]]:
        """Changes to one memory, newest first (undone ones included, marked)."""
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM memory_history WHERE memory_id = ? ORDER BY id DESC", (memory_id,)
            ).fetchall()
        return [
            {
                "action": r["action"],
                "before": json.loads(r["before"]) if r["before"] else None,
                "after": json.loads(r["after"]) if r["after"] else None,
                "source": r["source"],
                "at": r["at"],
                "undone": bool(r["undone"]),
            }
            for r in rows
        ]

    # --- user changes (the only way the memories table changes) ---------------

    @staticmethod
    def _snapshot(row: sqlite3.Row | None) -> str | None:
        if row is None:
            return None
        return json.dumps({k: row[k] for k in ("text", "kind", "pinned", "deleted_at")})

    def _log(self, memory_id: int, action: str, before: str | None, source: str) -> None:
        after = self._snapshot(self._row(memory_id, include_deleted=True))
        self._conn.execute(
            "INSERT INTO memory_history (memory_id, action, before, after, source, at) VALUES (?, ?, ?, ?, ?, ?)",
            (memory_id, action, before, after, source, _now()),
        )

    @staticmethod
    def _clean(text: str, kind: str) -> tuple[str, str]:
        text = " ".join(text.split())
        if not text:
            raise MemoryRefused("Memory text can't be empty.")
        if len(text) > MAX_MEMORY_CHARS:
            raise MemoryRefused(f"Keep a memory under {MAX_MEMORY_CHARS} characters.")
        kind = kind.strip().lower() or "fact"
        if kind not in KINDS:
            raise MemoryRefused(f"Kind must be one of: {', '.join(KINDS)}.")
        return text, kind

    def add(self, text: str, kind: str = "fact", pinned: bool = False, source: str = "user") -> dict[str, Any]:
        text, kind = self._clean(text, kind)
        with self._lock:
            now = _now()
            cur = self._conn.execute(
                "INSERT INTO memories (text, kind, pinned, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
                (text, kind, int(pinned), now, now),
            )
            memory_id = cur.lastrowid
            self._log(memory_id, "add", None, source)
            self._conn.commit()
            return self._as_dict(self._row(memory_id))

    def edit(
        self,
        memory_id: int,
        text: str | None = None,
        kind: str | None = None,
        pinned: bool | None = None,
        source: str = "user",
    ) -> dict[str, Any]:
        with self._lock:
            row = self._row(memory_id)
            new_text, new_kind = self._clean(
                row["text"] if text is None else text, row["kind"] if kind is None else kind
            )
            new_pinned = row["pinned"] if pinned is None else int(pinned)
            if (new_text, new_kind, new_pinned) == (row["text"], row["kind"], row["pinned"]):
                return self._as_dict(row)
            self._conn.execute(
                "UPDATE memories SET text = ?, kind = ?, pinned = ?, updated_at = ? WHERE id = ?",
                (new_text, new_kind, new_pinned, _now(), memory_id),
            )
            action = "edit" if (new_text, new_kind) != (row["text"], row["kind"]) else (
                "pin" if new_pinned else "unpin"
            )
            self._log(memory_id, action, self._snapshot(row), source)
            self._conn.commit()
            return self._as_dict(self._row(memory_id))

    def delete(self, memory_id: int, source: str = "user") -> None:
        with self._lock:
            row = self._row(memory_id)
            self._conn.execute("UPDATE memories SET deleted_at = ? WHERE id = ?", (_now(), memory_id))
            self._log(memory_id, "delete", self._snapshot(row), source)
            self._conn.commit()

    def undo(self, memory_id: int) -> dict[str, Any] | None:
        """Revert the newest change to a memory (again = one step further back).

        Returns the memory as it is now, or None if undoing removed it
        (undoing its "add").
        """
        with self._lock:
            entry = self._conn.execute(
                "SELECT * FROM memory_history WHERE memory_id = ? AND undone = 0 ORDER BY id DESC LIMIT 1",
                (memory_id,),
            ).fetchone()
            if entry is None:
                raise MemoryRefused(f"Nothing to undo for m{memory_id}.")
            before = json.loads(entry["before"]) if entry["before"] else None
            if before is None:  # undoing the add: hide it again
                self._conn.execute(
                    "UPDATE memories SET deleted_at = ?, updated_at = ? WHERE id = ?", (_now(), _now(), memory_id)
                )
            else:
                self._conn.execute(
                    "UPDATE memories SET text = ?, kind = ?, pinned = ?, deleted_at = ?, updated_at = ? WHERE id = ?",
                    (before["text"], before["kind"], before["pinned"], before["deleted_at"], _now(), memory_id),
                )
            self._conn.execute("UPDATE memory_history SET undone = 1 WHERE id = ?", (entry["id"],))
            self._conn.commit()
            row = self._row(memory_id, include_deleted=True)
            return None if row["deleted_at"] else self._as_dict(row)

    # --- suggestions (the agent's only way in) ----------------------------------

    def _suggestion_dict(self, row: sqlite3.Row) -> dict[str, Any]:
        target = None
        if row["target_id"] is not None:
            t = self._conn.execute("SELECT text FROM memories WHERE id = ?", (row["target_id"],)).fetchone()
            target = t["text"] if t else None
        return {
            "id": row["id"],
            "action": row["action"],
            "target_id": row["target_id"],
            "target_text": target,
            "text": row["text"],
            "kind": row["kind"],
            "reason": row["reason"],
            "thread_id": row["thread_id"],
            "created_at": row["created_at"],
        }

    def suggestions(self) -> list[dict[str, Any]]:
        """Pending suggestions, oldest first."""
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM suggestions WHERE status = 'pending' ORDER BY id"
            ).fetchall()
            return [self._suggestion_dict(r) for r in rows]

    def pending_count(self) -> int:
        with self._lock:
            return self._conn.execute("SELECT COUNT(*) FROM suggestions WHERE status = 'pending'").fetchone()[0]

    def suggest(
        self,
        action: str,
        text: str = "",
        kind: str = "fact",
        target_id: int | None = None,
        reason: str = "",
        thread_id: str | None = None,
    ) -> dict[str, Any]:
        """Queue a proposal for the user. Raises MemoryRefused when a guard refuses it."""
        if action not in {"add", "update", "forget"}:
            raise MemoryRefused(f"Unknown suggestion action {action!r}.")
        if action == "forget":
            text, kind = "", "fact"
        else:
            text, kind = self._clean(text, kind)
            if looks_secret(text):
                raise MemoryRefused("That looks like a password, key or number to keep private; not saved.")
        reason = " ".join(reason.split())[:200]
        with self._lock:
            if action != "add":
                if target_id is None:
                    raise MemoryRefused("Give the id of the memory to change, e.g. 12 for [m12].")
                target = self._row(target_id)
                if action == "update" and normalize(text) == normalize(target["text"]):
                    raise MemoryRefused(f"m{target_id} already says that.")
            if action != "forget":
                key = normalize(text)
                known = self._conn.execute("SELECT text FROM memories WHERE deleted_at IS NULL").fetchall()
                if any(normalize(r["text"]) == key for r in known):
                    raise MemoryRefused("Already in long-term memory.")
            # Same proposal already waiting, or already rejected by the user.
            earlier = self._conn.execute(
                "SELECT status, text FROM suggestions WHERE action = ? AND target_id IS ? "
                "AND status IN ('pending', 'rejected')",
                (action, target_id),
            ).fetchall()
            for row in earlier:
                if normalize(row["text"]) == normalize(text):
                    raise MemoryRefused(
                        "Already waiting in the user's inbox." if row["status"] == "pending"
                        else "The user already declined this; don't suggest it again."
                    )
            cur = self._conn.execute(
                "INSERT INTO suggestions (action, target_id, text, kind, reason, thread_id, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (action, target_id, text, kind, reason, thread_id, _now()),
            )
            self._conn.commit()
            row = self._conn.execute("SELECT * FROM suggestions WHERE id = ?", (cur.lastrowid,)).fetchone()
            return self._suggestion_dict(row)

    def _pending(self, suggestion_id: int) -> sqlite3.Row:
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM suggestions WHERE id = ? AND status = 'pending'", (suggestion_id,)
            ).fetchone()
        if row is None:
            raise MemoryRefused(f"No pending suggestion s{suggestion_id}.")
        return row

    def _set_status(self, suggestion_id: int, status: str) -> None:
        with self._lock:
            self._conn.execute("UPDATE suggestions SET status = ? WHERE id = ?", (status, suggestion_id))
            self._conn.commit()

    def accept(self, suggestion_id: int, text: str | None = None) -> dict[str, Any] | None:
        """Apply a suggestion (optionally with the user's own wording).

        Returns the memory it created or changed (None for a forget).
        """
        row = self._pending(suggestion_id)
        source = f"suggestion s{suggestion_id}"
        new_text = row["text"] if text is None or not text.strip() else text
        if row["action"] == "add":
            result = self.add(new_text, row["kind"], source=source)
        elif row["action"] == "update":
            result = self.edit(row["target_id"], text=new_text, source=source)
        else:
            self.delete(row["target_id"], source=source)
            result = None
        self._set_status(suggestion_id, "accepted")
        return result

    def reject(self, suggestion_id: int) -> None:
        self._pending(suggestion_id)
        self._set_status(suggestion_id, "rejected")


# --- prompt ----------------------------------------------------------------------

MEMORY_PROMPT = """
## Long-term memory

These are facts the user saved in earlier conversations. They may be out of date:
what the user says now wins.
To save something lasting (a preference, a fact about the user or people and
projects in their life), call `remember`; to correct or drop a memory, call
`suggest_update` / `suggest_forget` with its id. These go to the user's memory
inbox and are saved only if they accept, so mention it in a few words.
Don't save task details, one-off requests, or anything secret.
""".strip()


def render_memories(memories: list[dict[str, Any]], max_chars: int) -> str:
    """Memory lines for the prompt, stopping before ``max_chars``."""
    lines: list[str] = []
    used = 0
    for m in memories:
        line = f"- [m{m['id']}] ({m['kind']}) {m['text']}"
        if used + len(line) > max_chars:
            break
        lines.append(line)
        used += len(line) + 1
    return "\n".join(lines)


def _latest_user_text(messages: list[Any]) -> str:
    for message in reversed(messages):
        if getattr(message, "type", None) == "human":
            return message.text
    return ""


def relevant_memories(store: LongTermStore, query: str, limit: int) -> list[dict[str, Any]]:
    """Pinned memories, then the best matches for ``query`` (no repeats)."""
    chosen = store.pinned()
    seen = {m["id"] for m in chosen}
    for m in store.search(query, limit):
        if m["id"] not in seen:
            chosen.append(m)
            seen.add(m["id"])
    return chosen


# --- tools -----------------------------------------------------------------------

def _thread_id(runtime: ToolRuntime | None) -> str | None:
    config = getattr(runtime, "config", None) or {}
    return config.get("configurable", {}).get("thread_id")


def make_memory_tools(store: LongTermStore, max_suggestions: int = 3) -> list[Any]:
    """recall (read-only) + remember / suggest_update / suggest_forget (suggest only)."""

    def _suggest(runtime: ToolRuntime | None, **kwargs: Any) -> str:
        budget = current_budget.get()
        if budget is not None and budget.memory_suggestions >= max_suggestions:
            return f"Not suggested: at most {max_suggestions} memory suggestions per message."
        try:
            s = store.suggest(thread_id=_thread_id(runtime), **kwargs)
        except MemoryRefused as exc:
            return f"Not suggested: {exc}"
        if budget is not None:
            budget.memory_suggestions += 1
        return f"Added to the user's memory inbox as s{s['id']}. It is saved only if they accept it."

    @tool
    def recall(query: str) -> str:
        """Search the user's long-term memory for saved facts and preferences.

        Args:
            query: Words to look for, e.g. 'coffee' or 'sister birthday'.
        """
        found = store.search(query, limit=8)
        if not found:
            return "Nothing in long-term memory matches."
        return "\n".join(f"[m{m['id']}] ({m['kind']}) {m['text']}" for m in found)

    @tool
    def remember(text: str, kind: str = "fact", runtime: ToolRuntime = None) -> str:
        """Suggest a new long-term memory about the user. The user approves it later.

        Args:
            text: One short, self-contained statement, e.g. 'Prefers tea over coffee'.
            kind: 'fact', 'preference', 'person' or 'project'.
        """
        return _suggest(runtime, action="add", text=text, kind=kind)

    @tool
    def suggest_update(memory_id: int, text: str, reason: str = "", runtime: ToolRuntime = None) -> str:
        """Suggest a correction to an existing long-term memory. The user approves it later.

        Args:
            memory_id: The number of the memory, e.g. 12 for [m12].
            text: The full corrected statement.
            reason: Why it should change (shown to the user).
        """
        return _suggest(runtime, action="update", target_id=memory_id, text=text, reason=reason)

    @tool
    def suggest_forget(memory_id: int, reason: str = "", runtime: ToolRuntime = None) -> str:
        """Suggest deleting a long-term memory that is wrong or outdated. The user approves it later.

        Args:
            memory_id: The number of the memory, e.g. 12 for [m12].
            reason: Why it should go (shown to the user).
        """
        return _suggest(runtime, action="forget", target_id=memory_id, reason=reason)

    return [recall, remember, suggest_update, suggest_forget]


class LongTermMemoryMiddleware(AgentMiddleware):
    """Adds the memory tools, and shows relevant memories on every model call.

    Main agent only: helpers get the facts they need in the task text.
    """

    def __init__(
        self,
        store: LongTermStore,
        recall_limit: int = 5,
        max_chars: int = 1500,
        max_suggestions: int = 3,
    ) -> None:
        super().__init__()
        self.store = store
        self.recall_limit = recall_limit
        self.max_chars = max_chars
        self.tools = make_memory_tools(store, max_suggestions)

    def _with_memories(self, request: ModelRequest) -> ModelRequest:
        query = _latest_user_text(request.state.get("messages", []))
        memories = relevant_memories(self.store, query, self.recall_limit)
        text = MEMORY_PROMPT
        lines = render_memories(memories, self.max_chars)
        text += "\n\n" + (f"What you know about the user:\n{lines}" if lines else "(No saved memories match yet.)")
        blocks = request.system_message.content_blocks if request.system_message else []
        return request.override(
            system_message=SystemMessage(content=[*blocks, {"type": "text", "text": f"\n\n{text}"}])
        )

    def wrap_model_call(
        self, request: ModelRequest, handler: Callable[[ModelRequest], ModelResponse]
    ) -> ModelResponse:
        return handler(self._with_memories(request))

    async def awrap_model_call(
        self, request: ModelRequest, handler: Callable[[ModelRequest], Awaitable[ModelResponse]]
    ) -> ModelResponse:
        return await handler(self._with_memories(request))


def open_longterm_store(settings: Any) -> LongTermStore | None:
    """The store from settings, or None when long-term memory is off."""
    if not settings.enable_longterm_memory:
        return None
    return LongTermStore(settings.longterm_memory_path)


__all__ = [
    "KINDS",
    "LongTermMemoryMiddleware",
    "LongTermStore",
    "MemoryRefused",
    "fts_query",
    "looks_secret",
    "make_memory_tools",
    "normalize",
    "open_longterm_store",
    "relevant_memories",
    "render_memories",
]
