"""
Assistant subagent — personal tasks through MCP servers (calendar, mail, to-dos).

Why a subagent (spec2 rule 2): personal-service MCP servers bring many
look-alike tools (list_events, create_event, update_event, …). Grouping
them behind one ask_assistant tool keeps the main agent's tool list short.

Enabled only when at least one server in config/mcp_servers.json has
"agent": "assistant". Tools whose names change something (send, create,
update, delete, …) ask for approval unless listed in LUNA_AUTO_APPROVE.
"""

from __future__ import annotations

from typing import Any

from luna.agent.subagents.base import SubagentSpec, needs_approval
from luna.config import Settings
from luna.mcp.loader import is_risky_tool_name
from luna.tools.builtin import get_current_time

ASSISTANT_PROMPT = """
You are Luna's personal-assistant helper. You manage the user's calendar,
email, tasks and similar services through your tools.

- Check before acting: look up existing events, threads or tasks first.
- Use get_current_time for "today", "tomorrow", etc., and always state dates
  with the timezone.
- Only act on details given in the task; if something essential is missing,
  say what is missing instead of guessing.
- Actions that send or change things ask the user for approval. If the user
  rejects one, do not retry it; report back.
- Reply in at most 300 words: what you found or did, with dates and names.
""".strip()

DESCRIPTION = (
    "Personal tasks: check or change the user's calendar, read or send email, "
    "manage to-dos and reminders. Actions that send or change things ask the "
    "user for approval."
)


def assistant_spec(settings: Settings, mcp_tools: list[Any]) -> SubagentSpec | None:
    """The assistant, or None when no MCP server is tagged for it."""
    if not mcp_tools:
        return None
    risky = [t.name for t in mcp_tools if is_risky_tool_name(t.name)]
    return SubagentSpec(
        name="ask_assistant",
        description=DESCRIPTION,
        system_prompt=ASSISTANT_PROMPT,
        tools=[*mcp_tools, get_current_time],
        interrupt_on=needs_approval(risky, settings.auto_approve),
        max_model_calls=10,
        timeout_seconds=180,
    )


__all__ = ["assistant_spec"]
