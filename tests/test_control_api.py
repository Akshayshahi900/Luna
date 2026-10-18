"""The Control Center API (/api/control/*): settings saved to a temp .env,
MCP connectors in a temp JSON, permissions, stats, dashboard and routines.
Fake model and fake tools; nothing touches the real .env or config."""

import json

from langchain.agents import create_agent
from langchain.tools import tool
from langgraph.checkpoint.memory import InMemorySaver
import pytest
from starlette.testclient import TestClient

from luna.agent.longterm import LongTermStore
from luna.config import Settings
from luna.routines import RoutineStore
from luna.web.server import create_app


@tool
def list_tasks(include_done: bool = False) -> str:
    """Fake to-dos."""
    return json.dumps([{"title": "Pay rent", "due": None, "done": False}])


@tool
def delete_task(task_id: int) -> str:
    """Fake risky tool."""
    return "deleted"


@pytest.fixture
def paths(tmp_path):
    env = tmp_path / ".env"
    env.write_text("# my settings\nLUNA_UNITS=metric\nLUNA_DEFAULT_THREAD_ID=old\n")
    mcp = tmp_path / "mcp.json"
    mcp.write_text(json.dumps({"mcpServers": {
        "demo": {"command": "uv", "args": ["run", "demo.py"]},
        "tasks": {"command": "uv", "args": ["run", "tasks.py"], "agent": "assistant", "env": {"TOKEN": "s3cret"}},
    }}))
    return {"env": env, "mcp": mcp, "dashboard": tmp_path / "dashboard.json", "tmp": tmp_path}


@pytest.fixture
def client(paths, make_fake_model):
    settings = Settings(
        _env_file=paths["env"],
        openrouter_api_key="test",
        mcp_config_path=paths["mcp"],
        google_token_path=paths["tmp"] / "token.json",
        google_credentials_path=paths["tmp"] / "credentials.json",
        workspace_dirs=[paths["tmp"]],
    )
    agent = create_agent(model=make_fake_model(*["Done."] * 10), tools=[], checkpointer=InMemorySaver())
    rebuilt = []

    async def rebuild(provider, model):
        rebuilt.append((provider, model))
        return agent

    app = create_app(
        agent=agent,
        settings=settings,
        rebuild=rebuild,
        memory_store=LongTermStore(),
        routine_store=RoutineStore(),
        mcp_groups={"assistant": [list_tasks, delete_task]},
        env_path=paths["env"],
        dashboard_path=paths["dashboard"],
    )
    with TestClient(app) as c:
        c.rebuilt = rebuilt
        yield c


def test_other_origins_are_refused(client):
    for method, path in [("get", "settings"), ("patch", "settings"), ("get", "stats"), ("put", "mcp/x")]:
        r = getattr(client, method)(f"/api/control/{path}", headers={"origin": "http://evil.example"})
        assert r.status_code == 403


def test_settings_schema_masks_secrets(client):
    data = client.get("/api/control/settings").json()
    fields = {f["name"]: f for g in data["groups"] for f in g["fields"]}
    assert fields["openrouter_api_key"]["value"] is None and fields["openrouter_api_key"]["is_set"]
    assert "test" not in json.dumps(fields["openrouter_api_key"])
    assert data["unknown"] == ["LUNA_DEFAULT_THREAD_ID"]
    assert data["restart_required"] == []


def test_saving_settings_writes_env_rebuilds_and_flags_restarts(client, paths):
    with client.websocket_connect("/ws") as ws:
        ws.receive_json()  # hello
        r = client.patch("/api/control/settings", json={"values": {"units": "imperial", "web_port": 9001}})
        assert r.status_code == 200
        body = r.json()
        assert body["effects"] == {"units": "rebuild", "web_port": "restart"}
        assert body["rebuilt"] is True and body["restart_required"] == ["web_port"]
        event = next(m for m in iter(ws.receive_json, None) if m["type"] == "settings_changed")
        assert event["keys"] == ["units", "web_port"]
    assert client.rebuilt  # agent rebuilt with the same provider / model
    assert paths["env"].read_text() == "# my settings\nLUNA_UNITS=imperial\nLUNA_DEFAULT_THREAD_ID=old\nLUNA_WEB_PORT=9001\n"
    # Values that weren't saved stay as the server started with them.
    assert client.app.state.host.settings.mcp_config_path == paths["mcp"]
    assert client.app.state.host.settings.units == "imperial"


def test_invalid_settings_are_refused_and_file_kept(client, paths):
    before = paths["env"].read_text()
    r = client.patch("/api/control/settings", json={"values": {"units": "cubits"}})
    assert r.status_code == 400 and "LUNA_UNITS" in r.json()["error"]
    assert client.patch("/api/control/settings", json={"values": {}}).status_code == 400
    assert paths["env"].read_text() == before


def test_unknown_keys_can_be_removed(client, paths):
    r = client.patch("/api/control/settings", json={"values": {}, "remove_unknown": ["LUNA_DEFAULT_THREAD_ID"]})
    assert r.status_code == 200 and r.json()["unknown"] == []
    assert "DEFAULT_THREAD_ID" not in paths["env"].read_text()


def test_mcp_list_add_disable_and_remove(client, paths):
    data = client.get("/api/control/mcp").json()
    servers = {s["name"]: s for s in data["servers"]}
    assert servers["tasks"]["agent"] == "assistant" and servers["tasks"]["status"] == "ok"
    assert servers["tasks"]["env_keys"] == ["TOKEN"] and "s3cret" not in json.dumps(data)

    r = client.put("/api/control/mcp/docs", json={"url": "https://example.com/mcp", "agent": "researcher"})
    assert r.status_code == 200
    assert {s["name"]: s["status"] for s in r.json()["servers"]}["docs"] == "restart"

    r = client.put("/api/control/mcp/tasks", json={"command": "uv", "args": ["run", "tasks.py"], "agent": "assistant", "disabled": True})
    saved = json.loads(paths["mcp"].read_text())["mcpServers"]
    assert saved["tasks"]["disabled"] is True and saved["tasks"]["env"] == {"TOKEN": "s3cret"}  # env kept
    assert {s["name"]: s["status"] for s in r.json()["servers"]}["tasks"] == "off"
    assert '"args": ["run", "tasks.py"]' in paths["mcp"].read_text()  # compact like the hand-written file

    assert client.delete("/api/control/mcp/docs").status_code == 200
    assert "docs" not in json.loads(paths["mcp"].read_text())["mcpServers"]
    assert client.delete("/api/control/mcp/docs").status_code == 404
    assert "mcp_servers" in client.get("/api/control/settings").json()["restart_required"]


def test_mcp_validation(client):
    assert client.put("/api/control/mcp/bad name", json={"url": "https://x"}).status_code == 400
    assert client.put("/api/control/mcp/x", json={}).status_code == 400
    assert client.put("/api/control/mcp/x", json={"url": "ftp://x"}).status_code == 400
    assert client.put("/api/control/mcp/x", json={"url": "https://x", "agent": "boss"}).status_code == 400


def test_disabled_servers_are_not_loaded(tmp_path):
    from luna.mcp.loader import load_mcp_config

    config = tmp_path / "mcp.json"
    config.write_text(json.dumps({"mcpServers": {"a": {"command": "x"}, "b": {"command": "y", "disabled": True}}}))
    servers = load_mcp_config(config)["mcpServers"]
    assert list(servers) == ["a"] and "disabled" not in servers["a"]
    config.write_text(json.dumps({"mcpServers": {"b": {"command": "y", "disabled": True}}}))
    assert load_mcp_config(config) is None


def test_connections_without_google(client):
    data = client.get("/api/control/connections").json()
    assert data["google"]["token"] is False and data["google"]["client_file"] is False
    assert data["keys"]["openrouter"] is True
    r = client.post("/api/control/connections/google")
    assert r.status_code == 400 and "OAuth client file" in r.json()["error"]


def test_providers_and_saving_the_default(client, paths):
    data = client.get("/api/control/providers").json()
    assert data["current"]["provider"] == "openrouter"
    assert {p["id"] for p in data["providers"]} == {"openrouter", "groq", "ollama"}
    r = client.post("/api/control/providers/default", json={"provider": "ollama", "model": "qwen3:8b", "apply": True})
    assert r.status_code == 200
    assert r.json()["default"] == {"provider": "ollama", "model": "qwen3:8b"}
    assert r.json()["current"] == {"provider": "ollama", "model": "qwen3:8b"}
    assert "LUNA_PROVIDER=ollama" in paths["env"].read_text()
    assert "LUNA_OLLAMA_MODEL=qwen3:8b" in paths["env"].read_text()
    assert client.post("/api/control/providers/default", json={"provider": "nope"}).status_code == 400


def test_permissions_list_helper_tools(client):
    data = client.get("/api/control/permissions").json()
    tools = {(t["owner"], t["name"]): t for t in data["tools"]}
    assert tools[("assistant", "delete_task")]["mode"] == "ask"
    assert tools[("assistant", "list_tasks")]["mode"] == "free"
    r = client.patch("/api/control/settings", json={"values": {"auto_approve": ["delete_task"]}})
    assert r.status_code == 200
    data = client.get("/api/control/permissions").json()
    assert {(t["owner"], t["name"]): t for t in data["tools"]}[("assistant", "delete_task")]["mode"] == "auto"
    assert data["auto_approve"] == ["delete_task"]


def test_stats_count_usage_from_chat(client):
    with client.websocket_connect("/ws") as ws:
        ws.send_json({"type": "message", "text": "hi"})
        while ws.receive_json()["type"] != "done":
            pass
    stats = client.get("/api/control/stats").json()
    assert stats["usage"]["since_start"]["runs"] == 1
    assert stats["usage"]["since_start"]["model_calls"] == 1
    assert stats["usage"]["days"][-1]["model_calls"] == 1
    assert stats["memory"]["total"] == 0
    assert stats["sessions"]["count"] == 1
    assert stats["routines"]["total"] == 3  # the seeded built-ins
    assert stats["process"]["rss"] > 0


def test_dashboard_preferences_are_cleaned(client, paths):
    assert client.get("/api/control/dashboard").json()["position"] == "bottom-left"
    r = client.put("/api/control/dashboard", json={"position": "bottom-right", "opacity": 5, "style": "fancy", "evil": 1})
    assert r.json()["position"] == "bottom-right" and r.json()["opacity"] == 1.0 and r.json()["style"] == "compact"
    saved = json.loads(paths["dashboard"].read_text())
    assert "evil" not in saved and saved["position"] == "bottom-right"


def test_routines_crud_run_and_insights(client):
    data = client.get("/api/control/routines").json()
    todos = next(r for r in data["routines"] if r["builtin"] == "todos")
    assert data["scheduler"] is True

    client.patch(f"/api/control/routines/{todos['id']}", json={"enabled": True})
    with client.websocket_connect("/ws") as ws:
        ws.receive_json()
        run = client.post(f"/api/control/routines/{todos['id']}/run").json()["run"]
        assert run["status"] == "ok" and run["summary"] == "1 open"
        event = next(m for m in iter(ws.receive_json, None) if m["type"] == "routine_result")
        assert event["routine"]["builtin"] == "todos"
    assert client.get("/api/control/insights").json()["insights"]["todos"]["data"]["open"] == 1

    r = client.post("/api/control/routines", json={"name": "Brief", "prompt": "Say hi", "cron": "0 8 * * 1-5"})
    assert r.status_code == 201
    brief = next(x for x in r.json()["routines"] if x["kind"] == "agent")
    assert brief["schedule"] == "weekdays at 08:00" and brief["enabled"]
    run = client.post(f"/api/control/routines/{brief['id']}/run").json()["run"]
    assert run["summary"] == "Done."
    assert len(client.get(f"/api/control/routines/{brief['id']}/runs").json()["runs"]) == 1

    assert client.post("/api/control/routines", json={"name": "x", "prompt": "y", "cron": "bad"}).status_code == 400
    assert client.delete(f"/api/control/routines/{todos['id']}").status_code == 400  # built-in
    assert client.delete(f"/api/control/routines/{brief['id']}").status_code == 200
    assert client.post(f"/api/control/routines/{brief['id']}/run").status_code == 404


def test_cron_check(client):
    ok = client.get("/api/control/cron", params={"expr": "*/10 * * * *"}).json()
    assert ok["valid"] and ok["text"] == "every 10 minutes" and len(ok["next"]) == 3
    assert client.get("/api/control/cron", params={"expr": "nope"}).json()["valid"] is False
