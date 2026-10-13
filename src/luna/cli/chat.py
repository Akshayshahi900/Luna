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
            print(f"Luna: {_extract_reply(result)}\n")
        except Exception as exc:  # noqa: BLE001 — show errors to the user in the CLI
            print(f"Error: {exc}\n", file=sys.stderr)


def main() -> None:
    asyncio.run(run_chat())


if __name__ == "__main__":
    main()
