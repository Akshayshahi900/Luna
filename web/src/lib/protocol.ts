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
    }
  | { type: "cancelled"; tools: string[] }
  | { type: "model"; provider: string; model: string }
  | { type: "models"; provider: string; models: string[]; error?: string }
  | { type: "thread"; id: string; history: { role: "user" | "luna"; text: string }[] }
  | { type: "threads"; ids: string[] }
  | { type: "state"; value: "thinking" }
  | { type: "token"; text: string }
  | { type: "tool_call"; id?: string | null; name: string; args: Record<string, unknown>; depth: number }
  | { type: "tool_result"; id?: string | null; name?: string | null; preview: string; depth: number }
  | { type: "notice"; text: string; depth: number }
  | { type: "pause"; pauses: Pause[] }
  | { type: "done" }
  | { type: "error"; message: string };

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
  | { type: "set_model"; provider: string; model: string };
