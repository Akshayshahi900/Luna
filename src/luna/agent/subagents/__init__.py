"""Subagents package — helper agents wrapped as delegate tools.

base.py        SubagentSpec + make_delegate_tool (how a subagent runs)
researcher.py  web research (Tavily)
files.py       read / search / write files in the workspace
coder.py       code changes + running commands in the workspace
assistant.py   personal tasks through MCP servers tagged "agent": "assistant"

get_subagent_specs() decides which subagents are switched on: each spec
function returns None when what it needs (API key, MCP server, …) is missing.
"""

from __future__ import annotations

import sys
from typing import Any

from luna.agent.subagents.assistant import assistant_spec
from luna.agent.subagents.base import SubagentSpec, make_delegate_tool, needs_approval
from luna.agent.subagents.coder import coder_spec
from luna.agent.subagents.files import files_spec
from luna.agent.subagents.researcher import researcher_spec
from luna.config import Settings
from luna.mcp.loader import is_risky_tool_name


def get_subagent_specs(
    settings: Settings,
    mcp_groups: dict[str | None, list[Any]] | None = None,
) -> list[SubagentSpec]:
    """Every subagent whose requirements are met, in a stable order.

    ``mcp_groups`` maps an MCP "agent" tag to its tools. "assistant" tools
    create the assistant; any other tag adds tools to the subagent of that
    name (e.g. "researcher" → ask_researcher), with approval for risky names.
    """
    mcp_groups = mcp_groups or {}
    candidates = [
        researcher_spec(settings),
        files_spec(settings),
        coder_spec(settings),
        assistant_spec(settings, mcp_groups.get("assistant", [])),
    ]
    specs = [spec for spec in candidates if spec is not None]

    by_tag = {spec.name.removeprefix("ask_"): spec for spec in specs}
    for tag, tools in mcp_groups.items():
        if tag in (None, "assistant") or not tools:
            continue
        spec = by_tag.get(tag)
        if spec is None:
            print(
                f"Warning: MCP servers tagged agent='{tag}' have no matching helper "
                f"(known: {', '.join(sorted(by_tag))}). Their tools are not used.",
                file=sys.stderr,
            )
            continue
        risky = [t.name for t in tools if is_risky_tool_name(t.name)]
        spec.tools = [*spec.tools, *tools]
        spec.interrupt_on = {**spec.interrupt_on, **needs_approval(risky, settings.auto_approve)}
    return specs


__all__ = ["SubagentSpec", "get_subagent_specs", "make_delegate_tool", "needs_approval"]
