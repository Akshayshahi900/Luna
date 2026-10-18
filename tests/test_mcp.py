import json

from fastmcp import FastMCP

from luna.agent.builder import build_tool_registry
from luna.config import Settings
from luna.mcp.loader import load_mcp_tools


def _demo_server() -> FastMCP:
    mcp = FastMCP("test")

    @mcp.tool()
    def shout(text: str) -> str:
        """Uppercase text."""
        return text.upper()

    return mcp


async def test_load_in_process_server():
    tools = await load_mcp_tools(_demo_server())
    (shout,) = tools
    assert shout.name == "shout"
    assert "HI" in str(await shout.ainvoke({"text": "hi"}))


async def test_missing_config_returns_no_tools(tmp_path):
    assert await load_mcp_tools(tmp_path / "nope.json") == []


async def test_broken_server_does_not_block_startup(tmp_path, capsys):
    config = tmp_path / "mcp.json"
    config.write_text(json.dumps({"mcpServers": {"bad": {"command": "definitely-not-a-real-binary"}}}))
    settings = Settings(mcp_config_path=config, openrouter_api_key="test")

    registry = await build_tool_registry(settings)

    assert "calculator" in registry.names()
    assert "could not load MCP tools" in capsys.readouterr().err


def test_stdio_servers_default_to_project_root(tmp_path):
    from luna.config.settings import PROJECT_ROOT
    from luna.mcp.loader import load_mcp_config

    config = tmp_path / "mcp.json"
    config.write_text(json.dumps({"mcpServers": {
        "a": {"command": "x"},
        "b": {"command": "x", "cwd": "/elsewhere"},
        "c": {"url": "https://example.com/mcp"},
    }}))
    servers = load_mcp_config(config)["mcpServers"]
    assert servers["a"]["cwd"] == str(PROJECT_ROOT)
    assert servers["b"]["cwd"] == "/elsewhere"
    assert "cwd" not in servers["c"]
