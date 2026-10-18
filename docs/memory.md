# Memory

Luna has two kinds of memory.

| | Short-term | Long-term |
| --- | --- | --- |
| What | the conversation, todos, scratchpad notes | facts and preferences about you |
| Scope | one thread | every thread |
| Stored in | `data/luna_memory.sqlite` (checkpoints) | `data/luna_longterm.sqlite` |
| Who changes it | Luna, as she works | **only you**. Luna can only suggest |
| Code | `agent/memory.py`, `agent/scratchpad.py` | `agent/longterm.py` |

The two files are separate, so deleting threads never touches long-term memory.

## How they sync

**Long-term → short-term (read).** Before every model call, the main agent's
system prompt gets a "Long-term memory" block:

1. every **pinned** memory, then
2. the best keyword matches (SQLite FTS5) for your latest message, up to
   `LUNA_MEMORY_RECALL_LIMIT`,

all within `LUNA_MEMORY_PROMPT_CHARS`. Each line has its id, e.g.
`- [m12] (preference) Prefers tea over coffee`. It is read fresh every call,
so an edit applies to the next model call, even in the middle of a thread.
Luna can also search with `recall`.

**Short-term → long-term (suggest).** When Luna learns something lasting
("I moved to Delhi", "my sister is Asha"), she calls:

| Tool | Proposes |
| --- | --- |
| `remember(text, kind)` | a new memory |
| `suggest_update(memory_id, text, reason)` | a correction |
| `suggest_forget(memory_id, reason)` | removing one |

Each one only adds a **suggestion** to your inbox. Nothing changes until you
accept it. Task details stay in the scratchpad and are never promoted.

No extra model calls: retrieval is keyword search, and suggestions are
ordinary tool calls in the same turn.

## Why Luna can't spoil it

- **No write path.** The agent's tools only insert into `suggestions`. The
  `memories` table changes only through your actions (web panel or `/memory`).
- **Guards in code**, before a suggestion is even queued:
  - at most 300 characters
  - nothing that looks like a password, API key, OTP or card number
  - no duplicates of a memory or a pending suggestion
  - nothing you already **declined**
  - at most `LUNA_MEMORY_MAX_SUGGESTIONS` per message
  - update / forget must name a real memory
- **Everything is versioned.** Every add, edit, pin, delete and accepted
  suggestion is logged with the state before and after it. Deletes are
  soft. **Undo** reverts the newest change; repeat it to go further back.
- **Your words win.** You can edit a suggestion's text before accepting it.

## Editing

**Web UI:** press **K** or click MEMORY in the dock. The badge counts
suggestions waiting.

- *Inbox:* ACCEPT, EDIT (then accept), or DECLINE. Updates show the old text first.
- *Saved:* search, + to add, EDIT, PIN (always shown to Luna), DELETE (with
  UNDO), and HISTORY (with UNDO LAST CHANGE).

**CLI:** `/memory help`

```
/memory                    list
/memory search <words>
/memory add [kind:]<text>  e.g. /memory add preference: tea, not coffee
/memory edit <id> <text>
/memory rm <id>
/memory pin <id>           toggle
/memory undo <id>
/memory history <id>
/memory inbox
/memory accept <id> [text]
/memory reject <id>
```

After a reply that added suggestions, the CLI prints
`💡 Luna suggested 1 memory. See /memory inbox.`

Kinds: `fact`, `preference`, `person`, `project`.

## Settings

| Env var | Default | Meaning |
| --- | --- | --- |
| `LUNA_ENABLE_LONGTERM_MEMORY` | `true` | Turn long-term memory on or off |
| `LUNA_LONGTERM_MEMORY_PATH` | `data/luna_longterm.sqlite` | The database file |
| `LUNA_MEMORY_RECALL_LIMIT` | `5` | Keyword matches per message (besides pinned) |
| `LUNA_MEMORY_PROMPT_CHARS` | `1500` | Max characters of memories in the prompt |
| `LUNA_MEMORY_MAX_SUGGESTIONS` | `3` | Max suggestions per message |

## Limits

- Keyword search won't find paraphrases ("drink" won't find "coffee").
  Pin the memories that must always be known, or search with `recall`.
  Embeddings can be added later behind the same store.
- Helpers don't see long-term memory. The main agent passes them the facts
  they need, as it already does for the persona.
- A memory deleted by accepting a "forget" suggestion can be restored with
  `/memory undo <id>`. The web panel only offers UNDO for deletes made there.
