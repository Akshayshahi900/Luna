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

Add "agent": "<name>" to a server to give its tools to that subagent
instead of the main agent, e.g. "agent": "assistant" for calendar / mail
servers (see split_by_agent below).

Disable with LUNA_ENABLE_MCP_TOOLS=false.

Read next: servers/demo_mcp_server.py (a tiny MCP server example).
"""

from __future__ import annotations

import json
import re
import warnings
from pathlib import Path
from typing import Any

from luna.config.settings import PROJECT_ROOT


def load_mcp_config(path: Path | str) -> dict[str, Any] | None:
    """Read mcp_servers.json. Return None if missing or has no servers."""
    config_path = Path(path)
    if not config_path.exists():
        return None

    data = json.loads(config_path.read_text(encoding="utf-8"))
    # "disabled": true (set from the Control Center) keeps an entry without loading it.
    servers = {
        name: {k: v for k, v in server.items() if k != "disabled"}
        for name, server in (data.get("mcpServers") or {}).items()
        if not server.get("disabled")
    }
    if not servers:
        return None
    data["mcpServers"] = servers
    # Relative paths in "args" (e.g. servers/demo_mcp_server.py) mean "from the
    # project root", so run stdio servers there unless the entry sets its own cwd.
    for server in servers.values():
        if "command" in server:
            server.setdefault("cwd", str(PROJECT_ROOT))
    return data


def split_by_agent(config: dict[str, Any]) -> dict[str | None, dict[str, Any]]:
    """Group servers by their optional ``"agent"`` tag.

    ``{"mcpServers": {"gcal": {..., "agent": "assistant"}, "docs": {...}}}``
    becomes ``{"assistant": {"mcpServers": {"gcal": ...}}, None: {"mcpServers": {"docs": ...}}}``.
    Untagged servers (key None) belong to the main agent; a tag names the
    subagent that gets those tools (e.g. "assistant" → ask_assistant).
    The tag itself is removed before the config reaches MCPAdapter.
    """
    groups: dict[str | None, dict[str, Any]] = {}
    for name, server in (config.get("mcpServers") or {}).items():
        server = dict(server)
        agent = server.pop("agent", None)
        groups.setdefault(agent, {"mcpServers": {}})["mcpServers"][name] = server
    return groups


# Words in a tool name that mean it changes something outside Luna.
_RISKY_WORDS = {
    "send", "create", "update", "delete", "remove", "write", "edit", "post", "reply",
    "cancel", "move", "modify", "insert", "upload", "archive", "add", "set", "submit",
    "invite", "share", "trash", "patch", "put", "rename", "forward",
}


def is_risky_tool_name(name: str) -> bool:
    """True if the tool name contains a word like send/create/delete.

    Names are split on _ - . and camelCase, so 'send_email' and 'createEvent'
    are risky but 'get_settings' is not.
    """
    words = re.split(r"[_\-.\s]+|(?<=[a-z0-9])(?=[A-Z])", name)
    return any(word.lower() in _RISKY_WORDS for word in words if word)


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
        warnings.filterwarnings("ignore", message=r".*langchain\.mcp.* is in beta")
        from langchain.mcp import MCPAdapter

    # Opening the adapter connects to the server(s).
    # list_tools() asks each server for its tool catalog and wraps them.
    # After the `async with` block, tools still work (they reconnect per call).
    async with MCPAdapter(target) as adapter:
        tools = await adapter.list_tools()
    return list(tools)


__all__ = ["is_risky_tool_name", "load_mcp_config", "load_mcp_tools", "split_by_agent"]
