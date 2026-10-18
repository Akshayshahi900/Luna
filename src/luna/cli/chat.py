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
  /quit  or  /exit   Leave the chat
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

    agent, registry = await build_agent(settings)   # creates a model with memory(checkpointer) and tools

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
                if cmd == "/new":
                    # New UUID = new memory bucket. Old chats stay saved under old ids.
                    thread_id = str(uuid.uuid4())
                    print(f"New thread: {thread_id}")
                    continue
                print(f"Unknown command: {cmd}. Try /help.")
                continue

            try:
                # The checkpointer automatically prepends older messages for this thread.
                await run_turn(agent, user_input, thread_id, settings)
            except KeyboardInterrupt:
                print("\n(interrupted)\n")
            except Exception as exc:  # noqa: BLE001 — show errors to the user in the CLI
                print(f"\nError: {exc}\n", file=sys.stderr)
    finally:
        await close_checkpointers()


def main() -> None:
    asyncio.run(run_chat())


if __name__ == "__main__":
    main()
