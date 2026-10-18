from langchain.agents import create_agent
from langchain.agents.middleware import SummarizationMiddleware
from langchain_core.messages import AIMessage
from langgraph.checkpoint.memory import InMemorySaver

from conftest import tool_call
from luna.agent.scratchpad import ScratchpadMiddleware, merge_notes, render_scratchpad


def test_merge_notes_adds_updates_and_deletes():
    notes = merge_notes(None, {"a": "1", "b": "2"})
    notes = merge_notes(notes, {"a": "one", "b": None, "c": ""})
    assert notes == {"a": "one"}


def test_render_includes_todos_and_notes():
    text = render_scratchpad({
        "todos": [{"content": "find flights", "status": "in_progress"}],
        "notes": {"budget": "under $500"},
    })
    assert "[in_progress] find flights" in text
    assert "budget: under $500" in text
    assert render_scratchpad({}) == ""


async def test_notes_are_shown_to_the_model(make_fake_model):
    model = make_fake_model(tool_call("write_note", key="city", content="Paris"), "noted")
    agent = create_agent(model=model, tools=[], checkpointer=InMemorySaver(),
                         middleware=[ScratchpadMiddleware()])
    config = {"configurable": {"thread_id": "t"}}

    await agent.ainvoke({"messages": [{"role": "user", "content": "I live in Paris"}]}, config)

    state = await agent.aget_state(config)
    assert state.values["notes"] == {"city": "Paris"}
    assert "city: Paris" not in model.system_prompts[0]  # not written yet
    assert "city: Paris" in model.system_prompts[1]


async def test_parallel_notes_in_one_step_are_both_kept(make_fake_model):
    both = AIMessage(content="", tool_calls=[
        {"name": "write_note", "args": {"key": "a", "content": "1"}, "id": "n1"},
        {"name": "write_note", "args": {"key": "b", "content": "2"}, "id": "n2"},
    ])
    agent = create_agent(model=make_fake_model(both, "ok"), tools=[], checkpointer=InMemorySaver(),
                         middleware=[ScratchpadMiddleware()])
    config = {"configurable": {"thread_id": "t"}}
    await agent.ainvoke({"messages": [{"role": "user", "content": "x"}]}, config)
    assert (await agent.aget_state(config)).values["notes"] == {"a": "1", "b": "2"}


async def test_notes_survive_summarization(make_fake_model):
    model = make_fake_model(
        tool_call("write_note", key="order_id", content="A-42"), "saved", "still know A-42"
    )
    summarizer = make_fake_model("SUMMARY OF EARLIER CHAT")
    agent = create_agent(
        model=model, tools=[], checkpointer=InMemorySaver(),
        middleware=[
            ScratchpadMiddleware(),
            SummarizationMiddleware(model=summarizer, trigger=("messages", 4), keep=("messages", 1)),
        ],
    )
    config = {"configurable": {"thread_id": "t"}}
    await agent.ainvoke({"messages": [{"role": "user", "content": "order A-42"}]}, config)
    await agent.ainvoke({"messages": [{"role": "user", "content": "what was it?"}]}, config)

    messages = (await agent.aget_state(config)).values["messages"]
    assert len(summarizer.received) == 1  # summarization happened
    assert not any("order A-42" == m.text for m in messages)  # old message gone
    assert "order_id: A-42" in model.system_prompts[-1]  # note still shown
