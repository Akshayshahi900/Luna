from langchain.agents import create_agent
from langgraph.checkpoint.memory import InMemorySaver
import pytest

from conftest import tool_call
from luna.agent.budget import TaskBudget, current_budget
from luna.agent.builder import build_middleware
from luna.agent.longterm import (
    LongTermMemoryMiddleware,
    LongTermStore,
    MemoryRefused,
    fts_query,
    looks_secret,
    relevant_memories,
    render_memories,
)
from luna.config import Settings


@pytest.fixture
def store():
    s = LongTermStore()
    yield s
    s.close()


def _agent(model, store, **kwargs):
    return create_agent(
        model=model, tools=[], checkpointer=InMemorySaver(),
        middleware=[LongTermMemoryMiddleware(store, **kwargs)],
    )


def _ask(text):
    return {"messages": [{"role": "user", "content": text}]}


# --- store: the user's side --------------------------------------------------------

def test_add_edit_pin_delete_and_list_order(store):
    tea = store.add("Prefers tea over coffee", "preference")
    sis = store.add("Sister is called Asha", "person")
    store.edit(sis["id"], pinned=True)
    assert [m["id"] for m in store.list()] == [sis["id"], tea["id"]]  # pinned first

    store.edit(tea["id"], text="Prefers green tea")
    assert store.get(tea["id"])["text"] == "Prefers green tea"

    store.delete(tea["id"])
    assert [m["id"] for m in store.list()] == [sis["id"]]
    with pytest.raises(MemoryRefused):
        store.get(tea["id"])


def test_stats_count_kinds_pins_deletes_and_inbox(store):
    a = store.add("Likes tea", "preference", pinned=True)
    store.add("Lives in Agra")
    gone = store.add("Old fact")
    store.delete(gone["id"])
    store.suggest("add", text="Has a cat", kind="fact")
    stats = store.stats()
    assert stats["total"] == 2
    assert stats["by_kind"] == {"fact": 1, "preference": 1, "person": 0, "project": 0}
    assert stats["pinned"] == 1 and stats["deleted"] == 1 and stats["pending"] == 1
    assert stats["changes"] >= 4
    assert a["pinned"]


def test_add_validates_text_and_kind(store):
    with pytest.raises(MemoryRefused):
        store.add("   ")
    with pytest.raises(MemoryRefused):
        store.add("x" * 301)
    with pytest.raises(MemoryRefused):
        store.add("Likes jazz", "mood")


def test_history_and_undo_walk_back_every_change(store):
    m = store.add("Lives in Agra")
    store.edit(m["id"], text="Lives in Delhi")
    store.delete(m["id"])
    actions = [h["action"] for h in store.history(m["id"])]
    assert actions == ["delete", "edit", "add"]

    assert store.undo(m["id"])["text"] == "Lives in Delhi"  # back from the delete
    assert store.undo(m["id"])["text"] == "Lives in Agra"  # back from the edit
    assert store.undo(m["id"]) is None  # undoing the add hides it
    assert store.list() == []
    with pytest.raises(MemoryRefused):
        store.undo(m["id"])  # nothing left
    assert all(h["undone"] for h in store.history(m["id"]))


def test_search_uses_keywords_and_skips_deleted(store):
    tea = store.add("Prefers tea over coffee", "preference")
    robots = store.add("Works on a robotics project", "project")
    gone = store.add("Drinks coffee at night")
    store.delete(gone["id"])

    assert [m["id"] for m in store.search("Do I like coffee?")] == [tea["id"]]
    assert [m["id"] for m in store.search("any robot news")] == [robots["id"]]  # prefix match
    assert store.search("the and of") == []  # only stopwords
    assert store.search('"); DROP TABLE memories; --') == []  # safe, no error


def test_fts_query_quotes_every_word():
    assert fts_query('what\'s my "coffee" OR tea*?') == '"coffee"* OR "tea"'
    assert fts_query("") == ""


def test_store_survives_reopening(tmp_path):
    path = tmp_path / "lt.sqlite"
    first = LongTermStore(path)
    first.add("Allergic to peanuts")
    first.close()
    second = LongTermStore(path)
    assert [m["text"] for m in second.list()] == ["Allergic to peanuts"]
    assert second.search("peanuts")
    second.close()


# --- suggestions: the agent's side --------------------------------------------------

def test_accept_add_update_forget(store):
    s = store.suggest("add", "Has a dog named Bruno", "person", reason="mentioned it")
    assert store.pending_count() == 1
    m = store.accept(s["id"])
    assert m["text"] == "Has a dog named Bruno" and m["kind"] == "person"
    assert store.history(m["id"])[0]["source"] == f"suggestion s{s['id']}"

    up = store.suggest("update", "Has a dog named Max", target_id=m["id"])
    assert up["target_text"] == "Has a dog named Bruno"
    store.accept(up["id"], text="Has a beagle named Max")  # the user's own words win
    assert store.get(m["id"])["text"] == "Has a beagle named Max"

    bye = store.suggest("forget", target_id=m["id"])
    assert store.accept(bye["id"]) is None
    assert store.list() == []
    assert store.undo(m["id"])["text"] == "Has a beagle named Max"  # even accepted changes undo
    assert store.pending_count() == 0


def test_suggestion_guards(store):
    m = store.add("Prefers tea over coffee")
    with pytest.raises(MemoryRefused, match="Already in"):
        store.suggest("add", "prefers tea over coffee.")
    with pytest.raises(MemoryRefused, match="private"):
        store.suggest("add", "My bank password is hunter2")
    with pytest.raises(MemoryRefused, match="private"):
        store.suggest("add", "Card 4111 1111 1111 1111")
    with pytest.raises(MemoryRefused):
        store.suggest("add", "x" * 400)
    with pytest.raises(MemoryRefused, match="No memory"):
        store.suggest("update", "whatever", target_id=999)
    with pytest.raises(MemoryRefused, match="already says"):
        store.suggest("update", "Prefers tea over coffee", target_id=m["id"])

    s = store.suggest("add", "Likes jazz")
    with pytest.raises(MemoryRefused, match="waiting"):
        store.suggest("add", "likes jazz")
    store.reject(s["id"])
    with pytest.raises(MemoryRefused, match="declined"):
        store.suggest("add", "Likes jazz")
    with pytest.raises(MemoryRefused):
        store.accept(s["id"])  # no longer pending


# --- prompt -------------------------------------------------------------------------

def test_pinned_first_then_matches_within_the_cap(store):
    pin = store.add("Name is Akshay", pinned=True)
    tea = store.add("Prefers tea over coffee")
    store.add("Works on a robotics project")
    chosen = relevant_memories(store, "coffee please", limit=5)
    assert [m["id"] for m in chosen] == [pin["id"], tea["id"]]

    text = render_memories(chosen, max_chars=1000)
    assert f"[m{pin['id']}] (fact) Name is Akshay" in text
    assert render_memories(chosen, max_chars=40).count("\n") == 0  # second line cut


async def test_memories_reach_the_model_and_edits_apply_next_call(make_fake_model, store):
    m = store.add("Prefers tea over coffee", "preference")
    model = make_fake_model("Tea, Sir.", "Green tea, Sir.")
    agent = _agent(model, store)
    config = {"configurable": {"thread_id": "t"}}

    await agent.ainvoke(_ask("what do I drink, coffee?"), config)
    assert "Prefers tea over coffee" in model.system_prompts[0]

    store.edit(m["id"], text="Prefers green tea over coffee")  # edited in the panel
    await agent.ainvoke(_ask("and now, coffee?"), config)
    assert "Prefers green tea over coffee" in model.system_prompts[1]
    assert "Prefers tea over coffee" not in model.system_prompts[1]


async def test_agent_tools_only_suggest_never_change_memories(make_fake_model, store):
    m = store.add("Lives in Agra")
    before = store.list()
    model = make_fake_model(
        tool_call("remember", "c1", text="Has a cat named Miso", kind="person"),
        tool_call("suggest_update", "c2", memory_id=m["id"], text="Lives in Delhi", reason="moved"),
        tool_call("suggest_forget", "c3", memory_id=m["id"]),
        tool_call("recall", "c4", query="Agra"),
        "Noted, Sir.",
    )
    agent = _agent(model, store)
    await agent.ainvoke(_ask("I moved to Delhi and got a cat"), {"configurable": {"thread_id": "t1"}})

    assert store.list() == before  # untouched until the user accepts
    pending = store.suggestions()
    assert [s["action"] for s in pending] == ["add", "update", "forget"]
    assert all(s["thread_id"] == "t1" for s in pending)
    assert any("Lives in Agra" in text for text in model.inputs[-1])  # recall result


async def test_suggestions_per_message_are_capped(make_fake_model, store):
    model = make_fake_model(
        tool_call("remember", "c1", text="Fact one"),
        tool_call("remember", "c2", text="Fact two"),
        tool_call("remember", "c3", text="Fact three"),
        "ok",
    )
    agent = _agent(model, store, max_suggestions=2)
    token = current_budget.set(TaskBudget(limit=10))
    try:
        await agent.ainvoke(_ask("lots of facts"), {"configurable": {"thread_id": "t"}})
    finally:
        current_budget.reset(token)
    assert [s["text"] for s in store.suggestions()] == ["Fact one", "Fact two"]
    assert any("at most 2" in text for text in model.inputs[-1])


async def test_refused_suggestion_is_explained_to_the_model(make_fake_model, store):
    model = make_fake_model(tool_call("remember", text="api key: sk-abcdefghijklmnop1234"), "ok")
    await _agent(model, store).ainvoke(_ask("save my key"), {"configurable": {"thread_id": "t"}})
    assert store.suggestions() == []
    assert any(text.startswith("Not suggested") for text in model.inputs[-1])


def test_looks_secret():
    assert looks_secret("the wifi password: abc")
    assert looks_secret("ghp_abcdefghijklmnopqrstuvwxyz")
    assert not looks_secret("Prefers tea over coffee")


def test_main_agent_middleware_includes_memory_only_with_a_store(store, make_fake_model):
    settings = Settings(openrouter_api_key="test", summary_trigger_tokens=0)
    model = make_fake_model("x")
    without = build_middleware(settings, model)
    with_store = build_middleware(settings, model, memory_store=store)
    assert not any(isinstance(m, LongTermMemoryMiddleware) for m in without)
    assert any(isinstance(m, LongTermMemoryMiddleware) for m in with_store)
