"""
Load tools from MCP servers and turn them into LangChain tools.

BEGINNER MAP
------------
MCP = Model Context Protocol.

Think of it as a USB standard for AI tools:
  - An MCP *server* is a small program that exposes tools.
  - An MCP *client* (here: LangChain's MCPAdapter) plugs in and asks
    "what tools do you have?" then can call them.

Why bother?
  So Luna can use tools written by other people / other processes
  without copying their code into this repo.

Config file (default: config/mcp_servers.json)::

    {
      "mcpServers": {
        "demo": {
          "command": "uv",
          "args": ["run", "python", "servers/demo_mcp_server.py"]
        }
      }
    }

That entry means: "start this command as a subprocess and talk to it."
You can also use {"url": "https://..."} for remote HTTP MCP servers.

Disable with LUNA_ENABLE_MCP_TOOLS=false.

Read next: servers/demo_mcp_server.py (a tiny MCP server example).
"""

from __future__ import annotations

import json
import warnings
from pathlib import Path
from typing import Any


def load_mcp_config(path: Path | str) -> dict[str, Any] | None:
    """Read mcp_servers.json. Return None if missing or has no servers."""
    config_path = Path(path)
    if not config_path.exists():
        return None

    data = json.loads(config_path.read_text(encoding="utf-8"))
    servers = data.get("mcpServers") or {}
    if not servers:
        return None
    return data


async def load_mcp_tools(config: dict[str, Any] | Path | str | None) -> list[Any]:
    """Connect to MCP server(s) and return a list of LangChain tools.

    Parameters
    ----------
    config:
        Either a path to JSON, or an already-parsed dict with key "mcpServers".

    Returns
    -------
    list
        Empty list if there is nothing to connect to.
        Otherwise LangChain tool objects the agent can call like builtins.
    """
    if config is None:
        return []

    if isinstance(config, (str, Path)):
        loaded = load_mcp_config(config)
        if loaded is None:
            return []
        target: Any = loaded
    else:
        target = config

    # langchain.mcp is still labeled beta; avoid spamming the CLI with warnings.
    with warnings.catch_warnings():
        warnings.filterwarnings("ignore", category=UserWarning, module="langchain")
        from langchain.mcp import MCPAdapter

    # Opening the adapter connects to the server(s).
    # list_tools() asks each server for its tool catalog and wraps them.
    # After the `async with` block, tools still work (they reconnect per call).
    async with MCPAdapter(target) as adapter:
        tools = await adapter.list_tools()
    return list(tools)


__all__ = ["load_mcp_config", "load_mcp_tools"]
