"""
run_task — run one step of a task and report any pauses.

BEGINNER MAP
------------
A "task" is one user message plus everything the agents do for it. It may
pause several times for human approval or a question (``interrupt()``);
each pause ends the current run, and the task continues with a new run
that passes ``Command(resume=...)``.

run_task() does one of those runs:
  - activates the shared TaskBudget (pass the SAME budget for every run of
    one task so resumes don't get a fresh allowance)
  - streams every event to ``on_event`` (the CLI prints them; an API could
    forward them to a browser)
  - returns the pauses waiting for an answer ([] means the task is done)

To answer pauses, build ``{interrupt.id: answer}`` for each one and call
run_task again with ``Command(resume=that_dict)``.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from langgraph.types import Interrupt

from luna.agent.budget import TaskBudget, current_budget

# (namespace, stream mode, payload) — see stream_mode in agent.astream().
EventHandler = Callable[[tuple[str, ...], str, Any], None]


async def run_task(
    agent: Any,
    payload: Any,
    config: dict[str, Any],
    *,
    budget: TaskBudget | None = None,
    on_event: EventHandler | None = None,
) -> list[Interrupt]:
    """Run the agent until it finishes or pauses; return pending pauses.

    ``payload`` is either the normal input (``{"messages": [...]}``) or a
    ``Command(resume=...)`` answering earlier pauses.
    """
    token = current_budget.set(budget)
    try:
        async for namespace, mode, data in agent.astream(
            payload,
            config=config,
            stream_mode=["messages", "updates"],
            subgraphs=True,
        ):
            if on_event is not None:
                on_event(namespace, mode, data)
    finally:
        current_budget.reset(token)

    if agent.checkpointer is None:
        return []  # without a checkpointer the graph can't pause
    state = await agent.aget_state(config)
    # Includes pauses raised inside subagents, each with its own id.
    return list(state.interrupts)


__all__ = ["EventHandler", "run_task"]
