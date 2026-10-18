"""
Task scratchpad — short-term working memory for the task in progress.

BEGINNER MAP
------------
The message history is a log of what was said. A scratchpad is different:
it is the agent's *current* view of the task, which it rewrites as it goes.

Two parts, both stored in the agent's state (saved by the checkpointer):
  - todos  — the plan, managed by LangChain's TodoListMiddleware (write_todos)
  - notes  — key → text facts the agent wants to keep (write_note, below)

Every model call gets both rendered into the system prompt. That matters:
  - summarization only rewrites *messages*, so notes and todos survive it
  - they also survive a pause for human approval and the resume after it

Subagent results come back as tool messages; the main agent copies the
important bits into notes so they stay visible for the rest of the task.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Annotated, Any, NotRequired

from langchain.agents.middleware import AgentMiddleware, AgentState
from langchain.agents.middleware.types import ModelRequest, ModelResponse, OmitFromInput
from langchain.tools import ToolRuntime, tool
from langchain_core.messages import SystemMessage, ToolMessage
from langgraph.types import Command

SCRATCHPAD_PROMPT = """
## Task scratchpad

Use `write_note` to keep facts you will need later in this task (results from
helpers, decisions, file paths, numbers). Notes stay visible to you even after
old messages are summarized. Keep each note short. Write an empty note to
delete it once it is no longer needed.
""".strip()


def merge_notes(current: dict[str, str] | None, update: dict[str, str | None]) -> dict[str, str]:
    """Reducer: apply partial updates. ``None`` or empty text deletes a note.

    Merging (instead of replacing the whole dict) means two write_note calls
    in the same step don't overwrite each other.
    """
    merged = dict(current or {})
    for key, value in update.items():
        if value:
            merged[key] = value
        else:
            merged.pop(key, None)
    return merged


class ScratchpadState(AgentState):
    # The reducer must be the LAST Annotated item (that's where LangGraph looks).
    notes: Annotated[NotRequired[dict[str, str]], OmitFromInput, merge_notes]


@tool
def write_note(key: str, content: str, runtime: ToolRuntime) -> Command:
    """Save or update a note in your task scratchpad.

    Args:
        key: Short name for the note, e.g. 'flight_options' or 'user_budget'.
        content: The note text. Use an empty string to delete the note.
    """
    action = "Saved" if content.strip() else "Deleted"
    return Command(
        update={
            "notes": {key: content.strip() or None},
            "messages": [
                ToolMessage(f"{action} note '{key}'.", tool_call_id=runtime.tool_call_id)
            ],
        }
    )


def render_scratchpad(state: dict[str, Any]) -> str:
    """Current todos + notes as prompt text ('' when both are empty)."""
    parts = []
    todos = state.get("todos") or []
    if todos:
        lines = [f"- [{t.get('status', 'pending')}] {t.get('content', '')}" for t in todos]
        parts.append("Current todos:\n" + "\n".join(lines))
    notes = state.get("notes") or {}
    if notes:
        lines = [f"- {key}: {value}" for key, value in notes.items()]
        parts.append("Your notes:\n" + "\n".join(lines))
    return "\n\n".join(parts)


class ScratchpadMiddleware(AgentMiddleware):
    """Adds the notes state + write_note tool, and shows the scratchpad each call."""

    state_schema = ScratchpadState
    tools = [write_note]

    def _with_scratchpad(self, request: ModelRequest) -> ModelRequest:
        text = SCRATCHPAD_PROMPT
        current = render_scratchpad(request.state)
        if current:
            text += "\n\n" + current
        blocks = request.system_message.content_blocks if request.system_message else []
        return request.override(
            system_message=SystemMessage(content=[*blocks, {"type": "text", "text": f"\n\n{text}"}])
        )

    def wrap_model_call(
        self, request: ModelRequest, handler: Callable[[ModelRequest], ModelResponse]
    ) -> ModelResponse:
        return handler(self._with_scratchpad(request))

    async def awrap_model_call(
        self, request: ModelRequest, handler: Callable[[ModelRequest], Awaitable[ModelResponse]]
    ) -> ModelResponse:
        return await handler(self._with_scratchpad(request))


__all__ = ["ScratchpadMiddleware", "merge_notes", "render_scratchpad", "write_note"]
