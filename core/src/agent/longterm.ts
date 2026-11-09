/**
 * Long-term memory — facts about the user that outlive any one thread.
 *
 * BEGINNER MAP
 * ------------
 * Short-term memory (agent/memory.ts + scratchpad.ts) belongs to one
 * thread: switch thread and it's gone. Long-term memory is one small SQLite
 * file (data/luna_longterm.sqlite) shared by every thread:
 *
 *   memories        what Luna knows ("Prefers tea over coffee"). ONLY the user
 *                   changes this table: from the web UI Memory panel or the
 *                   CLI /memory command.
 *   suggestions     what the agent *proposes*: add / update / forget. Nothing
 *                   happens until the user accepts one, so the model can never
 *                   spoil the memories on its own.
 *   memory_history  every change with the state before and after it, so any
 *                   change can be undone. Deletes are soft (deleted_at).
 *   memories_fts    full-text index (SQLite FTS5) for keyword search.
 *
 * How it reaches the model (long → short):
 *   longTermMemoryMiddleware adds a "Long-term memory" block to the main
 *   agent's system prompt on every model call: pinned memories first, then the
 *   best keyword matches for the latest user message, within a character cap.
 *   It reads the table fresh each call, so an edit applies immediately.
 *
 * How it grows (short → long):
 *   The agent calls remember / suggest_update / suggest_forget. Each one only
 *   adds a suggestion, after code-level checks: not too long, not a secret,
 *   not a duplicate (or something the user already rejected), at most a few
 *   per user message. recall searches memories (read-only).
 *
 * No embeddings and no extra model calls: search is keyword-based.
 *
 * The schema is the same as the Python version's, so an existing
 * data/luna_longterm.sqlite keeps working.
 *
 * Read next: agent/scratchpad.ts (the same middleware pattern).
 */

import { mkdirSync } from "node:fs";
import path from "node:path";

import type { BaseMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import Database from "better-sqlite3";
import { createMiddleware } from "langchain";
import * as z from "zod";

import type { Settings } from "../config/settings.ts";
import type { AnyTool } from "../tools/registry.ts";
import { threadIdOf } from "../tools/runtime.ts";
import { currentBudget } from "./budget.ts";
import { appendSystemText } from "./scratchpad.ts";

export const KINDS = ["fact", "preference", "person", "project"] as const;
export const MAX_MEMORY_CHARS = 300;

// Text that looks like a credential never becomes a suggestion.
const SECRET_PATTERNS = [
  /\b(password|passwd|passcode|pwd|otp|pin|cvv|api[ _-]?key|secret|token)\b\s*(is|:|=)/i,
  /\b(sk|pk|ghp|gho|xox[abp]|AKIA)[-_A-Za-z0-9]{12,}/,
  /\b[A-Za-z0-9+/_-]{32,}\b/, // long random-looking strings
  /\b(?:\d[ -]?){13,19}\b/, // card numbers
];

// Common words dropped from search queries (they match everything).
const STOPWORDS = new Set(
  ("a an and are as at be but by can could did do does for from had has have he her his how i " +
    "if in is it its me my of on or our please she so that the their them then there these they " +
    "this to was we were what when where which who why will with would you your yes no not luna " +
    "about tell know just like get want").split(" "),
);
const MAX_QUERY_TERMS = 12;

const SCHEMA = `
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
`;

/** UTC time like Python's isoformat(timespec="seconds"): 2026-11-09T10:00:00+00:00 */
export function nowIso(date = new Date()): string {
  return date.toISOString().slice(0, 19) + "+00:00";
}

const squash = (text: string) => text.split(/\s+/).filter(Boolean).join(" ");

/** Comparison form: lower case, single spaces, no trailing punctuation. */
export function normalize(text: string): string {
  return squash(text.toLowerCase()).replace(/[.!?;, ]+$/, "");
}

/** True if the text looks like a password, API key or token (never stored). */
export function looksSecret(text: string): boolean {
  return SECRET_PATTERNS.some((p) => p.test(text));
}

/**
 * Turn free text into a safe FTS5 query: quoted words joined by OR.
 *
 * Quoting every word means punctuation, quotes or FTS keywords in the
 * user's message can never break the query. Longer words also match as a
 * prefix ("coffee" finds "coffees"). '' when nothing is worth searching.
 */
export function ftsQuery(text: string): string {
  const terms: string[] = [];
  for (const word of text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []) {
    if ([...word].length < 2 || STOPWORDS.has(word) || terms.includes(word)) continue;
    terms.push(word);
  }
  return terms.slice(0, MAX_QUERY_TERMS).map((w) => ([...w].length >= 4 ? `"${w}"*` : `"${w}"`)).join(" OR ");
}

/** A memory operation the store refuses (unknown id, empty text, ...). */
export class MemoryRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryRefused";
  }
}

export interface Memory {
  id: number;
  text: string;
  kind: string;
  pinned: boolean;
  created_at: string;
  updated_at: string;
}

export interface Suggestion {
  id: number;
  action: string;
  target_id: number | null;
  target_text: string | null;
  text: string;
  kind: string;
  reason: string;
  thread_id: string | null;
  created_at: string;
}

export interface HistoryEntry {
  action: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  source: string;
  at: string;
  undone: boolean;
}

type Row = Record<string, any>;

/**
 * The long-term memory database.
 *
 * Synchronous better-sqlite3: every query is local and takes well under a
 * millisecond, and Node runs one thing at a time, so no lock is needed.
 */
export class LongTermStore {
  readonly db: Database.Database;

  constructor(file = ":memory:") {
    if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.exec(SCHEMA);
  }

  /** Close the database connection. */
  close(): void {
    this.db.close();
  }

  // --- reading -------------------------------------------------------------

  #row(memoryId: number, includeDeleted = false): Row {
    const row = this.db.prepare("SELECT * FROM memories WHERE id = ?").get(memoryId) as Row | undefined;
    if (!row || (row.deleted_at && !includeDeleted)) throw new MemoryRefused(`No memory m${memoryId}.`);
    return row;
  }

  static #asMemory(row: Row): Memory {
    return {
      id: row.id,
      text: row.text,
      kind: row.kind,
      pinned: Boolean(row.pinned),
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  /** One saved memory by id; MemoryRefused if missing or deleted. */
  get(memoryId: number): Memory {
    return LongTermStore.#asMemory(this.#row(memoryId));
  }

  /** Every active memory: pinned first, then newest first. */
  list(): Memory[] {
    const rows = this.db
      .prepare("SELECT * FROM memories WHERE deleted_at IS NULL ORDER BY pinned DESC, updated_at DESC, id DESC")
      .all() as Row[];
    return rows.map(LongTermStore.#asMemory);
  }

  /** Active memories matching the words in `text`, best first. */
  search(text: string, limit = 5): Memory[] {
    const query = ftsQuery(text);
    if (!query || limit <= 0) return [];
    const rows = this.db
      .prepare(
        "SELECT m.* FROM memories_fts JOIN memories m ON m.id = memories_fts.rowid " +
          "WHERE memories_fts MATCH ? AND m.deleted_at IS NULL ORDER BY bm25(memories_fts) LIMIT ?",
      )
      .all(query, limit) as Row[];
    return rows.map(LongTermStore.#asMemory);
  }

  /** Pinned memories, which are always shown to the model. */
  pinned(): Memory[] {
    return this.list().filter((m) => m.pinned);
  }

  /** Changes to one memory, newest first (undone ones included, marked). */
  history(memoryId: number): HistoryEntry[] {
    const rows = this.db.prepare("SELECT * FROM memory_history WHERE memory_id = ? ORDER BY id DESC").all(memoryId) as Row[];
    return rows.map((r) => ({
      action: r.action,
      before: r.before ? JSON.parse(r.before) : null,
      after: r.after ? JSON.parse(r.after) : null,
      source: r.source,
      at: r.at,
      undone: Boolean(r.undone),
    }));
  }

  // --- user changes (the only way the memories table changes) ---------------

  static #snapshot(row: Row | null): string | null {
    if (!row) return null;
    // Only ever parsed back (undo, history), so Python-written rows still read fine.
    return JSON.stringify({ text: row.text, kind: row.kind, pinned: row.pinned, deleted_at: row.deleted_at ?? null });
  }

  #log(memoryId: number, action: string, before: string | null, source: string): void {
    const after = LongTermStore.#snapshot(this.#row(memoryId, true));
    this.db
      .prepare("INSERT INTO memory_history (memory_id, action, before, after, source, at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(memoryId, action, before, after, source, nowIso());
  }

  static #clean(text: string, kind: string): [string, string] {
    text = squash(text);
    if (!text) throw new MemoryRefused("Memory text can't be empty.");
    if ([...text].length > MAX_MEMORY_CHARS) throw new MemoryRefused(`Keep a memory under ${MAX_MEMORY_CHARS} characters.`);
    kind = kind.trim().toLowerCase() || "fact";
    if (!(KINDS as readonly string[]).includes(kind)) throw new MemoryRefused(`Kind must be one of: ${KINDS.join(", ")}.`);
    return [text, kind];
  }

  /** Save a new memory and log it in its history. */
  add(text: string, kind = "fact", pinned = false, source = "user"): Memory {
    [text, kind] = LongTermStore.#clean(text, kind);
    return this.db.transaction(() => {
      const now = nowIso();
      const info = this.db
        .prepare("INSERT INTO memories (text, kind, pinned, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
        .run(text, kind, pinned ? 1 : 0, now, now);
      const id = Number(info.lastInsertRowid);
      this.#log(id, "add", null, source);
      return LongTermStore.#asMemory(this.#row(id));
    })();
  }

  /** Change a memory's text, kind or pin (undefined = keep); logged for undo. */
  edit(memoryId: number, changes: { text?: string | null; kind?: string | null; pinned?: boolean | null } = {}, source = "user"): Memory {
    return this.db.transaction(() => {
      const row = this.#row(memoryId);
      const [newText, newKind] = LongTermStore.#clean(changes.text ?? row.text, changes.kind ?? row.kind);
      const newPinned = changes.pinned === undefined || changes.pinned === null ? row.pinned : changes.pinned ? 1 : 0;
      if (newText === row.text && newKind === row.kind && newPinned === row.pinned) return LongTermStore.#asMemory(row);
      this.db
        .prepare("UPDATE memories SET text = ?, kind = ?, pinned = ?, updated_at = ? WHERE id = ?")
        .run(newText, newKind, newPinned, nowIso(), memoryId);
      const action = newText !== row.text || newKind !== row.kind ? "edit" : newPinned ? "pin" : "unpin";
      this.#log(memoryId, action, LongTermStore.#snapshot(row), source);
      return LongTermStore.#asMemory(this.#row(memoryId));
    })();
  }

  /** Soft-delete a memory; `undo` brings it back. */
  delete(memoryId: number, source = "user"): void {
    this.db.transaction(() => {
      const row = this.#row(memoryId);
      this.db.prepare("UPDATE memories SET deleted_at = ? WHERE id = ?").run(nowIso(), memoryId);
      this.#log(memoryId, "delete", LongTermStore.#snapshot(row), source);
    })();
  }

  /**
   * Revert the newest change to a memory (again = one step further back).
   *
   * Returns the memory as it is now, or null if undoing removed it (undoing
   * its "add").
   */
  undo(memoryId: number): Memory | null {
    return this.db.transaction(() => {
      const entry = this.db
        .prepare("SELECT * FROM memory_history WHERE memory_id = ? AND undone = 0 ORDER BY id DESC LIMIT 1")
        .get(memoryId) as Row | undefined;
      if (!entry) throw new MemoryRefused(`Nothing to undo for m${memoryId}.`);
      const before = entry.before ? JSON.parse(entry.before) : null;
      const now = nowIso();
      if (before === null) {
        // undoing the add: hide it again
        this.db.prepare("UPDATE memories SET deleted_at = ?, updated_at = ? WHERE id = ?").run(now, now, memoryId);
      } else {
        this.db
          .prepare("UPDATE memories SET text = ?, kind = ?, pinned = ?, deleted_at = ?, updated_at = ? WHERE id = ?")
          .run(before.text, before.kind, before.pinned, before.deleted_at, now, memoryId);
      }
      this.db.prepare("UPDATE memory_history SET undone = 1 WHERE id = ?").run(entry.id);
      const row = this.#row(memoryId, true);
      return row.deleted_at ? null : LongTermStore.#asMemory(row);
    })();
  }

  // --- suggestions (the agent's only way in) ----------------------------------

  #suggestion(row: Row): Suggestion {
    let target: string | null = null;
    if (row.target_id !== null && row.target_id !== undefined) {
      const t = this.db.prepare("SELECT text FROM memories WHERE id = ?").get(row.target_id) as Row | undefined;
      target = t ? t.text : null;
    }
    return {
      id: row.id,
      action: row.action,
      target_id: row.target_id ?? null,
      target_text: target,
      text: row.text,
      kind: row.kind,
      reason: row.reason,
      thread_id: row.thread_id ?? null,
      created_at: row.created_at,
    };
  }

  /** Pending suggestions, oldest first. */
  suggestions(): Suggestion[] {
    const rows = this.db.prepare("SELECT * FROM suggestions WHERE status = 'pending' ORDER BY id").all() as Row[];
    return rows.map((r) => this.#suggestion(r));
  }

  /** How many suggestions are waiting for the user. */
  pendingCount(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM suggestions WHERE status = 'pending'").get() as Row).n;
  }

  /** Counts for the Control Center: active memories by kind, pinned, deleted
   * (still undoable), pending suggestions, and history entries. */
  stats(): { total: number; by_kind: Record<string, number>; pinned: number; deleted: number; pending: number; changes: number } {
    const byKind = Object.fromEntries(
      (this.db.prepare("SELECT kind, COUNT(*) AS n FROM memories WHERE deleted_at IS NULL GROUP BY kind").all() as Row[]).map(
        (r) => [r.kind, r.n],
      ),
    );
    const counts = this.db
      .prepare(
        "SELECT COALESCE(SUM(deleted_at IS NULL AND pinned = 1), 0) AS pinned, " +
          "COALESCE(SUM(deleted_at IS NOT NULL), 0) AS deleted FROM memories",
      )
      .get() as Row;
    const changes = (this.db.prepare("SELECT COUNT(*) AS n FROM memory_history").get() as Row).n;
    return {
      total: Object.values(byKind).reduce((a: number, b) => a + (b as number), 0),
      by_kind: Object.fromEntries(KINDS.map((k) => [k, byKind[k] ?? 0])),
      pinned: counts.pinned,
      deleted: counts.deleted,
      pending: this.pendingCount(),
      changes,
    };
  }

  /** Queue a proposal for the user. Throws MemoryRefused when a guard refuses it. */
  suggest(options: {
    action: string;
    text?: string;
    kind?: string;
    targetId?: number | null;
    reason?: string;
    threadId?: string | null;
  }): Suggestion {
    const { action } = options;
    let text = options.text ?? "";
    let kind = options.kind ?? "fact";
    const targetId = options.targetId ?? null;
    if (!["add", "update", "forget"].includes(action)) throw new MemoryRefused(`Unknown suggestion action '${action}'.`);
    if (action === "forget") {
      text = "";
      kind = "fact";
    } else {
      [text, kind] = LongTermStore.#clean(text, kind);
      if (looksSecret(text)) throw new MemoryRefused("That looks like a password, key or number to keep private; not saved.");
    }
    const reason = [...squash(options.reason ?? "")].slice(0, 200).join("");
    if (action !== "add") {
      if (targetId === null) throw new MemoryRefused("Give the id of the memory to change, e.g. 12 for [m12].");
      const target = this.#row(targetId);
      if (action === "update" && normalize(text) === normalize(target.text)) throw new MemoryRefused(`m${targetId} already says that.`);
    }
    if (action !== "forget") {
      const key = normalize(text);
      const known = this.db.prepare("SELECT text FROM memories WHERE deleted_at IS NULL").all() as Row[];
      if (known.some((r) => normalize(r.text) === key)) throw new MemoryRefused("Already in long-term memory.");
    }
    // Same proposal already waiting, or already rejected by the user.
    const earlier = this.db
      .prepare("SELECT status, text FROM suggestions WHERE action = ? AND target_id IS ? AND status IN ('pending', 'rejected')")
      .all(action, targetId) as Row[];
    for (const row of earlier) {
      if (normalize(row.text) === normalize(text)) {
        throw new MemoryRefused(
          row.status === "pending" ? "Already waiting in the user's inbox." : "The user already declined this; don't suggest it again.",
        );
      }
    }
    const info = this.db
      .prepare("INSERT INTO suggestions (action, target_id, text, kind, reason, thread_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(action, targetId, text, kind, reason, options.threadId ?? null, nowIso());
    return this.#suggestion(this.db.prepare("SELECT * FROM suggestions WHERE id = ?").get(info.lastInsertRowid) as Row);
  }

  #pending(suggestionId: number): Row {
    const row = this.db.prepare("SELECT * FROM suggestions WHERE id = ? AND status = 'pending'").get(suggestionId) as Row | undefined;
    if (!row) throw new MemoryRefused(`No pending suggestion s${suggestionId}.`);
    return row;
  }

  #setStatus(suggestionId: number, status: string): void {
    this.db.prepare("UPDATE suggestions SET status = ? WHERE id = ?").run(status, suggestionId);
  }

  /** Apply a suggestion (optionally with the user's own wording).
   * Returns the memory it created or changed (null for a forget). */
  accept(suggestionId: number, text?: string | null): Memory | null {
    const row = this.#pending(suggestionId);
    const source = `suggestion s${suggestionId}`;
    const newText = text === undefined || text === null || !text.trim() ? row.text : text;
    let result: Memory | null;
    if (row.action === "add") result = this.add(newText, row.kind, false, source);
    else if (row.action === "update") result = this.edit(row.target_id, { text: newText }, source);
    else {
      this.delete(row.target_id, source);
      result = null;
    }
    this.#setStatus(suggestionId, "accepted");
    return result;
  }

  /** Decline a pending suggestion so it is not suggested again. */
  reject(suggestionId: number): void {
    this.#pending(suggestionId);
    this.#setStatus(suggestionId, "rejected");
  }
}

// --- prompt ----------------------------------------------------------------------

export const MEMORY_PROMPT = `
## Long-term memory

These are facts the user saved in earlier conversations. They may be out of date:
what the user says now wins.
To save something lasting (a preference, a fact about the user or people and
projects in their life), call \`remember\`; to correct or drop a memory, call
\`suggest_update\` / \`suggest_forget\` with its id. These go to the user's memory
inbox and are saved only if they accept, so mention it in a few words.
Don't save task details, one-off requests, or anything secret.
`.trim();

/** Memory lines for the prompt, stopping before `maxChars`. */
export function renderMemories(memories: Memory[], maxChars: number): string {
  const lines: string[] = [];
  let used = 0;
  for (const m of memories) {
    const line = `- [m${m.id}] (${m.kind}) ${m.text}`;
    const length = [...line].length;
    if (used + length > maxChars) break;
    lines.push(line);
    used += length + 1;
  }
  return lines.join("\n");
}

function latestUserText(messages: BaseMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]?.type === "human") return messages[i].text;
  return "";
}

/** Pinned memories, then the best matches for `query` (no repeats). */
export function relevantMemories(store: LongTermStore, query: string, limit: number): Memory[] {
  const chosen = store.pinned();
  const seen = new Set(chosen.map((m) => m.id));
  for (const m of store.search(query, limit)) {
    if (!seen.has(m.id)) {
      chosen.push(m);
      seen.add(m.id);
    }
  }
  return chosen;
}

// --- tools -----------------------------------------------------------------------

/** recall (read-only) + remember / suggest_update / suggest_forget (suggest only). */
export function makeMemoryTools(store: LongTermStore, maxSuggestions = 3): AnyTool[] {
  const suggest = (runtime: unknown, options: Parameters<LongTermStore["suggest"]>[0]): string => {
    const budget = currentBudget.getStore();
    if (budget && budget.memorySuggestions >= maxSuggestions) {
      return `Not suggested: at most ${maxSuggestions} memory suggestions per message.`;
    }
    let s: Suggestion;
    try {
      s = store.suggest({ ...options, threadId: threadIdOf(runtime) ?? null });
    } catch (error) {
      if (error instanceof MemoryRefused) return `Not suggested: ${error.message}`;
      throw error;
    }
    if (budget) budget.memorySuggestions += 1;
    return `Added to the user's memory inbox as s${s.id}. It is saved only if they accept it.`;
  };

  const recall = tool(
    async ({ query }) => {
      const found = store.search(query, 8);
      if (!found.length) return "Nothing in long-term memory matches.";
      return found.map((m) => `[m${m.id}] (${m.kind}) ${m.text}`).join("\n");
    },
    {
      name: "recall",
      description: "Search the user's long-term memory for saved facts and preferences.",
      schema: z.object({ query: z.string().describe("Words to look for, e.g. 'coffee' or 'sister birthday'.") }),
    },
  );

  const remember = tool(async ({ text, kind = "fact" }, runtime) => suggest(runtime, { action: "add", text, kind }), {
    name: "remember",
    description: "Suggest a new long-term memory about the user. The user approves it later.",
    schema: z.object({
      text: z.string().describe("One short, self-contained statement, e.g. 'Prefers tea over coffee'."),
      kind: z.string().default("fact").describe("'fact', 'preference', 'person' or 'project'."),
    }),
  });

  const suggestUpdate = tool(
    async ({ memory_id, text, reason = "" }, runtime) => suggest(runtime, { action: "update", targetId: memory_id, text, reason }),
    {
      name: "suggest_update",
      description: "Suggest a correction to an existing long-term memory. The user approves it later.",
      schema: z.object({
        memory_id: z.number().int().describe("The number of the memory, e.g. 12 for [m12]."),
        text: z.string().describe("The full corrected statement."),
        reason: z.string().default("").describe("Why it should change (shown to the user)."),
      }),
    },
  );

  const suggestForget = tool(
    async ({ memory_id, reason = "" }, runtime) => suggest(runtime, { action: "forget", targetId: memory_id, reason }),
    {
      name: "suggest_forget",
      description: "Suggest deleting a long-term memory that is wrong or outdated. The user approves it later.",
      schema: z.object({
        memory_id: z.number().int().describe("The number of the memory, e.g. 12 for [m12]."),
        reason: z.string().default("").describe("Why it should go (shown to the user)."),
      }),
    },
  );

  return [recall, remember, suggestUpdate, suggestForget] as unknown as AnyTool[];
}

export interface LongTermOptions {
  recallLimit?: number;
  maxChars?: number;
  maxSuggestions?: number;
}

/**
 * Adds the memory tools, and shows relevant memories on every model call.
 * Main agent only: helpers get the facts they need in the task text.
 */
export function longTermMemoryMiddleware(store: LongTermStore, options: LongTermOptions = {}) {
  const { recallLimit = 5, maxChars = 1500, maxSuggestions = 3 } = options;
  return createMiddleware({
    name: "LongTermMemoryMiddleware",
    tools: makeMemoryTools(store, maxSuggestions) as never,
    wrapModelCall: async (request, handler) => {
      const query = latestUserText((request.state as { messages?: BaseMessage[] }).messages ?? []);
      const lines = renderMemories(relevantMemories(store, query, recallLimit), maxChars);
      const text = MEMORY_PROMPT + "\n\n" + (lines ? `What you know about the user:\n${lines}` : "(No saved memories match yet.)");
      return handler({ ...request, systemMessage: appendSystemText(request.systemMessage, text) });
    },
  });
}

/** The store from settings, or null when long-term memory is off. */
export function openLongtermStore(settings: Settings): LongTermStore | null {
  if (!settings.enable_longterm_memory) return null;
  return new LongTermStore(settings.longterm_memory_path);
}
