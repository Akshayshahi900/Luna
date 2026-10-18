"""
cap_output — stop one tool result from flooding the model's context.

Web pages, file contents and command output can be huge. Wrapping a tool
with cap_output() keeps its name, description and arguments, but cuts the
result to ``max_chars`` and says so, so the model knows to ask for less
(e.g. a narrower query or a line range).
"""

from __future__ import annotations

import json
from typing import Any

from langchain_core.tools import BaseTool, StructuredTool


def _as_text(result: Any) -> str:
    if isinstance(result, str):
        return result
    try:
        return json.dumps(result, ensure_ascii=False, default=str)
    except TypeError:
        return str(result)


def cap_output(tool: BaseTool, max_chars: int = 8000) -> BaseTool:
    """Return a copy of ``tool`` whose results are at most ``max_chars`` long."""

    async def run(**kwargs: Any) -> str:
        text = _as_text(await tool.ainvoke(kwargs))
        if len(text) <= max_chars:
            return text
        dropped = len(text) - max_chars
        return f"{text[:max_chars]}\n…[truncated {dropped} characters]"

    return StructuredTool.from_function(
        coroutine=run,
        name=tool.name,
        description=tool.description,
        args_schema=tool.args_schema,
        metadata=tool.metadata,
    )


__all__ = ["cap_output"]
