"""
Subagents — helper agents the main agent can hand a task to.

BEGINNER MAP
------------
A subagent is just another tool. From the main agent's point of view,
``ask_researcher(task)`` looks exactly like ``calculator(expression)``:
it picks it when the tool description says it fits, and gets text back.

Inside, the tool runs a *separate* agent with:
  - its own tools and system prompt (and optionally a different model)
  - a fresh, empty conversation on every call (it only sees `task` + `context`)
  - its own loop limit and timeout, plus the shared task budget
  - optional human approval for risky tools (``interrupt_on``)

Only the final answer goes back to the main agent, so noisy multi-step
work (searching, reading big files) never clutters the main chat history.

Subagents cannot delegate further: their tools may not include other
delegate tools (one level only keeps cost and debugging manageable).

When to add a subagent (see spec/spec2.md): the work is noisy and
multi-step, the main agent has too many / look-alike tools, it needs a
different model/prompt/permissions, or the pieces can run in parallel.
Otherwise keep it as a plain tool.

To add one: write a ``<name>_spec(settings)`` function in a new module in
this package and list it in ``get_subagent_specs()`` (``__init__.py``).
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any

from langchain.agents import create_agent
from langchain.agents.middleware import HumanInTheLoopMiddleware, ModelCallLimitMiddleware
from langchain_core.tools import BaseTool, StructuredTool
from pydantic import BaseModel, Field

from luna.agent.budget import BUDGET_MESSAGE_PREFIX, TaskBudgetMiddleware

# Marks a tool as a delegate so subagents can't be nested.
_DELEGATE_FLAG = "luna_delegate"
# Final-message prefixes that mean "stopped early" rather than a real answer:
# ModelCallLimitMiddleware's limit message and the task-budget message.
_STOP_PREFIXES = ("Model call limits exceeded", BUDGET_MESSAGE_PREFIX)


@dataclass
class SubagentSpec:
    """Everything needed to build one subagent.

    name:
        Tool name the main agent sees, e.g. ``"ask_researcher"``.
    description:
        Tells the main agent WHEN to delegate. Write it like a tool docstring.
    system_prompt:
        Instructions for the subagent itself.
    tools:
        The subagent's own tools (not visible to the main agent).
    model:
        Optional different model; ``None`` reuses the main agent's model.
    interrupt_on:
        Tools that need human approval before running, in
        HumanInTheLoopMiddleware format, e.g. ``{"write_file": True}``.
    middleware:
        Extra middleware for this subagent (e.g. TodoListMiddleware).
    """

    name: str
    description: str
    system_prompt: str
    tools: list[Any] = field(default_factory=list)
    model: Any | None = None
    max_model_calls: int = 6
    timeout_seconds: float = 120.0
    interrupt_on: dict[str, Any] = field(default_factory=dict)
    middleware: list[Any] = field(default_factory=list)


class _DelegateInput(BaseModel):
    task: str = Field(
        description="A complete, self-contained description of the task. "
        "The helper cannot see this conversation, so include every detail it needs."
    )
    context: str = Field(
        default="",
        description="Optional facts the helper needs: relevant notes, earlier "
        "results, file paths, user preferences.",
    )


def needs_approval(tool_names: list[str], auto_approve: list[str]) -> dict[str, bool]:
    """``interrupt_on`` for these tools, minus the ones the user auto-approves."""
    trusted = set(auto_approve)
    return {name: True for name in tool_names if name not in trusted}


def _is_delegate(tool: Any) -> bool:
    return bool((getattr(tool, "metadata", None) or {}).get(_DELEGATE_FLAG))


def make_delegate_tool(spec: SubagentSpec, default_model: Any) -> BaseTool:
    """Wrap a subagent as a tool the main agent can call."""
    nested = [t.name for t in spec.tools if _is_delegate(t)]
    if nested:
        raise ValueError(
            f"Subagent '{spec.name}' may not use other subagents ({', '.join(nested)})"
        )

    middleware: list[Any] = [
        TaskBudgetMiddleware(),
        ModelCallLimitMiddleware(run_limit=spec.max_model_calls, exit_behavior="end"),
        *spec.middleware,
    ]
    if spec.interrupt_on:
        middleware.append(HumanInTheLoopMiddleware(interrupt_on=spec.interrupt_on))

    agent = create_agent(
        model=spec.model or default_model,
        tools=spec.tools,
        system_prompt=spec.system_prompt,
        middleware=middleware,
        # None = use the main agent's checkpointer. Needed so an approval pause
        # inside the subagent can resume where it stopped (with False, a resume
        # silently skips the approved action). Each call still starts with an
        # empty conversation: LangGraph gives every tool call its own namespace.
        checkpointer=None,
        name=spec.name,
    )

    async def run(task: str, context: str = "") -> str:
        prompt = f"{task}\n\nContext:\n{context}" if context.strip() else task
        try:
            result = await asyncio.wait_for(
                agent.ainvoke(
                    {"messages": [{"role": "user", "content": prompt}]},
                    {"recursion_limit": spec.max_model_calls * 10 + 20},
                ),
                timeout=spec.timeout_seconds,
            )
        except TimeoutError:
            return f"[{spec.name} stopped: timed out after {spec.timeout_seconds:g}s]"

        messages = result.get("messages") or []
        final = messages[-1].text if messages else ""
        if not final.startswith(_STOP_PREFIXES):
            return final or "(no answer)"

        # Stopped early (own limit or task budget): hand back the last real
        # answer text, if any, clearly marked as partial so the main agent knows.
        partial = next(
            (
                m.text
                for m in reversed(messages[:-1])
                if m.type == "ai" and m.text and not m.text.startswith(_STOP_PREFIXES)
            ),
            "",
        )
        if final.startswith(BUDGET_MESSAGE_PREFIX):
            note = f"[{spec.name} stopped: the task budget ran out]"
        else:
            note = f"[{spec.name} stopped at its limit of {spec.max_model_calls} steps]"
        return f"{note}\n{partial}" if partial else note

    return StructuredTool.from_function(
        coroutine=run,
        name=spec.name,
        description=spec.description,
        args_schema=_DelegateInput,
        metadata={_DELEGATE_FLAG: True},
    )


__all__ = ["SubagentSpec", "make_delegate_tool", "needs_approval"]
