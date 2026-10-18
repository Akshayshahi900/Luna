import json
import sys

from langchain.agents.middleware import HumanInTheLoopMiddleware
from langchain.tools import tool

from luna.agent.builder import build_middleware, build_tool_registry, load_mcp_groups
from luna.agent.subagents import get_subagent_specs
from luna.config import Settings
from luna.config.settings import PROJECT_ROOT
from luna.mcp.loader import is_risky_tool_name, split_by_agent


def _settings(tmp_path, **overrides):
    overrides.setdefault("workspace_dirs", [tmp_path / "ws"])
    return Settings(openrouter_api_key="test", **overrides)


def _fake_tool(name):
    @tool(name)
    def _t() -> str:
        """Fake MCP tool."""
        return "ok"

    return _t


def test_split_by_agent_removes_the_tag():
    groups = split_by_agent({"mcpServers": {
        "cal": {"url": "u", "agent": "assistant"},
        "docs": {"url": "d"},
    }})
    assert groups == {"assistant": {"mcpServers": {"cal": {"url": "u"}}},
                      None: {"mcpServers": {"docs": {"url": "d"}}}}


def test_risky_names():
    for name in ["send_email", "createEvent", "calendar.delete", "add-task", "update_event"]:
        assert is_risky_tool_name(name), name
    for name in ["list_events", "get_settings", "search", "read_inbox", "reset"]:
        assert not is_risky_tool_name(name), name


def test_assistant_only_exists_with_tagged_tools(tmp_path):
    settings = _settings(tmp_path)
    assert "ask_assistant" not in {s.name for s in get_subagent_specs(settings, {})}

    tools = [_fake_tool("list_events"), _fake_tool("create_event")]
    specs = {s.name: s for s in get_subagent_specs(settings, {"assistant": tools})}
    assistant = specs["ask_assistant"]
    assert {t.name for t in assistant.tools} == {"list_events", "create_event", "get_current_time"}
    assert assistant.interrupt_on == {"create_event": True}


def test_auto_approve_applies_to_mcp_tools(tmp_path):
    settings = _settings(tmp_path, auto_approve=["create_event"])
    specs = {s.name: s for s in get_subagent_specs(settings, {"assistant": [_fake_tool("create_event")]})}
    assert specs["ask_assistant"].interrupt_on == {}


def test_other_tags_extend_that_subagent(tmp_path, capsys):
    settings = _settings(tmp_path, tavily_api_key="tvly-test")
    groups = {"researcher": [_fake_tool("docs_search"), _fake_tool("docs_delete")],
              "nobody": [_fake_tool("orphan")]}
    specs = {s.name: s for s in get_subagent_specs(settings, groups)}

    assert "docs_search" in {t.name for t in specs["ask_researcher"].tools}
    assert specs["ask_researcher"].interrupt_on == {"docs_delete": True}
    assert "agent='nobody'" in capsys.readouterr().err


def test_main_agent_gets_approval_middleware_for_risky_tools(tmp_path):
    settings = _settings(tmp_path, summary_trigger_tokens=0)  # no summarizer model needed
    assert not any(isinstance(m, HumanInTheLoopMiddleware) for m in build_middleware(settings, None))
    middleware = build_middleware(settings, None, {"send_email": True})
    assert any(isinstance(m, HumanInTheLoopMiddleware) for m in middleware)


async def test_tagged_server_tools_skip_the_main_agent(tmp_path):
    # Real stdio MCP server (the demo), tagged for the assistant.
    config = tmp_path / "mcp.json"
    config.write_text(json.dumps({"mcpServers": {"demo": {
        "command": sys.executable,
        "args": [str(PROJECT_ROOT / "servers" / "demo_mcp_server.py")],
        "agent": "assistant",
    }}}))
    settings = _settings(tmp_path, mcp_config_path=config)

    groups = await load_mcp_groups(settings)
    registry = await build_tool_registry(settings, groups)

    assert {t.name for t in groups["assistant"]} == {"reverse_text", "word_count"}
    assert "reverse_text" not in registry.names()
    specs = {s.name: s for s in get_subagent_specs(settings, groups)}
    assert "reverse_text" in {t.name for t in specs["ask_assistant"].tools}
