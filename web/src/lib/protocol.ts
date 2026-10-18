// Messages on the /ws socket. Mirrors src/luna/web/server.py + events.py;
// the full protocol is documented in docs/web-ui.md.

export interface ApprovalAction {
  name: string;
  args: Record<string, unknown>;
  description?: string | null;
  allowed: Decision["type"][];
}

export type Pause =
  | { id: string; kind: "question"; question: string }
  | { id: string; kind: "approval"; actions: ApprovalAction[] }
  | { id: string; kind: "other"; text: string };

export interface ProviderInfo {
  id: string;
  label: string;
  /** has an API key (Ollama always does) */
  configured: boolean;
  default_model: string;
}

/** One long-term memory (src/luna/agent/longterm.py). Only the user changes these. */
export interface Memory {
  id: number;
  text: string;
  kind: MemoryKind;
  pinned: boolean;
  created_at: string;
  updated_at: string;
}

export type MemoryKind = "fact" | "preference" | "person" | "project";

/** Something Luna proposed; nothing changes until the user accepts it. */
export interface MemorySuggestion {
  id: number;
  action: "add" | "update" | "forget";
  target_id: number | null;
  /** current text of the memory an update / forget is about */
  target_text: string | null;
  text: string;
  kind: MemoryKind;
  reason: string;
  thread_id: string | null;
  created_at: string;
}

interface MemorySnapshot {
  text: string;
  kind: MemoryKind;
  pinned: number;
  deleted_at: string | null;
}

export interface MemoryHistoryEntry {
  action: "add" | "edit" | "pin" | "unpin" | "delete";
  before: MemorySnapshot | null;
  after: MemorySnapshot | null;
  /** "user" or "suggestion s<id>" */
  source: string;
  at: string;
  undone: boolean;
}

export type ServerEvent =
  | {
      type: "hello";
      provider: string;
      model: string;
      providers: ProviderInfo[];
      can_switch: boolean;
      tools: string[];
      helpers: string[];
      budget: number;
      /** "piper": fetch speech from /api/tts; "browser": speechSynthesis */
      tts: "piper" | "browser";
      /** "whisper": send utterances to /api/stt (wake word on); "browser": Web Speech */
      stt: "whisper" | "browser";
      /** long-term memory is on (Memory panel available) */
      memory?: boolean;
    }
  | { type: "cancelled"; tools: string[] }
  | { type: "model"; provider: string; model: string }
  | { type: "models"; provider: string; models: string[]; error?: string }
  | { type: "thread"; id: string; history: { role: "user" | "luna"; text: string }[] }
  | { type: "threads"; ids: string[] }
  | { type: "state"; value: "thinking" }
  | { type: "token"; text: string }
  // Helper events (depth >= 1) carry `parent`: the ask_* call they run under.
  | {
      type: "tool_call";
      id?: string | null;
      name: string;
      args: Record<string, unknown>;
      depth: number;
      parent?: string | null;
    }
  | { type: "tool_result"; id?: string | null; name?: string | null; preview: string; depth: number; parent?: string | null }
  | { type: "notice"; text: string; depth: number; parent?: string | null }
  /** thread history tokens vs. where it gets summarized; sent on sync and before each run's last event */
  | { type: "context"; used: number; max: number }
  | { type: "pause"; pauses: Pause[] }
  | { type: "done" }
  | { type: "error"; message: string }
  // Long-term memory panel. memory_error never ends a run (unlike error).
  | { type: "memories"; items: Memory[]; suggestions: MemorySuggestion[] }
  | { type: "memory_inbox"; count: number }
  | { type: "memory_history"; id: number; entries: MemoryHistoryEntry[] }
  | { type: "memory_error"; message: string };

export type Decision =
  | { type: "approve" }
  | { type: "reject"; message?: string }
  | { type: "edit"; args: Record<string, unknown> };

/** The browser's reply to one pause (see build_answer in events.py). */
export type PauseReply = { answer: string } | { decisions: Decision[] };

export type ClientMessage =
  | { type: "message"; text: string }
  | { type: "cancel" }
  | { type: "resume"; answers: Record<string, PauseReply> }
  | { type: "new_thread" }
  | { type: "thread"; id: string }
  | { type: "threads" }
  | { type: "models"; provider: string }
  | { type: "set_model"; provider: string; model: string }
  | { type: "memories" }
  /** no id = add a new memory */
  | { type: "memory_save"; id?: number; text: string; kind: MemoryKind; pinned: boolean }
  | { type: "memory_delete"; id: number }
  | { type: "memory_undo"; id: number }
  | { type: "memory_history"; id: number }
  /** text = accept in the user's own words */
  | { type: "suggestion_accept"; id: number; text?: string }
  | { type: "suggestion_reject"; id: number };
