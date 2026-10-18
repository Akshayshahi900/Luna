from langchain.agents import create_agent
from langgraph.checkpoint.memory import InMemorySaver

from luna.agent.builder import build_middleware, recursion_limit
from luna.cli.chat import stream_reply
from luna.config import Settings
from luna.tools.builtin import calculator


def _settings(**overrides) -> Settings:
    return Settings(openrouter_api_key="test", summary_trigger_tokens=0, **overrides)


def _agent(model, settings):
    return create_agent(
        model=model,
        tools=[calculator],
        checkpointer=InMemorySaver(),
        middleware=build_middleware(settings, model),
    )


async def _run(agent, settings, text="loop"):
    return await agent.ainvoke(
        {"messages": [{"role": "user", "content": text}]},
        {"configurable": {"thread_id": "t"}, "recursion_limit": recursion_limit(settings)},
    )


async def test_model_call_limit_ends_cleanly(make_looping_model):
    settings = _settings(max_model_calls=3)
    model = make_looping_model()

    result = await _run(_agent(model, settings), settings)

    assert len(model.received) == 3
    assert result["messages"][-1].text.startswith("Model call limits exceeded")


async def test_tool_call_limit_refuses_extra_calls(make_looping_model):
    settings = _settings(max_model_calls=6, max_tool_calls=2)

    result = await _run(_agent(make_looping_model(), settings), settings)

    ran = [m for m in result["messages"] if m.type == "tool" and m.content == "4"]
    assert len(ran) == 2


async def test_limit_is_per_message_not_per_thread(make_looping_model):
    settings = _settings(max_model_calls=2)
    model = make_looping_model()
    agent = _agent(model, settings)

    await _run(agent, settings)
    await _run(agent, settings)

    assert len(model.received) == 4  # 2 per user message, not 2 in total


async def test_cli_shows_limit_notice(make_looping_model, capsys):
    settings = _settings(max_model_calls=2)

    await stream_reply(_agent(make_looping_model(), settings), "loop", "t", recursion_limit(settings))

    assert "⚠ Model call limits exceeded" in capsys.readouterr().out
