"""Routines: the store, built-in data checks, agent routines (auto-reject of
risky tools) and the scheduler. Fake tools and the fake chat model only."""

import asyncio
import json
from datetime import UTC, date, datetime, timedelta

from langchain.agents import create_agent
from langchain.agents.middleware import HumanInTheLoopMiddleware
from langchain.tools import tool
from langgraph.checkpoint.memory import InMemorySaver
import pytest

from conftest import tool_call
from luna.config import Settings
from luna.routines.agent import REJECTED, auto_answer, routine_thread, run_agent_routine
from luna.routines.builtin import BUILTINS, decode_tool_output, run_builtin
from luna.routines.scheduler import RoutineScheduler, make_executor
from luna.routines.store import KEEP_RUNS, RoutineRefused, RoutineStore


@pytest.fixture
def store():
    s = RoutineStore(tz=UTC)
    yield s
    s.close()


NOW = datetime(2026, 10, 18, 12, 0, tzinfo=UTC)


# --- store ---------------------------------------------------------------------

def test_seed_builtins_once_and_switched_off(store):
    store.seed_builtins()
    store.seed_builtins()
    routines = store.list()
    assert [r["builtin"] for r in routines] == list(BUILTINS)
    assert not any(r["enabled"] for r in routines)
    assert routines[0]["schedule"] == "every 15 minutes"


def test_add_validates(store):
    with pytest.raises(RoutineRefused, match="prompt"):
        store.add("Brief", "agent", "0 8 * * *")
    with pytest.raises(RoutineRefused, match="5 fields"):
        store.add("Brief", "agent", "daily", prompt="hi")
    with pytest.raises(RoutineRefused, match="Unknown built-in"):
        store.add("X", "builtin", "* * * * *", builtin="nope")
    with pytest.raises(RoutineRefused, match="name"):
        store.add("  ", "agent", "* * * * *", prompt="hi")


def test_update_reschedules_and_builtins_cant_be_deleted(store):
    store.seed_builtins()
    builtin = store.list()[0]
    with pytest.raises(RoutineRefused, match="turned off"):
        store.delete(builtin["id"])
    r = store.add("Brief", "agent", "0 8 * * *", prompt="hi")
    before = r["next_run_at"]
    r = store.update(r["id"], cron="*/5 * * * *", enabled=True, name="Quick")
    assert r["name"] == "Quick" and r["enabled"] and r["schedule"] == "every 5 minutes"
    assert r["next_run_at"] != before
    with pytest.raises(RoutineRefused, match="Can't change"):
        store.update(r["id"], kind="builtin")
    store.delete(r["id"])
    with pytest.raises(RoutineRefused, match="No routine"):
        store.get(r["id"])


def test_due_only_enabled_and_past(store):
    on = store.add("On", "agent", "* * * * *", prompt="hi", enabled=True)
    store.add("Off", "agent", "* * * * *", prompt="hi", enabled=False)
    assert store.due(datetime.now(UTC)) == []  # next run is a minute away
    later = datetime.now(UTC) + timedelta(minutes=2)
    assert [r["id"] for r in store.due(later)] == [on["id"]]
    store.schedule_next(on["id"], later)
    assert store.due(later) == []


def test_runs_are_recorded_and_trimmed(store):
    r = store.add("Brief", "agent", "* * * * *", prompt="hi")
    for i in range(KEEP_RUNS + 5):
        store.finish_run(store.start_run(r["id"]), "ok", f"run {i}", {"n": i})
    runs = store.runs(r["id"], limit=1000)
    assert len(runs) == KEEP_RUNS
    assert runs[0]["summary"] == f"run {KEEP_RUNS + 4}" and runs[0]["data"] == {"n": KEEP_RUNS + 4}
    assert store.get(r["id"])["last_run"]["status"] == "ok"
    assert store.recent_runs(1)[0]["name"] == "Brief"


def test_interrupted_runs_are_closed_on_open(tmp_path):
    path = tmp_path / "r.sqlite"
    s = RoutineStore(path)
    r = s.add("Brief", "agent", "* * * * *", prompt="hi")
    s.start_run(r["id"])
    s.close()
    s = RoutineStore(path)
    assert s.runs(r["id"])[0]["status"] == "error"
    s.close()


def test_insights_are_the_last_ok_run_of_enabled_builtins(store):
    store.seed_builtins()
    mail = next(r for r in store.list() if r["builtin"] == "mail_check")
    store.update(mail["id"], enabled=True)
    store.finish_run(store.start_run(mail["id"]), "ok", "2 unread", {"unread": 2})
    store.finish_run(store.start_run(mail["id"]), "error", "offline")
    assert store.insights()["mail_check"]["data"] == {"unread": 2}
    store.update(mail["id"], enabled=False)
    assert store.insights() == {}


def test_usage_per_day_with_gaps(store):
    today = store.local_now().date()
    store.add_usage("groq", "m", runs=1, model_calls=3, tool_calls=2)
    store.add_usage("groq", "m", runs=1, model_calls=2, errors=1)
    store.add_usage("openrouter", "x", model_calls=4, day=today - timedelta(days=2))
    usage = store.usage(days=3)
    assert [d["model_calls"] for d in usage["days"]] == [4, 0, 5]
    assert usage["days"][-1] == {"day": today.isoformat(), "runs": 2, "model_calls": 5, "tool_calls": 2, "errors": 1}
    assert usage["models"][0]["provider"] == "groq"
    assert isinstance(date.fromisoformat(usage["days"][0]["day"]), date)


# --- built-ins -----------------------------------------------------------------

@tool
def list_inbox(limit: int = 10, unread_only: bool = False) -> str:
    """Fake inbox."""
    return json.dumps([
        {"from": "Ann Lee <ann@x.com>", "subject": "Lunch?", "date": "d1"},
        {"from": "bot@x.com", "subject": "Report", "date": "d2"},
    ])


@tool
def get_agenda(day: str = "") -> str:
    """Fake agenda."""
    return json.dumps({
        "date": "2026-10-18",
        "events": [
            {"title": "Standup", "start": "2026-10-18T09:00:00+00:00", "end": "2026-10-18T09:15:00+00:00"},
            {"title": "Dentist", "start": "2026-10-18T15:00:00+00:00", "end": "2026-10-18T16:00:00+00:00"},
        ],
        "tasks_due": [{}],
        "overdue": [],
    })


@tool
def list_tasks(include_done: bool = False) -> str:
    """Fake to-dos."""
    return json.dumps([
        {"title": "Pay rent", "due": "2026-10-18", "done": False},
        {"title": "Call mom", "due": "2026-10-01T10:00", "done": False},
        {"title": "Someday", "due": None, "done": False},
        {"title": "Old", "due": "2026-10-01", "done": True},
    ])


TOOLS = {t.name: t for t in (list_inbox, get_agenda, list_tasks)}


async def test_mail_check():
    status, summary, data = await run_builtin("mail_check", TOOLS, NOW)
    assert status == "ok"
    assert summary == "2 unread · latest from Ann Lee: Lunch? (+1 more)"
    assert data["unread"] == 2 and data["items"][0]["from"] == "Ann Lee"


async def test_agenda_picks_the_next_event():
    status, summary, data = await run_builtin("agenda", TOOLS, NOW)
    assert status == "ok"
    assert summary == "2 events today · next: Dentist (15:00)"
    assert data["next"]["title"] == "Dentist" and data["tasks_due"] == 1


async def test_todos_counts_due_and_overdue():
    status, summary, data = await run_builtin("todos", TOOLS, NOW)
    assert (status, summary) == ("ok", "3 open · 1 due today · 1 overdue")
    assert data["items"][0]["title"] == "Call mom"  # overdue first


async def test_missing_tool_is_skipped_and_errors_are_caught():
    assert (await run_builtin("mail_check", {}, NOW))[0] == "skipped"

    @tool
    def list_tasks(include_done: bool = False) -> str:
        """Broken."""
        raise RuntimeError("server down")

    status, summary, _ = await run_builtin("todos", {"list_tasks": list_tasks}, NOW)
    assert status == "error" and "server down" in summary


def test_decode_tool_output_shapes():
    assert decode_tool_output('{"a": 1}') == {"a": 1}
    assert decode_tool_output([{"type": "text", "text": "[1, 2]"}]) == [1, 2]
    assert decode_tool_output([{"type": "text", "text": "1"}, {"type": "text", "text": "2"}]) == [1, 2]
    assert decode_tool_output(("[3]", None)) == [3]
    assert decode_tool_output("not json") == "not json"


def test_builtins_only_use_read_only_tools():
    from luna.mcp.loader import is_risky_tool_name

    assert not any(is_risky_tool_name(spec.tool) for spec in BUILTINS.values())


# --- agent routines ------------------------------------------------------------

@tool
def send_email(to: str, body: str) -> str:
    """Send an email."""
    raise AssertionError("must never run without approval")


def _routine(store, prompt="Morning brief please"):
    return store.add("Brief", "agent", "0 8 * * *", prompt=prompt)


async def test_agent_routine_runs_on_its_own_thread(store, make_fake_model):
    agent = create_agent(model=make_fake_model("Three emails, one meeting."), tools=[], checkpointer=InMemorySaver())
    routine = _routine(store)
    status, summary, data = await run_agent_routine(agent, routine, Settings(openrouter_api_key="t"))
    assert (status, summary) == ("ok", "Three emails, one meeting.")
    assert data == {"thread": routine_thread(routine["id"]), "rejected": []}
    state = await agent.aget_state({"configurable": {"thread_id": routine_thread(routine["id"])}})
    assert state.values["messages"][0].text == "Morning brief please"


async def test_agent_routine_rejects_risky_tools(store, make_fake_model):
    model = make_fake_model(tool_call("send_email", to="boss@x.com", body="hi"), "Couldn't send: needs approval.")
    agent = create_agent(
        model=model, tools=[send_email], checkpointer=InMemorySaver(),
        middleware=[HumanInTheLoopMiddleware(interrupt_on={"send_email": True})],
    )
    status, summary, data = await run_agent_routine(agent, _routine(store), Settings(openrouter_api_key="t"))
    assert status == "ok"
    assert data["rejected"] == ["send_email"]
    assert summary == "Couldn't send: needs approval."
    assert any(REJECTED in text for text in model.inputs[-1])


def test_auto_answer_formats():
    approval = {"id": "p", "kind": "approval", "actions": [{"name": "a"}, {"name": "b"}]}
    assert [d["type"] for d in auto_answer(approval)["decisions"]] == ["reject", "reject"]
    assert "away" in auto_answer({"id": "q", "kind": "question", "question": "?"})["answer"]


# --- scheduler -----------------------------------------------------------------

async def test_tick_runs_due_routines_and_notifies(store):
    store.seed_builtins()
    todos = next(r for r in store.list() if r["builtin"] == "todos")
    store.update(todos["id"], enabled=True)
    events = []
    scheduler = RoutineScheduler(store, make_executor(lambda: TOOLS, None, store), notify=events.append)
    assert await scheduler.tick() == []  # not due yet

    store._conn.execute("UPDATE routines SET next_run_at = '2000-01-01T00:00:00+00:00'")
    (run,) = await scheduler.tick()
    assert run["status"] == "ok" and "open" in run["summary"]
    assert events[0]["type"] == "routine_result" and events[0]["routine"]["builtin"] == "todos"
    assert store.get(todos["id"])["next_run_at"] > datetime.now(UTC).isoformat()
    assert await scheduler.tick() == []


async def test_run_now_records_failures(store):
    routine = _routine(store)

    async def boom(_routine):
        raise RuntimeError("model offline")

    scheduler = RoutineScheduler(store, make_executor(dict, boom, store))
    run = await scheduler.run_now(routine["id"])
    assert run["status"] == "error" and run["error"] == "model offline"
    assert scheduler.running == set()


async def test_same_routine_never_runs_twice_at_once(store):
    routine = _routine(store)
    gate = asyncio.Event()

    async def slow(_routine):
        await gate.wait()
        return "ok", "done", None

    scheduler = RoutineScheduler(store, slow)
    first = asyncio.create_task(scheduler.run_now(routine["id"]))
    await asyncio.sleep(0)
    with pytest.raises(ValueError, match="already running"):
        await scheduler.run_now(routine["id"])
    gate.set()
    assert (await first)["summary"] == "done"


async def test_start_and_stop(store):
    scheduler = RoutineScheduler(store, make_executor(dict, None, store), tick=0.01)
    scheduler.start()
    assert scheduler.active
    await asyncio.sleep(0.03)
    await scheduler.stop()
    assert not scheduler.active
