/**
 * Conversation memory for Luna (short-term / per-chat).
 *
 * BEGINNER MAP
 * ------------
 * Problem: LLMs do not remember past turns by themselves.
 * Solution: LangGraph saves the message list after every turn (a "checkpoint")
 * and reloads it next time using the same thread_id.
 *
 * Two backends:
 *   - "sqlite"  → file on disk (default). Survives restart.
 *   - "memory"  → RAM only. Forgotten when the process exits.
 *
 * You do NOT append to a history list yourself. Pass the checkpointer into
 * createAgent(...), then pass thread_id when you invoke. LangGraph handles
 * load/save.
 *
 * The SQLite file is data/luna_checkpoints.sqlite. The Python version wrote
 * data/luna_memory.sqlite, whose saved threads TypeScript can't read
 * (DECISIONS.md D41), so that file is left alone.
 *
 * Read next: config/settings.ts (how to switch backends).
 */

import { mkdirSync } from "node:fs";
import path from "node:path";

import { type BaseCheckpointSaver, MemorySaver } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";

// Open SQLite savers, closed by closeCheckpointers() when the app exits.
const OPEN: SqliteSaver[] = [];

/** Build the memory object LangGraph will use. */
export async function createCheckpointer(backend = "sqlite", file?: string | null): Promise<BaseCheckpointSaver> {
  backend = backend.toLowerCase().trim();
  if (backend === "memory") {
    // Fast, good for experiments. History dies with the process.
    return new MemorySaver();
  }
  if (backend === "sqlite") {
    if (!file) throw new Error("sqlite memory backend requires a checkpoint path");
    // Make sure data/ exists before opening the DB file.
    mkdirSync(path.dirname(file), { recursive: true });
    const saver = SqliteSaver.fromConnString(file);
    OPEN.push(saver);
    return saver;
  }
  throw new Error(`Unknown memory backend '${backend}'. Use 'memory' or 'sqlite'.`);
}

/** Close any open SQLite connections. Call once when the app exits. */
export async function closeCheckpointers(): Promise<void> {
  while (OPEN.length) {
    const saver = OPEN.pop()!;
    try {
      saver.db.close();
    } catch {
      // already closed
    }
  }
}
