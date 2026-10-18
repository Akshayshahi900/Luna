from langchain.agents import create_agent
from langgraph.checkpoint.memory import InMemorySaver

from luna.agent.budget import TaskBudget, TaskBudgetMiddleware
from luna.agent.runner import run_task
from luna.agent.subagents import SubagentSpec, make_delegate_tool
from luna.tools.builtin import calculator


def _config():
    return {"configurable": {"thread_id": "t"}, "recursion_limit": 500}


async def test_budget_is_shared_by_main_agent_and_subagents(make_looping_model):
    helper_model = make_looping_model()
    delegate = make_delegate_tool(
        SubagentSpec(name="ask_helper", description="d", system_prompt="p",
                     model=helper_model, tools=[calculator], max_model_calls=100),
        default_model=None,
    )
    main_model = make_looping_model("ask_helper", task="go")
    agent = create_agent(
        model=main_model, tools=[delegate], checkpointer=InMemorySaver(),
        middleware=[TaskBudgetMiddleware()],
    )
    budget = TaskBudget(limit=5)

    await run_task(agent, {"messages": [{"role": "user", "content": "hi"}]}, _config(), budget=budget)

    assert len(main_model.received) + len(helper_model.received) == 5
    assert budget.used == 5 and budget.remaining == 0


async def test_exhausted_budget_ends_with_message(make_looping_model):
    agent = create_agent(model=make_looping_model(), tools=[], checkpointer=InMemorySaver(),
                         middleware=[TaskBudgetMiddleware()])
    await run_task(agent, {"messages": [{"role": "user", "content": "hi"}]}, _config(),
                   budget=TaskBudget(limit=0))
    state = await agent.aget_state(_config())
    assert state.values["messages"][-1].text.startswith("Task budget exhausted")


async def test_no_active_budget_means_no_limit(make_fake_model):
    model = make_fake_model("a")
    agent = create_agent(model=model, tools=[], middleware=[TaskBudgetMiddleware()])
    result = await agent.ainvoke({"messages": [{"role": "user", "content": "hi"}]})
    assert result["messages"][-1].text == "a"
