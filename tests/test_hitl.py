import json

from langchain.agents import create_agent
from langchain.tools import tool
from langchain_core.messages import AIMessage
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.types import Command

from conftest import tool_call
from luna.agent.budget import TaskBudget, TaskBudgetMiddleware
from luna.agent.subagents import SubagentSpec, make_delegate_tool
from luna.cli.chat import answer_interrupt, run_turn, stream_reply
from luna.config import Settings
from luna.tools.builtin import ask_user


def _scripted(*answers):
    """Stand-in for input(): returns the given answers in order."""
    queue = list(answers)
    return lambda prompt="": queue.pop(0)


def _settings():
    return Settings(openrouter_api_key="test", task_budget=50)


def _files_setup(make_fake_model, *, path="notes.md"):
    """Main agent → ask_files → write_file (needs approval). Returns agent + log of writes."""
    written = []

    @tool
    def write_file(path: str, content: str) -> str:
        """Write a file."""
        written.append((path, content))
        return f"wrote {path}"

    helper_model = make_fake_model(
        tool_call("write_file", "w1", path=path, content="hello"), "files done"
    )
    delegate = make_delegate_tool(
        SubagentSpec(name="ask_files", description="Files.", system_prompt="p",
                     tools=[write_file], model=helper_model,
                     interrupt_on={"write_file": True}),
        default_model=None,
    )
    main_model = make_fake_model(tool_call("ask_files", task="save notes"), "all done")
    agent = create_agent(model=main_model, tools=[delegate], checkpointer=InMemorySaver())
    return agent, written


def _tool_results(agent_state):
    return [m.text for m in agent_state.values["messages"] if m.type == "tool"]


async def test_approve_runs_the_action(make_fake_model):
    agent, written = _files_setup(make_fake_model)
    await run_turn(agent, "save", "t", _settings(), ask=_scripted("a"))
    assert written == [("notes.md", "hello")]


async def test_nothing_runs_before_approval(make_fake_model):
    agent, written = _files_setup(make_fake_model)
    interrupts = await stream_reply(agent, "save", "t")
    assert written == []
    (pause,) = interrupts
    assert pause.value["action_requests"][0]["name"] == "write_file"


async def test_reject_skips_the_action_and_tells_the_model(make_fake_model):
    agent, written = _files_setup(make_fake_model)
    await run_turn(agent, "save", "t", _settings(), ask=_scripted("r", "not now"))
    assert written == []
    state = await agent.aget_state({"configurable": {"thread_id": "t"}})
    assert _tool_results(state) == ["files done"]  # the subagent carried on and finished


async def test_edit_runs_the_edited_arguments(make_fake_model):
    agent, written = _files_setup(make_fake_model)
    new_args = json.dumps({"path": "other.md", "content": "edited"})
    await run_turn(agent, "save", "t", _settings(), ask=_scripted("e", new_args))
    assert written == [("other.md", "edited")]


async def test_invalid_choice_is_asked_again(make_fake_model):
    agent, written = _files_setup(make_fake_model)
    await run_turn(agent, "save", "t", _settings(), ask=_scripted("x", "", "a"))
    assert written == [("notes.md", "hello")]


async def test_ask_user_returns_the_answer(make_fake_model):
    model = make_fake_model(tool_call("ask_user", question="Favourite colour?"), "Blue it is")
    agent = create_agent(model=model, tools=[ask_user], checkpointer=InMemorySaver())
    await run_turn(agent, "pick a colour", "t", _settings(), ask=_scripted("blue"))
    state = await agent.aget_state({"configurable": {"thread_id": "t"}})
    assert _tool_results(state) == ["blue"]
    assert state.values["messages"][-1].text == "Blue it is"


async def test_parallel_pauses_all_resume(make_fake_model):
    written = []

    @tool
    def write_file(path: str) -> str:
        """Write a file."""
        written.append(path)
        return f"wrote {path}"

    def delegate(name, path):
        model = make_fake_model(tool_call("write_file", f"w-{name}", path=path), f"{name} done")
        spec = SubagentSpec(name=name, description="d", system_prompt="p", tools=[write_file],
                            model=model, interrupt_on={"write_file": True})
        return make_delegate_tool(spec, None)

    both = AIMessage(content="", tool_calls=[
        {"name": "ask_a", "args": {"task": "x"}, "id": "o1"},
        {"name": "ask_b", "args": {"task": "y"}, "id": "o2"},
    ])
    agent = create_agent(model=make_fake_model(both, "done"),
                         tools=[delegate("ask_a", "a.txt"), delegate("ask_b", "b.txt")],
                         checkpointer=InMemorySaver())

    await run_turn(agent, "go", "t", _settings(), ask=_scripted("a", "a"))

    assert sorted(written) == ["a.txt", "b.txt"]


async def test_budget_carries_over_across_resume(make_fake_model):
    main = create_agent(model=make_fake_model(tool_call("ask_user", question="?"), "ok"),
                        tools=[ask_user], checkpointer=InMemorySaver(),
                        middleware=[TaskBudgetMiddleware()])
    budget = TaskBudget(limit=10)
    (pause,) = await stream_reply(main, "hi", "t", budget=budget)
    assert budget.used == 1
    await stream_reply(main, Command(resume={pause.id: "yes"}), "t", budget=budget)
    assert budget.used == 2


def test_answer_interrupt_formats():
    assert answer_interrupt({"type": "ask_user", "question": "Q?"}, _scripted("A")) == "A"
    hitl = {
        "action_requests": [{"name": "run_command", "args": {"cmd": "ls"}}],
        "review_configs": [{"action_name": "run_command", "allowed_decisions": ["approve", "reject"]}],
    }
    # "e" isn't allowed for this tool, so it's ignored and asked again.
    assert answer_interrupt(hitl, _scripted("e", "a")) == {"decisions": [{"type": "approve"}]}
    assert answer_interrupt(hitl, _scripted("r", "")) == {"decisions": [{"type": "reject"}]}
