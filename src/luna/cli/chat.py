from __future__ import annotations

import asyncio
import json
import sys
import uuid
from collections.abc import Callable
from typing import Any

from langgraph.types import Command, Interrupt

from luna.agent.budget import TaskBudget
from luna.agent.builder import build_agent, recursion_limit
from luna.agent.longterm import KINDS, LongTermStore, MemoryRefused, open_longterm_store
from luna.agent.memory import close_checkpointers
from luna.agent.providers import get_provider
from luna.agent.runner import run_task
from luna.config import Settings, get_settings


HELP_TEXT = """
Commands:
  /help              Show this help
  /tools             List registered tools
  /thread            Show current thread id
  /thread <id>       Switch to an existing (or new) thread
  /threads           List saved threads
  /new               Start a new conversation thread (fresh memory key)
  /memory            Long-term memory: /memory help for its commands
  /quit  or  /exit   Leave the chat
""".strip()

MEMORY_HELP = """
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
""".strip()

# Tool results can be long; only show the start in the CLI.
_TOOL_RESULT_PREVIEW = 200


def _short(text: str, limit: int = _TOOL_RESULT_PREVIEW) -> str:
    text = " ".join(text.split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def agent_tool_names(agent: Any) -> list[str]:
    """Every tool the agent can call, including ones added by middleware
    (write_todos, write_note) that aren't in the ToolRegistry."""
    tools_node = getattr(agent, "nodes", {}).get("tools")
    return sorted(getattr(getattr(tools_node, "bound", None), "tools_by_name", {}) or [])


async def list_threads(checkpointer: Any) -> list[str]:
    """Return every saved thread id, least recently used first."""
    last_used: dict[str, str] = {}
    async for checkpoint in checkpointer.alist(None):
        thread_id = checkpoint.config["configurable"]["thread_id"]
        ts = checkpoint.checkpoint["ts"]  # ISO timestamp, sorts as a string
        last_used[thread_id] = max(ts, last_used.get(thread_id, ""))
    return sorted(last_used, key=last_used.__getitem__)


def _format_memory(m: dict[str, Any]) -> str:
    pin = "📌 " if m["pinned"] else ""
    return f"  m{m['id']:<4} {pin}({m['kind']}) {m['text']}"


def _format_suggestion(s: dict[str, Any]) -> str:
    reason = f"  — {s['reason']}" if s["reason"] else ""
    if s["action"] == "add":
        return f"  s{s['id']:<4} add ({s['kind']}): {s['text']}{reason}"
    if s["action"] == "update":
        return f"  s{s['id']:<4} change m{s['target_id']}: {s['target_text']!r} → {s['text']!r}{reason}"
    return f"  s{s['id']:<4} forget m{s['target_id']}: {s['target_text']!r}{reason}"


def _memory_id(raw: str) -> int:
    raw = raw.strip().lower().lstrip("ms")
    if not raw.isdigit():
        raise MemoryRefused("Give a number, e.g. 12 or m12.")
    return int(raw)


def memory_command(store: LongTermStore | None, rest: str) -> str:
    """Run one /memory command (everything after "/memory"); return what to print."""
    if store is None:
        return "Long-term memory is off (LUNA_ENABLE_LONGTERM_MEMORY=false)."
    sub, _, arg = rest.strip().partition(" ")
    sub, arg = sub.lower() or "list", arg.strip()
    try:
        if sub == "help":
            return MEMORY_HELP
        if sub == "list":
            items = store.list()
            return "\n".join(_format_memory(m) for m in items) or "(no memories yet)"
        if sub == "search":
            found = store.search(arg, limit=20)
            return "\n".join(_format_memory(m) for m in found) or "(no match)"
        if sub == "add":
            kind, sep, text = arg.partition(":")
            if not sep or kind.strip().lower() not in KINDS:
                kind, text = "fact", arg
            m = store.add(text, kind.strip().lower())
            return f"Saved m{m['id']}."
        if sub in {"edit", "rm", "pin", "undo", "history", "accept", "reject"}:
            raw_id, _, text = arg.partition(" ")
            item_id = _memory_id(raw_id)
            if sub == "edit":
                store.edit(item_id, text=text)
                return f"Updated m{item_id}."
            if sub == "rm":
                store.delete(item_id)
                return f"Deleted m{item_id} (/memory undo {item_id} brings it back)."
            if sub == "pin":
                m = store.edit(item_id, pinned=not store.get(item_id)["pinned"])
                return f"{'Pinned' if m['pinned'] else 'Unpinned'} m{item_id}."
            if sub == "undo":
                m = store.undo(item_id)
                return f"Undone. m{item_id} is now: {m['text']}" if m else f"Undone. m{item_id} is removed."
            if sub == "history":
                lines = [
                    f"  {h['at']}  {h['action']:<6} {(h['after'] or {}).get('text', '')!r}  ({h['source']})"
                    + ("  [undone]" if h["undone"] else "")
                    for h in store.history(item_id)
                ]
                return "\n".join(lines) or "(no history)"
            if sub == "accept":
                m = store.accept(item_id, text or None)
                return f"Accepted s{item_id}" + (f" → m{m['id']}: {m['text']}" if m else ".")
            store.reject(item_id)
            return f"Declined s{item_id}."
        if sub == "inbox":
            items = store.suggestions()
            return "\n".join(_format_suggestion(s) for s in items) or "(inbox empty)"
    except MemoryRefused as exc:
        return str(exc)
    return f"Unknown /memory command: {sub}. Try /memory help."


class _Printer:
    """Turns agent stream events into CLI output.

    Two stream modes arrive together:
      - "messages" → small text chunks from the model as they arrive
      - "updates"  → one event per finished graph step, used to show tool calls

    subgraphs=True also streams steps from subagents (agents running inside
    a delegate tool). Each event carries a namespace: () for the main agent,
    one entry per level of nesting below it. Subagent steps print indented.
    """

    def __init__(self) -> None:
        self.printing_text = False

    def end_text_line(self) -> None:
        if self.printing_text:
            print()
            self.printing_text = False

    def __call__(self, namespace: tuple[str, ...], mode: str, payload: Any) -> None:
        if mode == "messages":
            chunk, metadata = payload
            # Only the main agent's own text is the reply; subagent text
            # comes back to it as a tool result instead.
            if namespace or metadata.get("langgraph_node") != "model":
                return
            text = chunk.text
            if text:
                if not self.printing_text:
                    print("Luna: ", end="", flush=True)
                    self.printing_text = True
                print(text, end="", flush=True)
            return

        # mode == "updates": {node_name: {"messages": [...]}}
        indent = "  " * (len(namespace) + 1)
        for node, update in payload.items():
            if node == "__interrupt__":
                continue  # pauses are handled after the run, see run_turn()
            for message in (update or {}).get("messages", []):
                if message.type == "ai" and message.tool_calls:
                    self.end_text_line()
                    for call in message.tool_calls:
                        args = json.dumps(call.get("args", {}), ensure_ascii=False)
                        print(f"{indent}→ {call['name']}({args})")
                elif message.type == "tool":
                    print(f"{indent}← {_short(str(message.content))}")
                elif message.type == "ai" and node != "model" and message.text:
                    # Written by middleware, e.g. "Model call limits exceeded".
                    self.end_text_line()
                    print(f"{indent}⚠ {message.text}")


async def stream_reply(
    agent: Any,
    user_input: str | Command,
    thread_id: str,
    recursion_limit: int | None = None,
    budget: TaskBudget | None = None,
) -> list[Interrupt]:
    """Run the agent once, printing as it goes; return any pending pauses.

    ``user_input`` is the user's text, or a ``Command(resume=...)`` that
    answers earlier pauses.
    """
    # This config tells LangGraph WHICH conversation memory to load/save.
    config: dict[str, Any] = {"configurable": {"thread_id": thread_id}}
    if recursion_limit is not None:
        config["recursion_limit"] = recursion_limit
    payload = (
        user_input
        if isinstance(user_input, Command)
        else {"messages": [{"role": "user", "content": user_input}]}
    )

    printer = _Printer()
    interrupts = await run_task(agent, payload, config, budget=budget, on_event=printer)
    print("\n" if printer.printing_text else "")
    return interrupts


def _review_action(action: dict[str, Any], allowed: list[str], ask: Callable[[str], str]) -> dict:
    """Ask the user to approve / edit / reject one tool call."""
    args = json.dumps(action.get("args", {}), ensure_ascii=False, indent=2)
    print(f"⏸  Approval needed: {action['name']}\n{args}")
    if action.get("description"):
        print(action["description"])
    options = {"a": "approve", "e": "edit", "r": "reject"}
    prompt = " / ".join(f"[{k}]{v[1:]}" for k, v in options.items() if v in allowed) + ": "
    while True:
        choice = options.get(ask(prompt).strip().lower()[:1])
        if choice not in allowed:
            continue
        if choice == "approve":
            return {"type": "approve"}
        if choice == "reject":
            reason = ask("Reason (optional, shown to Luna): ").strip()
            return {"type": "reject", "message": reason} if reason else {"type": "reject"}
        raw = ask("New arguments as JSON: ")
        try:
            new_args = json.loads(raw)
        except json.JSONDecodeError as exc:
            print(f"Invalid JSON ({exc}); try again.")
            continue
        return {"type": "edit", "edited_action": {"name": action["name"], "args": new_args}}


def answer_interrupt(value: Any, ask: Callable[[str], str] = input) -> Any:
    """Turn one pause into the user's answer, in the format its tool expects."""
    if isinstance(value, dict) and value.get("type") == "ask_user":
        print(f"❓ Luna asks: {value['question']}")
        return ask("Your answer: ")
    if isinstance(value, dict) and "action_requests" in value:
        # HumanInTheLoopMiddleware: one decision per pending tool call.
        configs = {c["action_name"]: c for c in value.get("review_configs", [])}
        decisions = []
        for action in value["action_requests"]:
            allowed = configs.get(action["name"], {}).get(
                "allowed_decisions", ["approve", "edit", "reject"]
            )
            decisions.append(_review_action(action, allowed, ask))
        return {"decisions": decisions}
    print(f"⏸  Paused: {value}")
    return ask("Your answer: ")


async def run_turn(
    agent: Any,
    user_input: str,
    thread_id: str,
    settings: Settings,
    ask: Callable[[str], str] = input,
) -> None:
    """Handle one user message from start to finish, including every pause.

    One TaskBudget covers the whole message, resumes included.
    """
    budget = TaskBudget(limit=settings.task_budget)
    limit = recursion_limit(settings)
    interrupts = await stream_reply(agent, user_input, thread_id, limit, budget)
    while interrupts:
        answers = {i.id: answer_interrupt(i.value, ask) for i in interrupts}
        interrupts = await stream_reply(agent, Command(resume=answers), thread_id, limit, budget)


async def run_chat(thread_id: str | None = None) -> None:
    settings = get_settings()
    thread_id = thread_id or settings.default_thread_id

    print("Luna — LangGraph chatbot")
    print(
        f"Model: {settings.provider}/{get_provider(settings.provider).default_model(settings)}  |  "
        f"Memory: {settings.memory_backend}  |  "
        f"Thread: {thread_id}"
    )
    print("Type /help for commands. Building agent...\n")

    # Long-term memory: kept here too so /memory can edit it.
    memory = open_longterm_store(settings)
    agent, registry = await build_agent(settings, memory)   # creates a model with memory(checkpointer) and tools

    tool_names = agent_tool_names(agent) or registry.names()
    print(f"Loaded {len(tool_names)} tool(s): {', '.join(tool_names) or '(none)'}\n")

    try:
        while True:
            try:
                user_input = input("You: ").strip()
            except (EOFError, KeyboardInterrupt):
                # Ctrl+C / Ctrl+D → exit cleanly.
                print("\nBye.")
                return

            if not user_input:
                continue

            # Slash commands are handled here — they never go to the model.
            if user_input.startswith("/"):
                parts = user_input.split()
                cmd, args = parts[0].lower(), parts[1:]
                if cmd in {"/quit", "/exit"}:
                    print("Bye.")
                    return
                if cmd == "/help":
                    print(HELP_TEXT)
                    continue
                if cmd == "/tools":
                    print(", ".join(tool_names) or "(none)")
                    continue
                if cmd == "/thread":
                    if args:
                        # Same id = same memory bucket, so old chats resume.
                        thread_id = args[0]
                        print(f"Switched to thread: {thread_id}")
                    else:
                        print(thread_id)
                    continue
                if cmd == "/threads":
                    threads = await list_threads(agent.checkpointer)
                    for tid in threads:
                        marker = "*" if tid == thread_id else " "
                        print(f" {marker} {tid}")
                    if not threads:
                        print("(no saved threads)")
                    continue
                if cmd == "/memory":
                    print(memory_command(memory, user_input[len("/memory"):]))
                    continue
                if cmd == "/new":
                    # New UUID = new memory bucket. Old chats stay saved under old ids.
                    thread_id = str(uuid.uuid4())
                    print(f"New thread: {thread_id}")
                    continue
                print(f"Unknown command: {cmd}. Try /help.")
                continue

            try:
                # The checkpointer automatically prepends older messages for this thread.
                inbox_before = memory.pending_count() if memory else 0
                await run_turn(agent, user_input, thread_id, settings)
                new = (memory.pending_count() if memory else 0) - inbox_before
                if new > 0:
                    print(f"💡 Luna suggested {new} memor{'y' if new == 1 else 'ies'}. See /memory inbox.\n")
            except KeyboardInterrupt:
                print("\n(interrupted)\n")
            except Exception as exc:  # noqa: BLE001 — show errors to the user in the CLI
                print(f"\nError: {exc}\n", file=sys.stderr)
    finally:
        await close_checkpointers()
        if memory is not None:
            memory.close()


def main() -> None:
    asyncio.run(run_chat())


if __name__ == "__main__":
    main()
