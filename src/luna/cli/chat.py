"""
Chat UI for Luna (the part you interact with).

BEGINNER MAP
------------
This file is the front door. It does NOT contain the AI brain.

Flow:
  1. Start → build the agent once (model + memory + tools).
  2. Loop forever: read your text → send to agent → print reply.
  3. Special lines starting with "/" are local commands (no AI).

Key idea — thread_id:
  Every conversation has an ID (like a chat room name).
  Same ID  → Luna remembers previous messages.
  /new     → new ID → blank memory for a fresh chat.

Read next: luna/agent/builder.py (how the agent is assembled).
"""

from __future__ import annotations

import asyncio
import sys
import uuid
from typing import Any

from luna.agent.builder import build_agent
from luna.config import get_settings


HELP_TEXT = """
Commands:
  /help              Show this help
  /tools             List registered tools
  /thread            Show current thread id
  /new               Start a new conversation thread (fresh memory key)
  /quit  or  /exit   Leave the chat
""".strip()


def _extract_reply(result: dict[str, Any]) -> str:
    """Pull the last assistant message out of the agent result.

    The agent returns a dict like {"messages": [..., last_message]}.
    Different models store text as a plain string or as "content blocks",
    so we handle both shapes here.
    """
    messages = result.get("messages") or []
    if not messages:
        return "(no response)"
    last = messages[-1]
    content = getattr(last, "content", None)
    if isinstance(content, str) and content.strip():
        return content
    # Some models return a list of blocks instead of one string.
    blocks = getattr(last, "content_blocks", None)
    if blocks:
        texts = []
        for block in blocks:
            if isinstance(block, dict) and block.get("type") == "text":
                texts.append(block.get("text", ""))
            elif hasattr(block, "text"):
                texts.append(block.text)
        if texts:
            return "\n".join(texts)
    return str(content if content is not None else last)


async def run_chat(thread_id: str | None = None) -> None:
    """Interactive chat loop: You> ... Luna> ...

    Steps:
      1. Load settings (model name, memory type, etc.).
      2. Build the agent once (expensive: connects to MCP, opens DB).
      3. Read lines from the keyboard until /quit.
    """
    settings = get_settings()
    # If caller didn't pass a thread id, use the default from settings ("default").
    thread_id = thread_id or settings.default_thread_id

    print("Luna — LangGraph chatbot")
    print(
        f"Model: {settings.model_name}  |  "
        f"Memory: {settings.memory_backend}  |  "
        f"Thread: {thread_id}"
    )
    print("Type /help for commands. Building agent...\n")

    # Build once. Rebuilding every message would be slow (MCP reconnect, etc.).
    agent, registry = await build_agent(settings)
    tool_names = registry.names()
    print(f"Loaded {len(tool_names)} tool(s): {', '.join(tool_names) or '(none)'}\n")

    while True:
        try:
            user_input = input("You> ").strip()
        except (EOFError, KeyboardInterrupt):
            # Ctrl+C / Ctrl+D → exit cleanly.
            print("\nBye.")
            return

        if not user_input:
            continue

        # Slash commands are handled here — they never go to the model.
        if user_input.startswith("/"):
            cmd = user_input.lower().split()[0]
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
                print(thread_id)
                continue
            if cmd == "/new":
                # New UUID = new memory bucket. Old chats stay saved under old ids.
                thread_id = str(uuid.uuid4())
                print(f"New thread: {thread_id}")
                continue
            print(f"Unknown command: {cmd}. Try /help.")
            continue

        # This config tells LangGraph WHICH conversation memory to load/save.
        config = {"configurable": {"thread_id": thread_id}}
        try:
            # ainvoke = "run the agent graph once with this new user message".
            # The checkpointer automatically prepends older messages for this thread.
            result = await agent.ainvoke(
                {"messages": [{"role": "user", "content": user_input}]},
                config=config,
            )
            print(f"Luna> {_extract_reply(result)}\n")
        except Exception as exc:  # noqa: BLE001 — show errors to the user in the CLI
            print(f"Error: {exc}\n", file=sys.stderr)


def main() -> None:
    """Sync entry point used by the `luna` console script.

    The chat loop is async (awaits model/MCP calls), so we start an event loop
    with asyncio.run(...).
    """
    asyncio.run(run_chat())


if __name__ == "__main__":
    main()
