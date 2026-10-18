# Spec 5 — Long-term memory

**Date:** 2026-10-18  
**Status:** Implemented.  
**Scope:** Memory that outlives threads, editable by the user, which the agent can't change on its own.

Builds on [spec3](spec3.md) §9 (which this replaces) and [spec4](spec4.md) (web UI).
Decision: [`DECISIONS.md`](../DECISIONS.md) D29. User guide: [`docs/memory.md`](../docs/memory.md).

---

## 1. Goal

- Luna remembers lasting facts and preferences across threads.
- The user can see, search, add, edit, pin, delete and undo them (web + CLI).
- Short-term memory feeds long-term memory only through the user's approval.
  The model can never corrupt what is stored.
- No extra model calls per message.

## 2. Shape

```
 thread (short-term)                         long-term (data/luna_longterm.sqlite)
┌──────────────────────────┐   remember /   ┌─────────────────────────────────────┐
│ messages, todos, notes   │ suggest_update │ suggestions (pending/accepted/       │
│ (checkpointer)           │ suggest_forget │              rejected)               │
│                          │ ─────────────▶ │        │ user: accept / reject       │
│ main agent system prompt │                │        ▼   (web panel, /memory)      │
│  + "Long-term memory"    │ ◀───────────── │ memories ──▶ memory_history          │
│    block (pinned + FTS)  │  every model   │   (+ memories_fts)  (before/after,   │
│                          │  call (fresh)  │                      undo)           │
└──────────────────────────┘                └─────────────────────────────────────┘
```

## 3. Data

| Table | Columns | Notes |
| --- | --- | --- |
| `memories` | id, text, kind, pinned, created_at, updated_at, deleted_at | kinds: fact, preference, person, project. Soft delete |
| `memories_fts` | FTS5 over text | kept in sync by triggers |
| `memory_history` | memory_id, action, before, after, source, at, undone | JSON snapshots; source = `user` or `suggestion s<id>` |
| `suggestions` | action (add/update/forget), target_id, text, kind, reason, thread_id, status, created_at | status: pending, accepted, rejected |

## 4. Rules

1. Only user actions change `memories`: `add`, `edit`, `delete`, `undo`, `accept`.
2. Agent tools: `recall` (read), `remember`, `suggest_update`, `suggest_forget` (queue only).
3. A suggestion is refused (and the tool result says why) when it is:
   - over 300 chars
   - secret-looking
   - a duplicate of a memory or of a pending suggestion
   - something the user declined before
   - over the per-message cap (3)
   - an update or forget for an unknown id
4. Undo reverts the newest non-undone history entry. Undoing an add hides the memory.
5. Prompt block: `MEMORY_PROMPT` instructions, then pinned memories, then the
   top `memory_recall_limit` FTS matches for the latest human message, ≤
   `memory_prompt_chars`. Main agent only.
6. FTS queries are built from the message's words, each quoted (words of 4+
   letters as prefixes), minus stopwords, so user text never breaks FTS syntax.

## 5. Interfaces

- **Web:** MEMORY dock button with an inbox badge, and the **K** key. `MemoryPanel` has two tabs:
  - Inbox: accept, edit + accept, decline
  - Saved: search, add, edit, pin, delete + undo, history + undo

  Socket messages are listed in `docs/web-ui.md`. Memory failures are
  `memory_error`, so they never end a run in the UI.
- **CLI:** `/memory [list|search|add|edit|rm|pin|undo|history|inbox|accept|reject]`.
  After a turn that queued suggestions, the CLI prints a hint.

## 6. Settings

`LUNA_ENABLE_LONGTERM_MEMORY`, `LUNA_LONGTERM_MEMORY_PATH`,
`LUNA_MEMORY_RECALL_LIMIT`, `LUNA_MEMORY_PROMPT_CHARS`,
`LUNA_MEMORY_MAX_SUGGESTIONS`.

## 7. Tests

- `tests/test_longterm.py`:
  - store, undo and search
  - guards
  - prompt injection and edits applying on the next call
  - agent tools never changing `memories`
  - the per-message cap
- `tests/test_web.py`: memory socket messages and the inbox from a run.
- `tests/test_cli.py`: `/memory`.
- `web/src/lib/state.test.ts`: the memory reducer.

## 8. Later

Semantic search (local embeddings) behind the same `LongTermStore.search`,
and import/export of memories as Markdown.
