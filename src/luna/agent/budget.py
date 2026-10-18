"""
Task budget — one model-call allowance shared by the main agent and all subagents.

BEGINNER MAP
------------
Each agent already has its own loop limit (e.g. main 10, researcher 5).
But the main agent can call several subagents, each using its full limit,
so the worst case multiplies. The task budget caps the TOTAL number of
model calls for one user message, across every agent.

How it works:
  1. run_task() (luna/agent/runner.py) creates a TaskBudget for the message
     and stores it in a context variable.
  2. Every agent (main + subagents) has TaskBudgetMiddleware. Before each
     model call it takes one unit from the shared budget.
  3. When the budget is empty, the agent stops with a short message instead
     of calling the model again.

Context variables are copied into every async task LangGraph starts, and
the copy points at the same TaskBudget object, so parallel subagents all
draw from one budget.
"""

from __future__ import annotations

from contextvars import ContextVar
from dataclasses import dataclass
from typing import Any

from langchain.agents.middleware import AgentMiddleware, hook_config
from langchain_core.messages import AIMessage

# Text the stop message starts with (subagents look for it to mark partial results).
BUDGET_MESSAGE_PREFIX = "Task budget exhausted"


@dataclass
class TaskBudget:
    """How many model calls one user message may use, across all agents."""

    limit: int
    used: int = 0

    @property
    def remaining(self) -> int:
        return max(self.limit - self.used, 0)


current_budget: ContextVar[TaskBudget | None] = ContextVar("luna_task_budget", default=None)


class TaskBudgetMiddleware(AgentMiddleware):
    """Take one unit from the current TaskBudget before every model call.

    Without an active budget (e.g. an agent invoked directly in a test) it
    does nothing, so agents still work outside run_task().
    """

    @hook_config(can_jump_to=["end"])
    def before_model(self, state: Any, runtime: Any) -> dict[str, Any] | None:
        budget = current_budget.get()
        if budget is None:
            return None
        if budget.used >= budget.limit:
            message = f"{BUDGET_MESSAGE_PREFIX} ({budget.limit} model calls for this task)."
            return {"jump_to": "end", "messages": [AIMessage(content=message)]}
        budget.used += 1
        return None

    @hook_config(can_jump_to=["end"])
    async def abefore_model(self, state: Any, runtime: Any) -> dict[str, Any] | None:
        return self.before_model(state, runtime)


__all__ = ["BUDGET_MESSAGE_PREFIX", "TaskBudget", "TaskBudgetMiddleware", "current_budget"]
