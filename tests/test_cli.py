from langchain.agents import create_agent
from langchain_core.messages import AIMessage
from langgraph.checkpoint.memory import InMemorySaver

from luna.cli.chat import stream_reply
from luna.tools.builtin import calculator


async def test_stream_reply_shows_tool_calls_and_text(make_fake_model, capsys):
    model = make_fake_model(
        AIMessage(
            content="",
            tool_calls=[{"name": "calculator", "args": {"expression": "6*7"}, "id": "c1"}],
        ),
        "The answer is 42",
    )
    agent = create_agent(model=model, tools=[calculator], checkpointer=InMemorySaver())

    await stream_reply(agent, "what is 6*7?", "t")

    out = capsys.readouterr().out
    assert '→ calculator({"expression": "6*7"})' in out
    assert "← 42" in out
    assert "Luna: The answer is 42" in out
