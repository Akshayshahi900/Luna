import asyncio

import pytest
from langchain.agents import create_agent
from langchain.tools import tool
from langgraph.checkpoint.memory import InMemorySaver

from conftest import tool_call
from luna.agent.subagents import SubagentSpec, make_delegate_tool
from luna.cli.chat import stream_reply
from luna.tools.builtin import calculator


def _helper(model, **overrides) -> SubagentSpec:
    fields = {
        "name": "ask_helper",
        "description": "Hand a maths task to the helper.",
        "system_prompt": "You are a helper.",
        "tools": [calculator],
        "model": model,
    }
    return SubagentSpec(**(fields | overrides))


def _main_agent(main_model, delegate):
    return create_agent(model=main_model, tools=[delegate], checkpointer=InMemorySaver())


async def test_delegate_returns_answer_and_keeps_main_history_clean(make_fake_model):
    helper_model = make_fake_model(tool_call("calculator", expression="2+2"), "helper says 4")
    delegate = make_delegate_tool(_helper(helper_model), default_model=None)
    main_model = make_fake_model(tool_call("ask_helper", task="what is 2+2?"), "It is 4.")

    result = await _main_agent(main_model, delegate).ainvoke(
        {"messages": [{"role": "user", "content": "2+2?"}]},
        {"configurable": {"thread_id": "t"}},
    )

    history = [(m.type, m.text) for m in result["messages"]]
    assert history == [
        ("human", "2+2?"),
        ("ai", ""),
        ("tool", "helper says 4"),
        ("ai", "It is 4."),
    ]


async def test_each_delegation_starts_with_fresh_context(make_fake_model):
    helper_model = make_fake_model("first", "second")
    delegate = make_delegate_tool(_helper(helper_model), default_model=None)

    assert await delegate.ainvoke({"task": "one"}) == "first"
    assert await delegate.ainvoke({"task": "two"}) == "second"
    # Both calls saw only [system prompt, task] — nothing carried over.
    assert helper_model.received == [2, 2]


async def test_falls_back_to_main_model(make_fake_model):
    main_model = make_fake_model("from main model")
    delegate = make_delegate_tool(_helper(None), default_model=main_model)
    assert await delegate.ainvoke({"task": "x"}) == "from main model"


async def test_subagent_limit_returns_marked_partial_result(make_looping_model):
    delegate = make_delegate_tool(_helper(make_looping_model(), max_model_calls=2), None)

    result = await delegate.ainvoke({"task": "loop"})

    assert result.startswith("[ask_helper stopped at its limit of 2 steps]")


async def test_subagent_timeout(make_looping_model):
    @tool
    async def slow() -> str:
        """Takes a while."""
        await asyncio.sleep(5)
        return "done"

    spec = _helper(make_looping_model("slow"), tools=[slow], timeout_seconds=0.1)
    result = await make_delegate_tool(spec, None).ainvoke({"task": "x"})

    assert result == "[ask_helper stopped: timed out after 0.1s]"


def test_subagents_cannot_nest(make_fake_model):
    inner = make_delegate_tool(_helper(make_fake_model()), None)
    spec = SubagentSpec(name="outer", description="d", system_prompt="p", tools=[inner])
    with pytest.raises(ValueError, match="may not use other subagents"):
        make_delegate_tool(spec, None)


async def test_cli_indents_subagent_steps(make_fake_model, capsys):
    helper_model = make_fake_model(tool_call("calculator", expression="2+2"), "helper says 4")
    delegate = make_delegate_tool(_helper(helper_model), None)
    main_model = make_fake_model(tool_call("ask_helper", task="2+2"), "It is 4.")

    await stream_reply(_main_agent(main_model, delegate), "2+2?", "t")

    lines = capsys.readouterr().out.splitlines()
    assert '  → ask_helper({"task": "2+2"})' in lines
    assert '    → calculator({"expression": "2+2"})' in lines
    assert "    ← 4" in lines
    assert "  ← helper says 4" in lines
    assert "Luna: It is 4." in lines


async def test_fresh_context_inside_a_checkpointed_main_agent(make_fake_model):
    # Subagents share the main checkpointer (needed for approval pauses);
    # each call must still start empty, even across separate user messages.
    helper_model = make_fake_model("r1", "r2", "r3")
    delegate = make_delegate_tool(_helper(helper_model, tools=[]), None)
    main_model = make_fake_model(
        tool_call("ask_helper", "o1", task="a"), tool_call("ask_helper", "o2", task="b"), "done",
        tool_call("ask_helper", "o3", task="c"), "done again",
    )
    agent = _main_agent(main_model, delegate)
    config = {"configurable": {"thread_id": "t"}}

    await agent.ainvoke({"messages": [{"role": "user", "content": "one"}]}, config)
    await agent.ainvoke({"messages": [{"role": "user", "content": "two"}]}, config)

    assert helper_model.received == [2, 2, 2]  # [system prompt, task] every time


async def test_context_is_passed_to_the_subagent(make_fake_model):
    helper_model = make_fake_model("ok")
    delegate = make_delegate_tool(_helper(helper_model, tools=[]), None)

    await delegate.ainvoke({"task": "book a table", "context": "user is vegetarian"})

    task_message = helper_model.inputs[0][-1]
    assert "book a table" in task_message and "user is vegetarian" in task_message
