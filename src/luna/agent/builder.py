"""
Assemble the Luna agent (model + memory + tools).

BEGINNER MAP
------------
This is the "factory". It does not chat with you. It builds the object
that *can* chat.

Analogy:
  - Model      = brain (OpenRouter, Groq or Ollama — see providers.py)
  - Tools      = hands (calculator, MCP tools, ...)
  - Checkpointer = notebook (remembers the conversation)
  - create_agent = wires brain + hands + notebook into one runnable graph

After build_agent() returns, the CLI only needs to call agent.ainvoke(...).

Read next: luna/agent/memory.py and luna/tools/registry.py
"""

from __future__ import annotations

import sys
from typing import Any

from langchain.agents import create_agent
from langchain.agents.middleware import (
    HumanInTheLoopMiddleware,
    ModelCallLimitMiddleware,
    SummarizationMiddleware,
    TodoListMiddleware,
    ToolCallLimitMiddleware,
)

from luna.agent.budget import TaskBudgetMiddleware
from luna.agent.memory import create_checkpointer
from luna.agent.providers import make_model
from luna.agent.scratchpad import ScratchpadMiddleware
from luna.agent.subagents import get_subagent_specs, make_delegate_tool, needs_approval
from luna.config import Settings, get_settings
from luna.mcp.loader import is_risky_tool_name, load_mcp_config, load_mcp_tools, split_by_agent
from luna.tools.builtin import get_builtin_tools
from luna.tools.registry import ToolRegistry


async def load_mcp_groups(settings: Settings) -> dict[str | None, list[Any]]:
    """Load MCP tools, grouped by the server's "agent" tag (None = main agent).

    May start MCP server subprocesses / open HTTP connections.
    A broken server should not stop Luna from starting: warn and carry on
    with whatever tools we already have (only that group is skipped).
    """
    if not settings.enable_mcp_tools:
        return {}
    try:
        config = load_mcp_config(settings.mcp_config_path)
    except Exception as exc:  # noqa: BLE001 — e.g. invalid JSON
        print(f"Warning: could not load MCP tools ({exc}). Continuing without them.", file=sys.stderr)
        return {}
    if config is None:
        return {}

    groups: dict[str | None, list[Any]] = {}
    for agent, group_config in split_by_agent(config).items():
        try:
            groups[agent] = await load_mcp_tools(group_config)
        except Exception as exc:  # noqa: BLE001 — any MCP failure is non-fatal
            owner = f"the {agent} helper" if agent else "the main agent"
            print(
                f"Warning: could not load MCP tools for {owner} ({exc}). "
                "Continuing without them.",
                file=sys.stderr,
            )
    return groups


async def build_tool_registry(
    settings: Settings | None = None,
    mcp_groups: dict[str | None, list[Any]] | None = None,
) -> ToolRegistry:
    """Collect every tool the MAIN agent should know about into one registry.

    Two sources:
      1. Built-in tools — Python functions in this repo (`luna.tools.builtin`).
      2. MCP tools — functions living in other programs, loaded from config.
         Only untagged servers; tagged ones go to their subagent.

    The agent does not care where a tool came from; it just gets one list.
    """
    settings = settings or get_settings()
    registry = ToolRegistry()

    if settings.enable_builtin_tools:
        registry.register_many(get_builtin_tools())

    if mcp_groups is None:
        mcp_groups = await load_mcp_groups(settings)
    registry.register_many(mcp_groups.get(None, []))

    return registry


def build_middleware(
    settings: Settings, model: Any, interrupt_on: dict[str, Any] | None = None
) -> list[Any]:
    """Middleware that runs around each model / tool call (in this order).

    - Task budget: one model-call allowance shared with every subagent
      (see luna/agent/budget.py).
    - Loop limits: a ReAct loop can keep calling tools forever. After
      ``max_model_calls`` the run ends with a short "limit reached" message;
      after ``max_tool_calls`` further tool calls are refused, so the model
      answers with what it already has.
    - Scratchpad: write_todos (plan) + write_note (facts), shown to the
      model on every call (see luna/agent/scratchpad.py).
    - Approval: ``interrupt_on`` lists main-agent tools (risky MCP tools)
      that pause for the user's OK before running.
    - Summarization: replaces old messages with a short summary so long
      threads don't grow forever. The scratchpad is state, not messages,
      so it survives this.
    """
    middleware: list[Any] = [
        TaskBudgetMiddleware(),
        ModelCallLimitMiddleware(run_limit=settings.max_model_calls, exit_behavior="end"),
        ToolCallLimitMiddleware(run_limit=settings.max_tool_calls, exit_behavior="continue"),
        TodoListMiddleware(),
        ScratchpadMiddleware(),
    ]
    if interrupt_on:
        middleware.append(HumanInTheLoopMiddleware(interrupt_on=interrupt_on))
    if settings.summary_trigger_tokens > 0:
        middleware.append(
            SummarizationMiddleware(
                model=model,
                trigger=("tokens", settings.summary_trigger_tokens),
                keep=("messages", settings.summary_keep_messages),
            )
        )
    return middleware


def recursion_limit(settings: Settings) -> int:
    """LangGraph step backstop, set well above the model-call limit.

    Each model call costs several graph steps (model, tools, and one node per
    middleware hook — about 6 today), so this leaves wide headroom and only
    triggers if the middleware limits somehow fail.
    """
    return settings.max_model_calls * 10 + 20


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

    # 1) Brain — an OpenAI-compatible chat model from the configured
    # provider (OpenRouter, Groq or Ollama; see luna/agent/providers.py).
    model = make_model(settings)

    # 2) Notebook — stores message history per thread_id.
    # Must be async (AsyncSqliteSaver) because the CLI uses agent.astream().
    checkpointer = await create_checkpointer(
        backend=settings.memory_backend,
        path=settings.checkpoint_path,
    )

    # 3) Hands (part 1) — MCP tools are loaded once and split: untagged →
    # main agent, tagged → that subagent (see "agent" in config/mcp_servers.json).
    mcp_groups = await load_mcp_groups(settings)

    return await assemble_agent(settings, model, checkpointer, mcp_groups)


async def assemble_agent(
    settings: Settings,
    model: Any,
    checkpointer: Any,
    mcp_groups: dict[str | None, list[Any]],
) -> tuple[Any, ToolRegistry]:
    """Wire an agent from parts that already exist.

    Cheap (no network, no files), so the web UI calls it again with a new
    ``model`` to switch providers: same memory, same MCP connections, and
    every helper and the summarizer switch along with the main agent.
    """
    # 3) Hands (part 2) — all callable tools, plus one delegate tool per subagent.
    # Delegates are ordinary tools, so the model chooses between "do it
    # myself" and "hand it off" the same way it picks any other tool.
    registry = await build_tool_registry(settings, mcp_groups)
    registry.register_many(
        [make_delegate_tool(spec, model) for spec in get_subagent_specs(settings, mcp_groups)]
    )

    # 4) Middleware — budget, loop limits, scratchpad, approval, summarization.
    # Main-agent MCP tools that change things (send_*, delete_*, …) need approval.
    risky = [t.name for t in mcp_groups.get(None, []) if is_risky_tool_name(t.name)]
    middleware = build_middleware(settings, model, needs_approval(risky, settings.auto_approve))

    # 5) Wire everything into one agent graph.
    # create_agent already implements the "think → tool → think → answer" loop.
    agent = create_agent(
        model=model,
        tools=registry.list_tools(),
        system_prompt=settings.system_prompt,
        checkpointer=checkpointer,
        middleware=middleware,
        name="luna",
    )
    return agent, registry


__all__ = [
    "assemble_agent",
    "build_agent",
    "build_middleware",
    "build_tool_registry",
    "load_mcp_groups",
    "recursion_limit",
]
