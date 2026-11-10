/**
 * Luna in the terminal (`luna`).
 *
 * A REPL around one agent: each line is sent with runTask, streamed text is
 * printed as it arrives, and pauses (tool approvals, ask_user) are answered
 * with answerInterrupt. Lines starting with "/" are commands: sessions
 * (sessionCommand), long-term memory (memoryCommand), /tools, /help.
 * Command reference: docs/cli.md.
 */

import { createInterface, type Interface } from "node:readline/promises";
import { parseArgs } from "node:util";

import type { BaseMessage } from "@langchain/core/messages";
import { Command } from "@langchain/langgraph";

import { TaskBudget } from "../agent/budget.ts";
import { buildAgent, recursionLimit } from "../agent/builder.ts";
import { KINDS, type LongTermStore, MemoryRefused, type Memory, openLongtermStore, type Suggestion } from "../agent/longterm.ts";
import { closeCheckpointers } from "../agent/memory.ts";
import { defaultModel, getProvider } from "../agent/providers.ts";
import { runTask } from "../agent/runner.ts";
import { deleteSession, listSessions, newSessionId, resolveSession, type SessionInfo } from "../agent/sessions.ts";
import { agentToolNames, type Interrupt, type LunaAgent, snapshotInterrupts } from "../agent/types.ts";
import { getSettings, type Settings } from "../config/settings.ts";
import { closeMcpClients } from "../mcp/loader.ts";
import { EventTranslator } from "../web/events.ts";

export const HELP_TEXT = `
Commands:
  /help              Show this help
  /tools             List registered tools
  /sessions          List saved sessions (1 = most recent)
  /resume <n|id>     Resume a saved session (number from /sessions, or id)
  /delete <n|id>     Delete a saved session (asks first)
  /session           Show the current session
  /new               Start a new session
  /memory            Long-term memory: /memory help for its commands
  /quit  or  /exit   Leave the chat
`.trim();

export const MEMORY_HELP = `
Long-term memory (shared by every thread; only you change it):
  /memory                    List saved memories
  /memory search <words>     Find memories
  /memory add [kind:]<text>  Save one, e.g. /memory add preference: tea, not coffee
  /memory edit <id> <text>   Change the text of m<id>
  /memory rm <id>            Delete m<id> (undo brings it back)
  /memory pin <id>           Pin / unpin: pinned memories are always shown to Luna
  /memory undo <id>          Revert the last change to m<id>
  /memory history <id>       Show the changes to m<id>
  /memory inbox              Luna's suggestions, waiting for you
  /memory accept <id> [text] Accept suggestion s<id> (optionally in your words)
  /memory reject <id>        Decline suggestion s<id> (Luna won't suggest it again)
Kinds: fact, preference, person, project. Ids may be written 12, m12 or s3.
`.trim();

// How many recent messages to show when a session is resumed.
const RECAP_MESSAGES = 4;
// Tool results can be long; only show the start in the CLI.
const TOOL_RESULT_PREVIEW = 200;

/** Ask the user one line (tests pass canned answers). */
export type Ask = (prompt: string) => string | Promise<string>;

/** Where the CLI prints (tests capture it). */
export const io = {
  write: (text: string) => void process.stdout.write(text),
  error: (text: string) => void process.stderr.write(text),
};
const print = (text = "") => io.write(text + "\n");

function short(text: string, limit = TOOL_RESULT_PREVIEW): string {
  const s = text.split(/\s+/).filter(Boolean).join(" ");
  return [...s].length <= limit ? s : [...s].slice(0, limit - 1).join("") + "…";
}

/** JSON like Python's json.dumps: ", " and ": " separators, unicode kept. */
export function pyJson(value: unknown, indent?: number, level = 0): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) {
    if (!value.length) return "[]";
    if (indent === undefined) return "[" + value.map((v) => pyJson(v)).join(", ") + "]";
    const pad = " ".repeat(indent * (level + 1));
    return "[\n" + value.map((v) => pad + pyJson(v, indent, level + 1)).join(",\n") + "\n" + " ".repeat(indent * level) + "]";
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (!entries.length) return "{}";
    if (indent === undefined) return "{" + entries.map(([k, v]) => `${JSON.stringify(k)}: ${pyJson(v)}`).join(", ") + "}";
    const pad = " ".repeat(indent * (level + 1));
    return "{\n" + entries.map(([k, v]) => `${pad}${JSON.stringify(k)}: ${pyJson(v, indent, level + 1)}`).join(",\n") + "\n" + " ".repeat(indent * level) + "}";
  }
  return JSON.stringify(value) ?? String(value);
}

// --- long-term memory --------------------------------------------------------

function formatMemory(m: Memory): string {
  return `  m${String(m.id).padEnd(4)} ${m.pinned ? "📌 " : ""}(${m.kind}) ${m.text}`;
}

function formatSuggestion(s: Suggestion): string {
  const reason = s.reason ? `  — ${s.reason}` : "";
  const id = `s${String(s.id).padEnd(4)}`;
  if (s.action === "add") return `  ${id} add (${s.kind}): ${s.text}${reason}`;
  if (s.action === "update") return `  ${id} change m${s.target_id}: '${s.target_text}' → '${s.text}'${reason}`;
  return `  ${id} forget m${s.target_id}: '${s.target_text}'${reason}`;
}

function memoryId(raw: string): number {
  const clean = raw.trim().toLowerCase().replace(/^[ms]+/, "");
  if (!/^\d+$/.test(clean)) throw new MemoryRefused("Give a number, e.g. 12 or m12.");
  return Number(clean);
}

function partition(text: string, sep: string): [string, string, string] {
  const at = text.indexOf(sep);
  return at < 0 ? [text, "", ""] : [text.slice(0, at), sep, text.slice(at + sep.length)];
}

/** Run one /memory command (everything after "/memory"); return what to print. */
export function memoryCommand(store: LongTermStore | null, rest: string): string {
  if (!store) return "Long-term memory is off (LUNA_ENABLE_LONGTERM_MEMORY=false).";
  let [sub, , arg] = partition(rest.trim(), " ");
  sub = sub.toLowerCase() || "list";
  arg = arg.trim();
  try {
    if (sub === "help") return MEMORY_HELP;
    if (sub === "list") return store.list().map(formatMemory).join("\n") || "(no memories yet)";
    if (sub === "search") return store.search(arg, 20).map(formatMemory).join("\n") || "(no match)";
    if (sub === "add") {
      let [kind, sep, text] = partition(arg, ":");
      if (!sep || !(KINDS as readonly string[]).includes(kind.trim().toLowerCase())) [kind, text] = ["fact", arg];
      return `Saved m${store.add(text, kind.trim().toLowerCase()).id}.`;
    }
    if (["edit", "rm", "pin", "undo", "history", "accept", "reject"].includes(sub)) {
      const [rawId, , text] = partition(arg, " ");
      const id = memoryId(rawId);
      if (sub === "edit") {
        store.edit(id, { text });
        return `Updated m${id}.`;
      }
      if (sub === "rm") {
        store.delete(id);
        return `Deleted m${id} (/memory undo ${id} brings it back).`;
      }
      if (sub === "pin") {
        const m = store.edit(id, { pinned: !store.get(id).pinned });
        return `${m.pinned ? "Pinned" : "Unpinned"} m${id}.`;
      }
      if (sub === "undo") {
        const m = store.undo(id);
        return m ? `Undone. m${id} is now: ${m.text}` : `Undone. m${id} is removed.`;
      }
      if (sub === "history") {
        const lines = store
          .history(id)
          .map((h) => `  ${h.at}  ${h.action.padEnd(6)} '${(h.after as { text?: string } | null)?.text ?? ""}'  (${h.source})` + (h.undone ? "  [undone]" : ""));
        return lines.join("\n") || "(no history)";
      }
      if (sub === "accept") {
        const m = store.accept(id, text || null);
        return `Accepted s${id}` + (m ? ` → m${m.id}: ${m.text}` : ".");
      }
      store.reject(id);
      return `Declined s${id}.`;
    }
    if (sub === "inbox") return store.suggestions().map(formatSuggestion).join("\n") || "(inbox empty)";
  } catch (error) {
    if (error instanceof MemoryRefused) return error.message;
    throw error;
  }
  return `Unknown /memory command: ${sub}. Try /memory help.`;
}

// --- sessions -----------------------------------------------------------------

/** '2026-10-18T12:35:44.67+00:00' → '2026-10-18 12:35' (UTC). */
function when(ts: string): string {
  return ts.replace("T", " ").slice(0, 16);
}

/** Numbered session list for /sessions (1 = most recent). */
export function formatSessions(sessions: SessionInfo[], current: string): string {
  if (!sessions.length) return "(no saved sessions)";
  return sessions
    .map((s, i) => {
      const marker = s.id === current ? "*" : " ";
      const turns = s.turns === 1 ? "1 msg" : `${s.turns} msgs`;
      return ` ${marker}${String(i + 1).padStart(3)}. ${s.title}  (${when(s.updated_at)}, ${turns}, ${s.id.slice(0, 8)})`;
    })
    .join("\n");
}

/** A resumed session may have stopped at an approval or question: answer it
 * first, or a new message would leave the tool call unanswered. */
export async function answerOpenPauses(agent: LunaAgent, threadId: string, settings: Settings, ask: Ask): Promise<void> {
  if (!agent.checkpointer) return;
  let interrupts = snapshotInterrupts(await agent.getState({ configurable: { thread_id: threadId } }));
  if (!interrupts.length) return;
  print("This session was waiting for you:");
  const budget = new TaskBudget(settings.task_budget);
  const limit = recursionLimit(settings);
  while (interrupts.length) {
    const answers: Record<string, unknown> = {};
    for (const i of interrupts) answers[i.id ?? ""] = await answerInterrupt(i.value, ask);
    interrupts = await streamReply(agent, new Command({ resume: answers }), threadId, limit, budget);
  }
}

/** The last few messages of a session, so you know where you left off. */
export async function printRecap(agent: LunaAgent, threadId: string, count = RECAP_MESSAGES): Promise<void> {
  if (!agent.checkpointer) return;
  const state = await agent.getState({ configurable: { thread_id: threadId } });
  const messages = ((state.values?.messages ?? []) as BaseMessage[]).filter((m) => (m.type === "human" || m.type === "ai") && m.text);
  if (messages.length > count) print(`  … ${messages.length - count} earlier message(s)`);
  for (const m of messages.slice(-count)) print(`  ${m.type === "human" ? "You" : "Luna"}: ${short(m.text, 300)}`);
  print();
}

export const SESSION_COMMANDS = new Set(["/sessions", "/resume", "/delete", "/session", "/new"]);

/** Run /sessions, /resume, /delete, /session or /new; return the session to use next. */
export async function sessionCommand(agent: LunaAgent, cmd: string, arg: string, threadId: string, settings: Settings, ask: Ask = defaultAsk): Promise<string> {
  if (cmd === "/new") {
    const fresh = newSessionId();
    print(`New session: ${fresh}`);
    return fresh;
  }
  if (!agent.checkpointer) {
    print("Sessions aren't saved (no checkpointer).");
    return threadId;
  }
  const sessions = await listSessions(agent.checkpointer as never);
  if (cmd === "/sessions") {
    print(formatSessions(sessions, threadId));
    return threadId;
  }
  if (cmd === "/session") {
    const current = sessions.find((s) => s.id === threadId);
    print(`${threadId}  ${current ? current.title : "(new, nothing said yet)"}`);
    return threadId;
  }
  if (!sessions.length) {
    print("(no saved sessions)");
    return threadId;
  }
  const target = resolveSession(arg, sessions);
  if (!target) {
    print(arg ? `No session matches '${arg}'. See /sessions.` : `Usage: ${cmd} <number or id>`);
    return threadId;
  }
  const title = sessions.find((s) => s.id === target)!.title;
  if (cmd === "/resume") {
    print(`Resumed: ${title}`);
    await printRecap(agent, target);
    await answerOpenPauses(agent, target, settings, ask);
    return target;
  }
  // /delete
  if (!["y", "yes"].includes(String(await ask(`Delete session '${title}'? It can't be undone. [y/N] `)).trim().toLowerCase())) {
    print("Kept.");
    return threadId;
  }
  await deleteSession(agent.checkpointer as never, target);
  print(`Deleted: ${title}`);
  if (target === threadId) {
    threadId = newSessionId();
    print(`New session: ${threadId}`);
  }
  return threadId;
}

// --- streaming and pauses -----------------------------------------------------------

/**
 * Turns agent stream events into CLI output (through EventTranslator, the
 * same rules as the web UI). The main agent's reply streams after "Luna: ";
 * tool calls and results print as → / ←, indented one more level per
 * subagent; middleware notices (limits) print as ⚠.
 */
class Printer {
  printingText = false;
  readonly translate = new EventTranslator();

  endTextLine(): void {
    if (this.printingText) {
      io.write("\n");
      this.printingText = false;
    }
  }

  handle = (namespace: string[], mode: string, payload: unknown): void => {
    for (const event of this.translate.translate(namespace, mode, payload)) {
      const indent = "  ".repeat((event.depth ?? 0) + 1);
      if (event.type === "token") {
        if (!this.printingText) {
          io.write("Luna: ");
          this.printingText = true;
        }
        io.write(event.text);
      } else if (event.type === "tool_call") {
        this.endTextLine();
        print(`${indent}→ ${event.name}(${pyJson(event.args)})`);
      } else if (event.type === "tool_result") {
        print(`${indent}← ${short(event.preview)}`);
      } else if (event.type === "notice") {
        this.endTextLine();
        print(`${indent}⚠ ${event.text}`);
      }
    }
  };
}

/**
 * Run the agent once, printing as it goes; return any pending pauses.
 * `input` is the user's text, or a Command({resume}) answering earlier pauses.
 */
export async function streamReply(
  agent: LunaAgent,
  input: string | Command,
  threadId: string,
  limit: number | null = null,
  budget: TaskBudget | null = null,
  signal?: AbortSignal,
): Promise<Interrupt[]> {
  // This config tells LangGraph WHICH conversation memory to load/save.
  const config: Record<string, unknown> = { configurable: { thread_id: threadId } };
  if (limit !== null) config.recursionLimit = limit;
  const payload = input instanceof Command ? input : { messages: [{ role: "user", content: input }] };
  const printer = new Printer();
  if (agent.checkpointer) printer.translate.prime(((await agent.getState(config)).values?.messages ?? []) as BaseMessage[]);
  try {
    return await runTask(agent, payload, config, { budget, onEvent: printer.handle, signal });
  } finally {
    io.write(printer.printingText ? "\n\n" : "\n");
  }
}

/** Ask the user to approve / edit / reject one tool call. */
async function reviewAction(action: { name: string; args?: unknown; description?: string }, allowed: string[], ask: Ask): Promise<Record<string, unknown>> {
  print(`⏸  Approval needed: ${action.name}\n${pyJson(action.args ?? {}, 2)}`);
  if (action.description) print(action.description);
  const options: Record<string, string> = { a: "approve", e: "edit", r: "reject" };
  const prompt = Object.entries(options).filter(([, v]) => allowed.includes(v)).map(([k, v]) => `[${k}]${v.slice(1)}`).join(" / ") + ": ";
  for (;;) {
    const choice = options[String(await ask(prompt)).trim().toLowerCase().slice(0, 1)];
    if (!choice || !allowed.includes(choice)) continue;
    if (choice === "approve") return { type: "approve" };
    if (choice === "reject") {
      const reason = String(await ask("Reason (optional, shown to Luna): ")).trim();
      return reason ? { type: "reject", message: reason } : { type: "reject" };
    }
    const raw = String(await ask("New arguments as JSON: "));
    try {
      return { type: "edit", editedAction: { name: action.name, args: JSON.parse(raw) } };
    } catch (error) {
      print(`Invalid JSON (${(error as Error).message}); try again.`);
    }
  }
}

/** Turn one pause into the user's answer, in the format its tool expects. */
export async function answerInterrupt(value: unknown, ask: Ask = defaultAsk): Promise<unknown> {
  const v = value as Record<string, any> | null;
  if (v && typeof v === "object" && v.type === "ask_user") {
    print(`❓ Luna asks: ${v.question}`);
    return ask("Your answer: ");
  }
  if (v && typeof v === "object" && Array.isArray(v.actionRequests)) {
    // humanInTheLoopMiddleware: one decision per pending tool call.
    const configs = new Map<string, any>((v.reviewConfigs ?? []).map((c: any) => [c.actionName, c]));
    const decisions = [];
    for (const action of v.actionRequests) {
      decisions.push(await reviewAction(action, configs.get(action.name)?.allowedDecisions ?? ["approve", "edit", "reject"], ask));
    }
    return { decisions };
  }
  print(`⏸  Paused: ${typeof value === "string" ? value : JSON.stringify(value)}`);
  return ask("Your answer: ");
}

/**
 * Handle one user message from start to finish, including every pause.
 * One TaskBudget covers the whole message, resumes included.
 */
export async function runTurn(agent: LunaAgent, input: string, threadId: string, settings: Settings, ask: Ask = defaultAsk, signal?: AbortSignal): Promise<void> {
  const budget = new TaskBudget(settings.task_budget);
  const limit = recursionLimit(settings);
  let interrupts = await streamReply(agent, input, threadId, limit, budget, signal);
  while (interrupts.length) {
    const answers: Record<string, unknown> = {};
    for (const i of interrupts) answers[i.id ?? ""] = await answerInterrupt(i.value, ask);
    interrupts = await streamReply(agent, new Command({ resume: answers }), threadId, limit, budget, signal);
  }
}

// --- the REPL -------------------------------------------------------------------

let rl: Interface | null = null;
let closed = false;

/** Read one line from the terminal; throws EOF when input ends (Ctrl+D). */
async function defaultAsk(prompt: string): Promise<string> {
  if (!rl) throw new Error("No terminal input.");
  if (closed) throw new Error("EOF");
  return rl.question(prompt);
}

/** The REPL. Starts a new session, or resumes one: `resume` is a session
 * number / id, or "" for the most recent (`luna --resume`). */
export async function runChat(resume: string | null = null): Promise<void> {
  const settings = getSettings();
  let threadId = newSessionId();

  print("Luna — LangGraph chatbot");
  print(`Model: ${settings.provider}/${defaultModel(getProvider(settings.provider), settings)}  |  Memory: ${settings.memory_backend}`);
  print("Type /help for commands. Building agent...\n");

  // Long-term memory: kept here too so /memory can edit it.
  const memory = openLongtermStore(settings);
  const { agent, registry } = await buildAgent(settings, memory);
  const toolNames = agentToolNames(agent).length ? agentToolNames(agent) : registry.names();
  print(`Loaded ${toolNames.length} tool(s): ${toolNames.join(", ") || "(none)"}\n`);

  rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
  closed = false;
  let controller: AbortController | null = null;
  rl.on("close", () => (closed = true));
  // Ctrl+C stops the run in progress; with nothing running it leaves.
  rl.on("SIGINT", () => {
    if (controller) controller.abort();
    else rl?.close();
  });

  try {
    if (resume !== null) threadId = await sessionCommand(agent, "/resume", resume || "1", threadId, settings);
    else print("New session. /sessions lists saved ones, /resume <n> continues one.\n");
    for (;;) {
      let line: string;
      try {
        line = (await defaultAsk("You: ")).trim();
      } catch {
        // Ctrl+C / Ctrl+D → exit cleanly.
        print("\nBye.");
        return;
      }
      if (!line) continue;

      // Slash commands are handled here — they never go to the model.
      if (line.startsWith("/")) {
        const [cmd, ...args] = line.split(/\s+/);
        const command = cmd.toLowerCase();
        if (command === "/quit" || command === "/exit") {
          print("Bye.");
          return;
        }
        if (command === "/help") print(HELP_TEXT);
        else if (command === "/tools") print(toolNames.join(", ") || "(none)");
        else if (command === "/memory") print(memoryCommand(memory, line.slice("/memory".length)));
        else if (SESSION_COMMANDS.has(command)) threadId = await sessionCommand(agent, command, args.join(" "), threadId, settings); // a session is a thread id
        else print(`Unknown command: ${command}. Try /help.`);
        continue;
      }

      controller = new AbortController();
      try {
        // The checkpointer automatically prepends older messages for this thread.
        const before = memory?.pendingCount() ?? 0;
        await runTurn(agent, line, threadId, settings, defaultAsk, controller.signal);
        const added = (memory?.pendingCount() ?? 0) - before;
        if (added > 0) print(`💡 Luna suggested ${added} memor${added === 1 ? "y" : "ies"}. See /memory inbox.\n`);
      } catch (error) {
        if (controller.signal.aborted) {
          const { cancelCleanup } = await import("../web/session.ts");
          await cancelCleanup(agent, { configurable: { thread_id: threadId } }).catch(() => undefined);
          print("\n(interrupted)\n");
        } else if ((error as Error).message === "EOF") {
          print("\nBye.");
          return;
        } else {
          io.error(`\nError: ${(error as Error).message || error}\n\n`);
        }
      } finally {
        controller = null;
      }
    }
  } finally {
    rl.close();
    rl = null;
    await closeCheckpointers();
    memory?.close();
    await closeMcpClients();
  }
}

/** Entry point for `luna`: parse `--resume` and start the chat loop. */
export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { resume: { type: "boolean", short: "r", default: false }, help: { type: "boolean", short: "h", default: false } },
  });
  if (values.help) {
    print("usage: luna [--resume [SESSION]]\n\nLuna in the terminal. Starts a new session.\n\n  -r, --resume [SESSION]  resume a saved session instead: its number in /sessions or its id (default: the most recent)");
    return;
  }
  await runChat(values.resume ? (positionals[0] ?? "") : null);
}
