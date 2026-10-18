from __future__ import annotations

import asyncio
import json
import sys
import uuid
from typing import Any

from luna.agent.builder import build_agent
from luna.agent.memory import close_checkpointers
from luna.config import get_settings


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


async def list_threads(checkpointer: Any) -> list[str]:
    """Return every saved thread id, least recently used first."""
    last_used: dict[str, str] = {}
    async for checkpoint in checkpointer.alist(None):
        thread_id = checkpoint.config["configurable"]["thread_id"]
        ts = checkpoint.checkpoint["ts"]  # ISO timestamp, sorts as a string
        last_used[thread_id] = max(ts, last_used.get(thread_id, ""))
    return sorted(last_used, key=last_used.__getitem__)


async def stream_reply(agent: Any, user_input: str, thread_id: str) -> None:
    """Run one turn and print Luna's reply token by token.

    Two stream modes at once:
      - "messages" → small text chunks from the model as they arrive
      - "updates"  → one event per finished graph step, used to show tool calls
    """
    # This config tells LangGraph WHICH conversation memory to load/save.
    config = {"configurable": {"thread_id": thread_id}}
    printing_text = False

    async for mode, payload in agent.astream(
        {"messages": [{"role": "user", "content": user_input}]},
        config=config,
        stream_mode=["messages", "updates"],
    ):
        if mode == "messages":
            chunk, metadata = payload
            if metadata.get("langgraph_node") != "model":
                continue
            text = chunk.text
            if text:
                if not printing_text:
                    print("Luna: ", end="", flush=True)
                    printing_text = True
                print(text, end="", flush=True)
            continue

        # mode == "updates": {node_name: {"messages": [...]}}
        for node, update in payload.items():
            for message in (update or {}).get("messages", []):
                if node == "model":
                    for call in getattr(message, "tool_calls", None) or []:
                        if printing_text:
                            print()
                            printing_text = False
                        args = json.dumps(call.get("args", {}), ensure_ascii=False)
                        print(f"  → {call['name']}({args})")
                elif node == "tools":
                    print(f"  ← {_short(str(message.content))}")

    print("\n" if printing_text else "")


async def run_chat(thread_id: str | None = None) -> None:
    settings = get_settings()
    thread_id = thread_id or settings.default_thread_id

    print("Luna — LangGraph chatbot")
    print(
        f"Model: {settings.model_name}  |  "
        f"Memory: {settings.memory_backend}  |  "
        f"Thread: {thread_id}"
    )
    print("Type /help for commands. Building agent...\n")

    agent, registry = await build_agent(settings)   # creates a model with memory(checkpointer) and tools

    tool_names = registry.names()
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
                await stream_reply(agent, user_input, thread_id)
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
