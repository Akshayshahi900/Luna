"""
Agent routines: a prompt the agent runs on a schedule, with nobody watching.

BEGINNER MAP
------------
An agent routine is like typing the prompt into Luna yourself, except:

  - it runs on its own thread, "routine-<id>", so it doesn't mix with your
    conversations (you can still open that thread in the transcript)
  - it gets the usual TaskBudget, so a routine can't burn more model calls
    than one normal message
  - nobody is there to approve risky tools, so every approval pause is
    REJECTED ("No one was there to approve this"). Tools you listed in
    LUNA_AUTO_APPROVE never pause, so they still run. A question
    (ask_user) gets "The user is away" and the agent carries on.

This keeps D9 (risky actions need a human) intact: routines can read and
summarize, but only change things you already allowed without asking.

The final reply of the agent becomes the run summary.

Read next: luna/routines/scheduler.py
"""

from __future__ import annotations

from typing import Any

from langgraph.types import Command

from luna.agent.budget import TaskBudget
from luna.agent.builder import recursion_limit
from luna.agent.runner import EventHandler, run_task
from luna.config import Settings
from luna.web.events import build_answer, describe_pause

# Pauses answered automatically before the routine gives up.
MAX_RESUMES = 5
REJECTED = "No one was there to approve this (scheduled routine). Don't retry; report what you would have done."
AWAY = "The user is away (this is a scheduled routine). Carry on without asking, or say what you need."
SUMMARY_CHARS = 600


def routine_thread(routine_id: int) -> str:
    """The thread an agent routine runs on."""
    return f"routine-{routine_id}"


def auto_answer(pause: dict[str, Any]) -> Any:
    """The browser-format reply for a pause nobody is there to answer."""
    if pause["kind"] == "approval":
        return {"decisions": [{"type": "reject", "message": REJECTED} for _ in pause["actions"]]}
    return {"answer": AWAY}


def _final_text(messages: list[Any]) -> str:
    last = next((m for m in reversed(messages) if m.type == "ai" and m.text), None)
    text = " ".join((last.text if last else "").split())
    return text if len(text) <= SUMMARY_CHARS else text[: SUMMARY_CHARS - 1] + "…"


async def run_agent_routine(
    agent: Any,
    routine: dict[str, Any],
    settings: Settings,
    on_event: EventHandler | None = None,
) -> tuple[str, str, Any]:
    """Run the routine's prompt to the end; returns (status, summary, data).

    data = {"thread": ..., "rejected": [tool names refused for lack of approval]}.
    """
    config = {
        "configurable": {"thread_id": routine_thread(routine["id"])},
        "recursion_limit": recursion_limit(settings),
    }
    budget = TaskBudget(limit=settings.task_budget)
    payload: Any = {"messages": [{"role": "user", "content": routine["prompt"]}]}
    rejected: list[str] = []
    for _ in range(MAX_RESUMES + 1):
        interrupts = await run_task(agent, payload, config, budget=budget, on_event=on_event)
        if not interrupts:
            break
        pauses = [describe_pause(i) for i in interrupts]
        for pause in pauses:
            rejected += [a["name"] for a in pause.get("actions", [])]
        payload = Command(resume={p["id"]: build_answer(p, auto_answer(p)) for p in pauses})
    else:
        return "error", "Gave up: the routine kept asking for approval.", {"thread": config["configurable"]["thread_id"], "rejected": rejected}

    summary = "(no reply)"
    if agent.checkpointer is not None:
        state = await agent.aget_state(config)
        summary = _final_text(state.values.get("messages", [])) or summary
    data = {"thread": config["configurable"]["thread_id"], "rejected": rejected}
    return "ok", summary, data


__all__ = ["auto_answer", "routine_thread", "run_agent_routine"]
