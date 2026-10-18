import importlib.util
import json
from email.message import EmailMessage

import pytest
from langchain.tools import tool

import luna.integrations.google as google_api
from conftest import FakeRequest, missing

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
    assert set(t) == {"list_tasks", "add_task", "set_task_done", "delete_task", "add_task_from_email"}

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

    names = ["list_tasks", "add_task", "set_task_done", "delete_task", "add_task_from_email"]
    tasks_tools = [_fake_tool(n) for n in names]
    settings = Settings(openrouter_api_key="test", workspace_dirs=[tmp_path / "ws"])
    specs = {s.name: s for s in get_subagent_specs(settings, {"assistant": tasks_tools})}
    assert specs["ask_assistant"].interrupt_on == {
        "add_task": True, "set_task_done": True, "delete_task": True, "add_task_from_email": True,
    }


def test_without_google_sign_in_tasks_stay_local(tmp_path, monkeypatch):
    # conftest points LUNA_GOOGLE_TOKEN_PATH at a missing file: no sync, no error.
    monkeypatch.setenv("LUNA_TASKS_PATH", str(tmp_path / "tasks.json"))
    assert tasks_server.add_task("local only")["synced"] is False


# --- Google Tasks sync ---------------------------------------------------------

OLD, NEW = "2000-01-01T00:00:00.000Z", "2999-01-01T00:00:00.000Z"


class FakeGoogleTasks:
    """Tasks v1 client: tasks().list (paged, shows deleted) / insert / patch / delete."""

    def __init__(self):
        self.items: dict[str, dict] = {}
        self.page_size = 100
        self.clock = 0
        self.calls: list[str] = []

    def tasks(self):
        return self

    def _stamp(self):
        self.clock += 1
        return f"2026-10-18T00:00:{self.clock:02d}.000Z"

    def list(self, tasklist, pageToken=None, maxResults=100, **kw):
        assert kw == {"showCompleted": True, "showHidden": True, "showDeleted": True}
        start = int(pageToken or 0)
        items = list(self.items.values())
        page = items[start:start + self.page_size]
        more = start + self.page_size < len(items)
        self.calls.append("list")
        return FakeRequest(lambda: {"items": [dict(t) for t in page],
                                    **({"nextPageToken": str(start + self.page_size)} if more else {})})

    def insert(self, tasklist, body):
        self.calls.append("insert")

        def run():
            task = {**body, "id": f"g{len(self.items) + 1}", "updated": self._stamp()}
            self.items[task["id"]] = task
            return task

        return FakeRequest(run)

    def patch(self, tasklist, task, body):
        self.calls.append("patch")

        def run():
            if task not in self.items:
                missing("task", task)
            self.items[task].update(body, updated=self._stamp())
            return self.items[task]

        return FakeRequest(run)

    def delete(self, tasklist, task):
        self.calls.append("delete")
        return FakeRequest(lambda: self.items[task].update(deleted=True))

    def edit(self, task_id, updated=None, **fields):
        """A change made in the Google Tasks app (by default newer than any local change)."""
        self.clock += 1
        self.items[task_id].update(fields, updated=updated or f"2999-01-01T00:00:{self.clock:02d}.000Z")


@pytest.fixture
def google_tasks(tmp_path, monkeypatch):
    token = tmp_path / "token.json"
    token.write_text("{}")  # is_connected only checks that the file exists
    monkeypatch.setenv("LUNA_GOOGLE_TOKEN_PATH", str(token))
    monkeypatch.setenv("LUNA_TASKS_PATH", str(tmp_path / "tasks.json"))
    fake = FakeGoogleTasks()
    monkeypatch.setattr(google_api, "service", lambda api, version, settings=None: fake)
    return fake


def _stored(tmp_path):
    return json.loads((tmp_path / "tasks.json").read_text())


def test_new_local_task_is_pushed(google_tasks):
    task = tasks_server.add_task("dentist", due="2026-10-20T09:30", notes="bring card")
    assert task["synced"] is True
    remote = google_tasks.items["g1"]
    assert (remote["title"], remote["due"], remote["notes"], remote["status"]) == (
        "dentist", "2026-10-20T00:00:00.000Z", "bring card", "needsAction",
    )


def test_open_google_tasks_are_pulled_and_completed_ones_skipped(google_tasks):
    google_tasks.items = {
        "a": {"id": "a", "title": "from phone", "due": "2026-10-21T00:00:00.000Z", "status": "needsAction", "updated": OLD},
        "b": {"id": "b", "title": "old and done", "status": "completed", "updated": OLD},
        "c": {"id": "c", "title": "", "status": "needsAction", "updated": OLD},
    }
    google_tasks.page_size = 1  # every page is read
    listed = tasks_server.list_tasks(include_done=True)
    assert [(t["title"], t["due"], t["synced"]) for t in listed] == [("from phone", "2026-10-21", True)]


def test_changes_flow_both_ways(google_tasks, tmp_path):
    task = tasks_server.add_task("call mom", due="2026-10-20T18:00")

    # Done locally → pushed.
    tasks_server.set_task_done(task["id"])
    assert google_tasks.items["g1"]["status"] == "completed"

    # Reopened and renamed in Google → pulled; the local time survives the same day.
    google_tasks.edit("g1", title="call mom and dad", status="needsAction")
    [pulled] = tasks_server.list_tasks()
    assert (pulled["title"], pulled["done"], pulled["due"]) == ("call mom and dad", False, "2026-10-20T18:00")

    # Moved to another day in Google → the local due follows (Google has no time).
    google_tasks.edit("g1", due="2026-10-22T00:00:00.000Z")
    assert tasks_server.list_tasks()[0]["due"] == "2026-10-22"
    assert _stored(tmp_path)[0]["dirty"] is False


def test_conflict_newest_change_wins(google_tasks, monkeypatch):
    task = tasks_server.add_task("draft")
    # A local change Google hasn't seen yet, and an older change in Google.
    with monkeypatch.context() as m:
        m.setattr(tasks_server, "_synced", lambda tasks: None)
        tasks_server.set_task_done(task["id"])
    google_tasks.edit("g1", title="older remote edit", updated=OLD)
    tasks_server.list_tasks(include_done=True)
    assert google_tasks.items["g1"]["status"] == "completed"  # local was newer: pushed

    with monkeypatch.context() as m:
        m.setattr(tasks_server, "_synced", lambda tasks: None)
        tasks_server.set_task_done(task["id"], done=False)
    google_tasks.edit("g1", title="newer remote edit", updated=NEW)
    [kept] = tasks_server.list_tasks(include_done=True)
    assert (kept["title"], kept["done"]) == ("newer remote edit", True)  # Google was newer: pulled


def test_deletes_flow_both_ways(google_tasks, tmp_path):
    a = tasks_server.add_task("a")
    tasks_server.add_task("b")
    tasks_server.delete_task(a["id"])
    assert google_tasks.items["g1"]["deleted"] is True
    assert [t["title"] for t in _stored(tmp_path)] == ["b"]

    google_tasks.edit("g2", deleted=True)
    assert tasks_server.list_tasks() == []


def test_offline_changes_wait_for_the_next_sync(google_tasks, tmp_path, monkeypatch):
    def offline(*args, **kwargs):
        raise ValueError("Google API error 503: unavailable")

    monkeypatch.setattr(google_api, "service", offline)
    task = tasks_server.add_task("buy milk")
    assert task["synced"] is False
    tasks_server.delete_task(tasks_server.add_task("typo")["id"])  # never reached Google: just gone
    assert [t["title"] for t in tasks_server.list_tasks()] == ["buy milk"]

    monkeypatch.setattr(google_api, "service", lambda api, version, settings=None: google_tasks)
    assert tasks_server.list_tasks()[0]["synced"] is True
    assert [t["title"] for t in google_tasks.items.values()] == ["buy milk"]


def test_delete_while_offline_reaches_google_later(google_tasks, tmp_path, monkeypatch):
    task = tasks_server.add_task("cancel gym")
    monkeypatch.setattr(google_api, "service", lambda *a, **k: (_ for _ in ()).throw(ValueError("offline")))
    tasks_server.delete_task(task["id"])
    assert tasks_server.list_tasks() == []  # hidden locally right away
    assert _stored(tmp_path)[0]["deleted"] is True  # kept until Google knows

    monkeypatch.setattr(google_api, "service", lambda api, version, settings=None: google_tasks)
    tasks_server.list_tasks()
    assert google_tasks.items["g1"]["deleted"] is True and _stored(tmp_path) == []


def test_task_from_email_links_back_and_does_not_duplicate(google_tasks, monkeypatch):
    monkeypatch.setenv("LUNA_MAIL_BACKEND", "gmail")
    msg = EmailMessage()
    msg["From"], msg["Subject"], msg["Date"] = "Bob <bob@example.com>", "Invoice 42", "Sat, 17 Oct 2026 10:00:00 +0530"
    msg["Message-ID"] = "<m7@example.com>"
    msg.set_content("Please pay by Friday.")
    monkeypatch.setattr(tasks_server.mail, "fetch_email", lambda uid, folder="INBOX": msg)

    first = tasks_server.add_task_from_email("7", due="2026-10-23")
    assert first["created"] is True
    task = first["task"]
    assert (task["title"], task["due"], task["from_email"]) == ("Invoice 42", "2026-10-23", "<m7@example.com>")
    assert "rfc822msgid:m7%40example.com" in task["notes"]
    assert google_tasks.items["g1"]["notes"] == task["notes"]  # the link reaches Google Tasks too

    again = tasks_server.add_task_from_email("7")
    assert again["created"] is False and again["task"]["id"] == task["id"]
    assert len(google_tasks.items) == 1
