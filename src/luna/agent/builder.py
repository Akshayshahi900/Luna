"""
Assemble the Luna agent (model + memory + tools).

BEGINNER MAP
------------
This is the "factory". It does not chat with you. It builds the object
that *can* chat.

Analogy:
  - Model      = brain (Ollama)
  - Tools      = hands (calculator, MCP tools, ...)
  - Checkpointer = notebook (remembers the conversation)
  - create_agent = wires brain + hands + notebook into one runnable graph

After build_agent() returns, the CLI only needs to call agent.ainvoke(...).

Read next: luna/agent/memory.py and luna/tools/registry.py
"""

from __future__ import annotations

from typing import Any

from langchain.agents import create_agent
from langchain_ollama import ChatOllama

from luna.agent.memory import create_checkpointer
from luna.config import Settings, get_settings
from luna.mcp.loader import load_mcp_tools
from luna.tools.builtin import get_builtin_tools
from luna.tools.registry import ToolRegistry


async def build_tool_registry(settings: Settings | None = None) -> ToolRegistry:
    """Collect every tool Luna should know about into one registry.

    Two sources:
      1. Built-in tools — Python functions in this repo (`luna.tools.builtin`).
      2. MCP tools — functions living in other programs, loaded from config.

    The agent does not care where a tool came from; it just gets one list.
    """
    settings = settings or get_settings()
    registry = ToolRegistry()

    if settings.enable_builtin_tools:
        registry.register_many(get_builtin_tools())

    if settings.enable_mcp_tools:
        # May start MCP server subprocesses / open HTTP connections.
        mcp_tools = await load_mcp_tools(settings.mcp_config_path)
        registry.register_many(mcp_tools)

    return registry


async def build_agent(
    settings: Settings | None = None,
) -> tuple[Any, ToolRegistry]:
    """Create the runnable LangGraph agent.

    Returns
    -------
    agent :
        A compiled graph. Call ``await agent.ainvoke(...)`` to chat.
    registry :
        The tool bag (useful so the CLI can print tool names).

    Example
    -------
    ::

        agent, registry = await build_agent()
        reply = await agent.ainvoke(
            {"messages": [{"role": "user", "content": "Hi"}]},
            config={"configurable": {"thread_id": "default"}},
        )
    """
    settings = settings or get_settings()

    # 1) Brain — talks to a local Ollama server.
    model = ChatOllama(model=settings.model_name)

    # 2) Notebook — stores message history per thread_id.
    # Must be async (AsyncSqliteSaver) because the CLI uses agent.ainvoke().
    checkpointer = await create_checkpointer(
        backend=settings.memory_backend,
        path=settings.checkpoint_path,
    )

    # 3) Hands — all callable tools.
    registry = await build_tool_registry(settings)

    # 4) Wire everything into one agent graph.
    # create_agent already implements the "think → tool → think → answer" loop.
    agent = create_agent(
        model=model,
        tools=registry.list_tools(),
        system_prompt=settings.system_prompt,
        checkpointer=checkpointer,
        name="luna",
    )
    return agent, registry


__all__ = ["build_agent", "build_tool_registry"]
