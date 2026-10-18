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
