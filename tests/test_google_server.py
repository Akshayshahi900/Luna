import importlib.util
from email.message import EmailMessage
from zoneinfo import ZoneInfo

import pytest
from langchain.tools import tool

import luna.integrations.google as google_api
from conftest import FakeRequest, missing
from luna.agent.subagents import get_subagent_specs
from luna.config import Settings
from luna.config.settings import PROJECT_ROOT
from luna.mcp.loader import load_mcp_config, load_mcp_tools, split_by_agent

# servers/ is not a package, so load the script by path.
_spec = importlib.util.spec_from_file_location("google_mcp_server", PROJECT_ROOT / "servers" / "google_mcp_server.py")
google_server = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(google_server)

READ_ONLY = {"list_events", "get_agenda"}
RISKY = {"create_event", "update_event", "delete_event", "create_event_from_email"}


class FakeCalendar:
    """Just enough of the Calendar v3 client: events().list/get/insert/patch/delete."""

    def __init__(self):
        self.items: dict[str, dict] = {}
        self.calls: list[tuple[str, dict]] = []

    def events(self):
        return self

    def list(self, **kw):
        self.calls.append(("list", kw))
        prop = kw.get("privateExtendedProperty")

        def run():
            items = list(self.items.values())
            if prop:
                key, value = prop.split("=", 1)
                items = [e for e in items if e.get("extendedProperties", {}).get("private", {}).get(key) == value]
            return {"items": items}

        return FakeRequest(run)

    def get(self, calendarId, eventId):
        return FakeRequest(lambda: dict(self.items[eventId]) if eventId in self.items else missing("event", eventId))

    def insert(self, calendarId, body, **kw):
        self.calls.append(("insert", {"body": body, **kw}))

        def run():
            event = {"id": f"e{len(self.items) + 1}", "htmlLink": "https://cal/x", **body}
            self.items[event["id"]] = event
            return event

        return FakeRequest(run)

    def patch(self, calendarId, eventId, body, **kw):
        self.calls.append(("patch", {"body": body, **kw}))

        def run():
            self.items[eventId].update(body)
            return self.items[eventId]

        return FakeRequest(run)

    def delete(self, calendarId, eventId, **kw):
        self.calls.append(("delete", {"eventId": eventId, **kw}))
        return FakeRequest(lambda: self.items.pop(eventId) and "")


def _email(subject="Lunch on Friday?", sender="Bob <bob@example.com>", message_id="<m7@example.com>"):
    msg = EmailMessage()
    msg["From"] = sender
    msg["To"] = "me@example.com"
    msg["Subject"] = subject
    msg["Date"] = "Sat, 17 Oct 2026 10:00:00 +0530"
    if message_id:
        msg["Message-ID"] = message_id
    msg.set_content("Shall we meet at 1pm at Cafe Blue?")
    return msg


@pytest.fixture
def calendar(tmp_path, monkeypatch):
    """Fake Calendar client; the mail server returns one fake email; local to-dos in tmp."""
    monkeypatch.setenv("LUNA_TIMEZONE", "Asia/Kolkata")
    monkeypatch.setenv("LUNA_MAIL_BACKEND", "gmail")
    monkeypatch.setenv("LUNA_TASKS_PATH", str(tmp_path / "tasks.json"))
    fake = FakeCalendar()
    monkeypatch.setattr(google_api, "service", lambda api, version, settings=None: fake)
    emails = {"7": _email()}
    monkeypatch.setattr(google_server.mail, "fetch_email", lambda uid, folder="INBOX": emails[uid])
    fake.emails = emails
    return fake


async def test_tool_catalog_over_mcp():
    tools = await load_mcp_tools(google_server.mcp)
    assert {t.name for t in tools} == READ_ONLY | RISKY


def test_event_times():
    tz = ZoneInfo("Asia/Kolkata")
    assert google_server.event_times("2026-10-20T09:30", "", tz) == (
        {"dateTime": "2026-10-20T09:30:00+05:30"},
        {"dateTime": "2026-10-20T10:30:00+05:30"},
    )
    # All-day: end is the last day, Google's end is exclusive.
    assert google_server.event_times("2026-10-20", "2026-10-21", tz) == (
        {"date": "2026-10-20"}, {"date": "2026-10-22"},
    )
    with pytest.raises(ValueError, match="end must be after start"):
        google_server.event_times("2026-10-20T09:30", "2026-10-20T09:00", tz)
    with pytest.raises(ValueError, match="needs a time"):
        google_server.event_times("2026-10-20T09:30", "2026-10-21", tz)
    with pytest.raises(ValueError, match="YYYY-MM-DD"):
        google_server.event_times("next tuesday", "", tz)


def test_create_update_delete_event(calendar):
    event = google_server.create_event("Dentist", "2026-10-20T09:30", location="Clinic")
    assert event["title"] == "Dentist" and event["start"] == "2026-10-20T09:30:00+05:30"
    assert calendar.calls[-1][1]["sendUpdates"] == "none"

    google_server.create_event("Sync", "2026-10-21T10:00", attendees="ann@example.com, Bob <bob@example.com>")
    assert calendar.calls[-1][1]["body"]["attendees"] == [{"email": "ann@example.com"}, {"email": "bob@example.com"}]
    assert calendar.calls[-1][1]["sendUpdates"] == "all"

    moved = google_server.update_event(event["id"], start="2026-10-20T11:00")
    assert (moved["start"], moved["end"]) == ("2026-10-20T11:00:00+05:30", "2026-10-20T12:00:00+05:30")
    assert set(calendar.calls[-1][1]["body"]) == {"start", "end"}
    with pytest.raises(ValueError, match="Nothing to change"):
        google_server.update_event(event["id"])

    assert "Dentist" in google_server.delete_event(event["id"])
    assert event["id"] not in calendar.items


def test_list_events_window_and_agenda_with_local_todos(calendar):
    google_server.list_events("2026-10-20", "2026-10-20", query="dentist", limit=500)
    _, params = calendar.calls[-1]
    assert params["timeMin"] == "2026-10-20T00:00:00+05:30"
    assert params["timeMax"] == "2026-10-21T00:00:00+05:30"  # a date-only end includes that day
    assert params["q"] == "dentist" and params["maxResults"] == 50 and params["singleEvents"]

    todos = google_server.todos
    todos.add_task("pay rent", due="2026-10-15")
    todos.add_task("call mom", due="2026-10-20T18:00")
    todos.add_task("someday")
    agenda = google_server.get_agenda("2026-10-20")
    assert agenda["date"] == "2026-10-20"
    assert [t["title"] for t in agenda["tasks_due"]] == ["call mom"]
    assert [t["title"] for t in agenda["overdue"]] == ["pay rent"]


def test_event_from_email_links_back_and_does_not_duplicate(calendar):
    made = google_server.create_event_from_email("7", "2026-10-23T13:00", location="Cafe Blue", invite_sender=True)
    assert made["created"] is True
    event = made["event"]
    assert event["title"] == "Lunch on Friday?" and event["from_email"] == "<m7@example.com>"
    assert event["attendees"] == ["bob@example.com"]
    assert "Shall we meet at 1pm" in event["description"]
    assert "rfc822msgid:m7%40example.com" in event["description"]  # opens the email in Gmail
    assert calendar.calls[-1][1]["sendUpdates"] == "all"

    again = google_server.create_event_from_email("7", "2026-10-24T13:00")
    assert again["created"] is False and again["event"]["id"] == event["id"]
    assert len(calendar.items) == 1


def test_email_without_message_id_links_by_folder_and_uid(calendar):
    calendar.emails["8"] = _email(subject="", message_id="")
    event = google_server.create_event_from_email("8", "2026-10-23")["event"]
    assert event["from_email"] == "INBOX:8" and event["all_day"]
    assert event["title"] == "Email from Bob <bob@example.com>"


def test_not_connected_tells_how_to_sign_in():
    # conftest points LUNA_GOOGLE_TOKEN_PATH at a missing file.
    with pytest.raises(google_api.GoogleNotConnected, match="luna-google-auth"):
        google_server.list_events()


def test_old_token_without_gmail_access_asks_to_sign_in_again(tmp_path, monkeypatch):
    token = tmp_path / "token.json"
    token.write_text(
        '{"token": "t", "refresh_token": "r", "client_id": "c", "client_secret": "s",'
        ' "scopes": ["https://www.googleapis.com/auth/calendar.events"]}'
    )
    monkeypatch.setenv("LUNA_GOOGLE_TOKEN_PATH", str(token))
    with pytest.raises(google_api.GoogleNotConnected, match="missing access"):
        google_api.credentials(Settings())


def _fake_tool(name):
    @tool(name)
    def _t() -> str:
        """Fake MCP tool."""
        return "ok"

    return _t


def test_repo_config_routes_google_to_assistant_with_approval(tmp_path):
    groups = split_by_agent(load_mcp_config(PROJECT_ROOT / "config" / "mcp_servers.json"))
    assert {"tasks", "mail", "google"} <= set(groups["assistant"]["mcpServers"])

    settings = Settings(openrouter_api_key="test", workspace_dirs=[tmp_path / "ws"])
    tools = [_fake_tool(n) for n in sorted(READ_ONLY | RISKY)]
    specs = {s.name: s for s in get_subagent_specs(settings, {"assistant": tools})}
    assert specs["ask_assistant"].interrupt_on == {name: True for name in RISKY}
