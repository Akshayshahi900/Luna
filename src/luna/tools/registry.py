"""
ToolRegistry — a shopping bag that holds every tool for the agent.

BEGINNER MAP
------------
Luna can get tools from different places (builtin Python functions, MCP
servers, maybe more later). The agent wants ONE flat list.

This class is that list, with helpers:
  register(tool)      → add one
  register_many([...])→ add many
  list_tools()        → give them to create_agent(...)
  names()             → pretty list for the /tools CLI command

If two tools share the same name, the newest one wins (last writer wins).

How to add a native tool:
  1. Write @tool function in luna.tools.builtin
  2. Put it in get_builtin_tools()
  3. Restart Luna

How to add an MCP server:
  1. Edit config/mcp_servers.json
  2. Restart Luna
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Sequence

from langchain_core.tools import BaseTool


@dataclass
class ToolRegistry:
    """Simple in-memory collection of LangChain tools."""

    # Private lists/sets: callers should use the methods below.
    _tools: list[Any] = field(default_factory=list)
    _names: set[str] = field(default_factory=set)

    def register(self, tool: Any) -> None:
        """Add one tool. Replaces any existing tool with the same name."""
        # LangChain tools usually have .name; plain functions have __name__.
        name = getattr(tool, "name", None) or getattr(tool, "__name__", None)
        if name is None:
            raise TypeError(f"Cannot determine tool name for {tool!r}")
        if name in self._names:
            # Drop the old tool with this name, then add the new one.
            self._tools = [
                t
                for t in self._tools
                if getattr(t, "name", getattr(t, "__name__", None)) != name
            ]
            self._names.discard(name)
        self._tools.append(tool)
        self._names.add(name)

    def register_many(self, tools: Sequence[Any]) -> None:
        """Register several tools in order."""
        for tool in tools:
            self.register(tool)

    def list_tools(self) -> list[Any]:
        """Return a copy of the tool list (safe to pass to create_agent)."""
        return list(self._tools)

    def names(self) -> list[str]:
        """Sorted tool names — handy for printing."""
        return sorted(self._names)

    def clear(self) -> None:
        """Remove every registered tool."""
        self._tools.clear()
        self._names.clear()


__all__ = ["ToolRegistry", "BaseTool"]
