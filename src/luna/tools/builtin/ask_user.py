"""
ask_user — let the agent pause and ask you a question.

BEGINNER MAP
------------
interrupt() stops the agent graph and saves its state (needs a
checkpointer). The CLI sees the pause, shows the question, and resumes the
graph with your answer, which becomes this tool's return value.
"""

from __future__ import annotations

from langchain.tools import tool
from langgraph.types import interrupt


@tool
def ask_user(question: str) -> str:
    """Ask the user a clarifying question and wait for their answer.

    Use only when you cannot continue without information only the user has
    (a preference, a missing detail, a choice between options). Do not use it
    to confirm actions; risky actions already ask for approval.

    Args:
        question: One clear, specific question.
    """
    answer = interrupt({"type": "ask_user", "question": question})
    return str(answer).strip() or "(no answer)"
