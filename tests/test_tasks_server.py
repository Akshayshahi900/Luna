import importlib.util
import json

import pytest
from langchain.tools import tool

from luna.agent.subagents import get_subagent_specs
from luna.config import Settings
from luna.config.settings import PROJECT_ROOT
from luna.mcp.loader import load_mcp_config, load_mcp_tools, split_by_agent

# servers/ is not a package, so load the script by path.
_spec = importlib.util.spec_from_file_location("tasks_mcp_server", PROJECT_ROOT / "servers" / "tasks_mcp_server.py")
tasks_server = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(tasks_server)


def _fake_tool(name):
    @tool(name)
    def _t() -> str:
        """Fake MCP tool."""
        return "ok"

    return _t


@pytest.fixture
def tools(tmp_path, monkeypatch):
    monkeypatch.setenv("LUNA_TASKS_PATH", str(tmp_path / "tasks.json"))

    async def load():
        return {t.name: t for t in await load_mcp_tools(tasks_server.mcp)}

    return load


async def test_add_list_done_delete(tools, tmp_path):
    t = await tools()
    assert set(t) == {"list_tasks", "add_task", "set_task_done", "delete_task"}

    await t["add_task"].ainvoke({"title": "later"})
    await t["add_task"].ainvoke({"title": "dentist", "due": "2026-10-20"})
    stored = json.loads((tmp_path / "tasks.json").read_text())
    assert [s["title"] for s in stored] == ["later", "dentist"]

    # Soonest due first, undated last.
    listed = tasks_server.list_tasks()
    assert [x["title"] for x in listed] == ["dentist", "later"]

    await t["set_task_done"].ainvoke({"task_id": 2})
    assert [x["title"] for x in tasks_server.list_tasks()] == ["later"]
    assert len(tasks_server.list_tasks(include_done=True)) == 2

    await t["delete_task"].ainvoke({"task_id": 1})
    assert [x["id"] for x in tasks_server.list_tasks(include_done=True)] == [2]


def test_ids_keep_increasing_after_delete(tmp_path, monkeypatch):
    monkeypatch.setenv("LUNA_TASKS_PATH", str(tmp_path / "tasks.json"))
    tasks_server.add_task("a")
    tasks_server.add_task("b")
    tasks_server.delete_task(1)
    assert tasks_server.add_task("c")["id"] == 3


def test_bad_input_is_rejected(tmp_path, monkeypatch):
    monkeypatch.setenv("LUNA_TASKS_PATH", str(tmp_path / "tasks.json"))
    with pytest.raises(ValueError, match="due must be"):
        tasks_server.add_task("x", due="next tuesday")
    with pytest.raises(ValueError, match="title"):
        tasks_server.add_task("   ")
    with pytest.raises(ValueError, match="No task with id 7"):
        tasks_server.set_task_done(7)
    assert tasks_server.add_task("x", due="2026-10-20T09:30:00")["due"] == "2026-10-20T09:30"


def test_repo_config_routes_tasks_to_assistant_with_approval(tmp_path):
    config = load_mcp_config(PROJECT_ROOT / "config" / "mcp_servers.json")
    groups = split_by_agent(config)
    assert "tasks" in groups["assistant"]["mcpServers"]

    names = ["list_tasks", "add_task", "set_task_done", "delete_task"]
    tasks_tools = [_fake_tool(n) for n in names]
    settings = Settings(openrouter_api_key="test", workspace_dirs=[tmp_path / "ws"])
    specs = {s.name: s for s in get_subagent_specs(settings, {"assistant": tasks_tools})}
    assert specs["ask_assistant"].interrupt_on == {
        "add_task": True, "set_task_done": True, "delete_task": True,
    }
