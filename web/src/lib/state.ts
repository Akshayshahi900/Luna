// Pure reducer for everything the server tells us. No DOM, no sockets:
// that keeps it unit-testable (state.test.ts).
import type { Pause, ProviderInfo, ServerEvent } from "./protocol";

export interface ChatMessage {
  id: string;
  role: "user" | "luna" | "system";
  text: string;
}

export interface Activity {
  id: string;
  name: string;
  args: Record<string, unknown>;
  depth: number;
  status: "running" | "done";
  preview?: string;
  at: number;
}

export interface LunaState {
  connected: boolean;
  provider?: string;
  model?: string;
  /** which speech recognition the server offers */
  stt: "whisper" | "browser";
  providers: ProviderInfo[];
  canSwitch: boolean;
  /** model ids per provider, as reported by the provider (may be empty) */
  models: Record<string, { ids: string[]; error?: string }>;
  /** a set_model request is in flight */
  switching: boolean;
  tools: string[];
  helpers: string[];
  threadId?: string;
  threads: string[];
  messages: ChatMessage[];
  activity: Activity[];
  pauses: Pause[];
  busy: boolean;
  error?: string;
  /** id of the Luna message tokens are being appended to, if any */
  replyId?: string;
  /** the main agent called a tool after writing text: start a new paragraph */
  replyBreak: boolean;
  /** ask_* delegate calls still running (helper names, e.g. "coder") */
  activeHelpers: string[];
  /** tool calls in the current task */
  ops: number;
}

export type Action =
  | { kind: "connected" }
  | { kind: "disconnected" }
  | { kind: "user"; text: string }
  | { kind: "answered" }
  | { kind: "switching" }
  | { kind: "server"; event: ServerEvent };

export const MAX_ACTIVITY = 30;

export const initialState: LunaState = {
  connected: false,
  providers: [],
  stt: "browser",
  canSwitch: false,
  models: {},
  switching: false,
  tools: [],
  helpers: [],
  threads: [],
  messages: [],
  activity: [],
  pauses: [],
  busy: false,
  replyBreak: false,
  activeHelpers: [],
  ops: 0,
};

let seq = 0;
const nextId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(seq++).toString(36)}`;

/** "ask_coder" → "coder"; other tools → null. */
export function helperOf(toolName: string | null | undefined): string | null {
  if (!toolName || !toolName.startsWith("ask_") || toolName === "ask_user") return null;
  return toolName.slice(4);
}

function finishReply(state: LunaState): LunaState {
  return { ...state, replyId: undefined, replyBreak: false, busy: false, activeHelpers: [] };
}

function onServer(state: LunaState, event: ServerEvent): LunaState {
  switch (event.type) {
    case "hello":
      return {
        ...state,
        provider: event.provider,
        model: event.model,
        stt: event.stt ?? "browser",
        providers: event.providers,
        canSwitch: event.can_switch,
        tools: event.tools,
        helpers: event.helpers,
      };

    case "model":
      return { ...state, provider: event.provider, model: event.model, switching: false };

    case "models":
      return { ...state, models: { ...state.models, [event.provider]: { ids: event.models, error: event.error } } };

    case "thread":
      return {
        ...finishReply(state),
        threadId: event.id,
        pauses: [],
        activity: [],
        error: undefined,
        messages: event.history.map((m) => ({ id: nextId("h"), role: m.role, text: m.text })),
      };

    case "threads":
      return { ...state, threads: event.ids };

    case "state":
      return { ...state, busy: true, error: undefined };

    case "token": {
      if (!state.replyId) {
        const id = nextId("l");
        return {
          ...state,
          replyId: id,
          replyBreak: false,
          messages: [...state.messages, { id, role: "luna", text: event.text }],
        };
      }
      const sep = state.replyBreak ? "\n\n" : "";
      return {
        ...state,
        replyBreak: false,
        messages: state.messages.map((m) =>
          m.id === state.replyId ? { ...m, text: m.text + sep + event.text } : m,
        ),
      };
    }

    case "tool_call": {
      // Approval middleware re-sends a paused call when it resumes: same id, no new op.
      if (event.id && state.activity.some((a) => a.id === event.id)) {
        return {
          ...state,
          activity: state.activity.map((a) => (a.id === event.id ? { ...a, name: event.name, args: event.args } : a)),
        };
      }
      const helper = event.depth === 0 ? helperOf(event.name) : null;
      const item: Activity = {
        id: event.id ?? nextId("t"),
        name: event.name,
        args: event.args,
        depth: event.depth,
        status: "running",
        at: Date.now(),
      };
      return {
        ...state,
        ops: state.ops + 1,
        replyBreak: event.depth === 0 && !!state.replyId,
        activeHelpers: helper ? [...state.activeHelpers, helper] : state.activeHelpers,
        activity: [item, ...state.activity].slice(0, MAX_ACTIVITY),
      };
    }

    case "tool_result": {
      // Match by call id; fall back to the newest running call of that name.
      let matched = false;
      const activity = state.activity.map((a) => {
        if (matched || a.status !== "running") return a;
        const hit = event.id ? a.id === event.id : a.name === event.name;
        if (!hit) return a;
        matched = true;
        return { ...a, status: "done" as const, preview: event.preview };
      });
      const helper = event.depth === 0 ? helperOf(event.name) : null;
      const activeHelpers = [...state.activeHelpers];
      if (helper && activeHelpers.includes(helper)) activeHelpers.splice(activeHelpers.indexOf(helper), 1);
      return { ...state, activity, activeHelpers };
    }

    case "notice":
      return {
        ...state,
        messages: [...state.messages, { id: nextId("n"), role: "system", text: event.text }],
      };

    case "pause":
      return { ...state, pauses: event.pauses, busy: false, replyId: undefined, replyBreak: false };

    case "done":
      return finishReply(state);

    case "cancelled":
      return {
        ...finishReply(state),
        pauses: [],
        activity: state.activity.map((a) => (a.status === "running" ? { ...a, status: "done" as const, preview: "cancelled" } : a)),
        messages: [...state.messages, { id: nextId("n"), role: "system", text: "Cancelled." }],
      };

    case "error":
      return { ...finishReply(state), error: event.message, switching: false };
  }
}

export function reducer(state: LunaState, action: Action): LunaState {
  switch (action.kind) {
    case "connected":
      return { ...state, connected: true, error: undefined };
    case "disconnected":
      return { ...finishReply(state), connected: false, pauses: [] };
    case "user":
      return {
        ...state,
        busy: true,
        ops: 0,
        error: undefined,
        messages: [...state.messages, { id: nextId("u"), role: "user", text: action.text }],
      };
    case "answered":
      return { ...state, pauses: [], busy: true };
    case "switching":
      return { ...state, switching: true, error: undefined };
    case "server":
      return onServer(state, action.event);
  }
}
