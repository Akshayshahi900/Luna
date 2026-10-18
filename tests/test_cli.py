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
