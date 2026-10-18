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


def test_memory_command_edits_inbox_and_undo():
    from luna.agent.longterm import LongTermStore
    from luna.cli.chat import memory_command

    store = LongTermStore()
    assert memory_command(store, "") == "(no memories yet)"
    assert memory_command(store, " add preference: tea, not coffee") == "Saved m1."
    assert memory_command(store, " add Lives in Agra") == "Saved m2."
    assert "(preference) tea, not coffee" in memory_command(store, " list")
    assert "Lives in Agra" in memory_command(store, " search agra")

    assert memory_command(store, " edit m2 Lives in Delhi") == "Updated m2."
    assert memory_command(store, " pin 2") == "Pinned m2."
    assert memory_command(store, " undo 2") == "Undone. m2 is now: Lives in Delhi"
    assert memory_command(store, " rm 2").startswith("Deleted m2")
    assert memory_command(store, " undo m2") == "Undone. m2 is now: Lives in Delhi"
    assert "edit" in memory_command(store, " history 2")

    s = store.suggest("add", "Has a dog named Bruno", "person", reason="said so")
    assert "add (person): Has a dog named Bruno  — said so" in memory_command(store, " inbox")
    assert memory_command(store, f" accept s{s['id']} Has a beagle") == f"Accepted s{s['id']} → m3: Has a beagle"
    s2 = store.suggest("forget", target_id=1)
    assert memory_command(store, f" reject {s2['id']}") == f"Declined s{s2['id']}."
    assert memory_command(store, " inbox") == "(inbox empty)"

    assert memory_command(store, " rm 99") == "No memory m99."
    assert memory_command(store, " rm abc").startswith("Give a number")
    assert memory_command(store, " bogus").startswith("Unknown /memory command")
    assert memory_command(None, " list").startswith("Long-term memory is off")


async def test_session_commands_list_resume_delete(make_fake_model, capsys):
    from luna.cli.chat import session_command
    from luna.config import Settings

    settings = Settings(openrouter_api_key="test")
    agent = create_agent(model=make_fake_model("Goa it is", "4"), tools=[], checkpointer=InMemorySaver())
    await stream_reply(agent, "plan my trip to Goa", "s-old")
    await stream_reply(agent, "what is 2+2", "s-new")
    capsys.readouterr()

    current = await session_command(agent, "/new", "", "s-new", settings)
    assert current not in {"s-old", "s-new"}

    assert await session_command(agent, "/sessions", "", current, settings) == current
    out = capsys.readouterr().out
    assert out.index("what is 2+2") < out.index("plan my trip to Goa")  # most recent first

    current = await session_command(agent, "/resume", "2", current, settings)
    assert current == "s-old"
    out = capsys.readouterr().out
    assert "Resumed: plan my trip to Goa" in out and "Luna: Goa it is" in out

    # Delete asks first; deleting the open session starts a new one.
    assert await session_command(agent, "/delete", "1", current, settings, ask=lambda _: "n") == current
    current = await session_command(agent, "/delete", "s-old", current, settings, ask=lambda _: "y")
    assert current != "s-old"
    await session_command(agent, "/sessions", "", current, settings)
    out = capsys.readouterr().out
    assert "Deleted: plan my trip to Goa" in out and "plan my trip" not in out.split("New session:")[-1]


async def test_resuming_a_paused_session_answers_the_pause_first(make_fake_model, capsys):
    from langchain.agents import create_agent as make
    from conftest import tool_call
    from luna.cli.chat import session_command
    from luna.config import Settings
    from luna.tools.builtin import ask_user

    model = make_fake_model(tool_call("ask_user", question="Which city?"), "Booked Goa")
    agent = make(model=model, tools=[ask_user], checkpointer=InMemorySaver())
    await stream_reply(agent, "book a trip", "paused")

    current = await session_command(
        agent, "/resume", "paused", "other", Settings(openrouter_api_key="test"), ask=lambda _: "Goa"
    )
    assert current == "paused"
    out = capsys.readouterr().out
    assert "waiting for you" in out and "Which city?" in out and "Luna: Booked Goa" in out
