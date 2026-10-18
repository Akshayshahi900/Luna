from langchain.agents import create_agent

from luna.agent.memory import close_checkpointers, create_checkpointer
from luna.cli.chat import list_threads


async def test_sqlite_history_survives_restart(tmp_path, make_fake_model):
    db = tmp_path / "mem.sqlite"
    config = {"configurable": {"thread_id": "t1"}}

    saver = await create_checkpointer("sqlite", db)
    agent = create_agent(model=make_fake_model("hi Ada"), tools=[], checkpointer=saver)
    await agent.ainvoke({"messages": [{"role": "user", "content": "I am Ada"}]}, config)
    await close_checkpointers()

    # Fresh connection to the same file → previous turn is still there.
    saver = await create_checkpointer("sqlite", db)
    agent = create_agent(model=make_fake_model("you are Ada"), tools=[], checkpointer=saver)
    result = await agent.ainvoke({"messages": [{"role": "user", "content": "who am I?"}]}, config)
    contents = [m.content for m in result["messages"]]
    assert contents == ["I am Ada", "hi Ada", "who am I?", "you are Ada"]
    await close_checkpointers()


async def test_list_threads(make_fake_model):
    saver = await create_checkpointer("memory")
    agent = create_agent(model=make_fake_model("a", "b"), tools=[], checkpointer=saver)
    for tid in ("first", "second"):
        await agent.ainvoke(
            {"messages": [{"role": "user", "content": "hello"}]},
            {"configurable": {"thread_id": tid}},
        )
    assert await list_threads(saver) == ["first", "second"]


async def test_sessions_list_titles_resolve_and_delete(make_fake_model):
    from luna.agent.sessions import delete_session, list_sessions, resolve_session

    saver = await create_checkpointer("memory")
    agent = create_agent(model=make_fake_model("a", "b", "c"), tools=[], checkpointer=saver)
    for tid, text in (("aaa-1", "first   question"), ("bbb-2", "x" * 80), ("aaa-1", "follow up")):
        await agent.ainvoke({"messages": [{"role": "user", "content": text}]}, {"configurable": {"thread_id": tid}})

    sessions = await list_sessions(saver)
    assert [s["id"] for s in sessions] == ["aaa-1", "bbb-2"]  # aaa-1 used last
    assert sessions[0]["title"] == "first question" and sessions[0]["turns"] == 2
    assert len(sessions[1]["title"]) == 60 and sessions[1]["title"].endswith("…")

    assert resolve_session("2", sessions) == "bbb-2"
    assert resolve_session("bbb", sessions) == "bbb-2"  # id prefix
    assert resolve_session("aaa-1", sessions) == "aaa-1"
    assert resolve_session("9", sessions) is None
    assert resolve_session("zzz", sessions) is None

    await delete_session(saver, "aaa-1")
    assert [s["id"] for s in await list_sessions(saver)] == ["bbb-2"]
