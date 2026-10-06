"""
Example MCP *server* — a tiny separate program that exposes tools.

BEGINNER MAP
------------
This file is NOT imported into the Luna agent as normal Python.

Instead, when config/mcp_servers.json says:

  "command": "uv", "args": ["run", "python", "servers/demo_mcp_server.py"]

Luna starts this script as another process and talks to it over stdio
(standard input/output) using the MCP protocol.

@mcp.tool() is like LangChain's @tool, but for an MCP server:
  the decorator publishes the function so clients can discover and call it.

Try it alone (you'll see a FastMCP banner; it waits for MCP messages)::

    uv run python servers/demo_mcp_server.py

In Luna, after startup, /tools should list reverse_text and word_count
(unless MCP is disabled).
"""

from __future__ import annotations

from fastmcp import FastMCP

# Create a named MCP server. Clients see this name when they connect.
mcp = FastMCP("luna-demo")


@mcp.tool()
def reverse_text(text: str) -> str:
    """Reverse a string and return it."""
    return text[::-1]


@mcp.tool()
def word_count(text: str) -> int:
    """Count whitespace-separated words in text."""
    return len(text.split())


if __name__ == "__main__":
    # stdio = talk through stdin/stdout (what MCP clients expect for local tools).
    mcp.run(transport="stdio")
