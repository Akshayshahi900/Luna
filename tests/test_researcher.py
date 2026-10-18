import dataclasses

from langchain.tools import tool

from conftest import tool_call
from luna.agent.subagents import get_subagent_specs, make_delegate_tool
from luna.agent.subagents.researcher import researcher_spec
from luna.config import Settings
from luna.tools.limits import cap_output


def _settings(**overrides):
    return Settings(openrouter_api_key="test", **overrides)


def _names(settings):
    return {s.name for s in get_subagent_specs(settings)}


def test_researcher_off_without_tavily_key(tmp_path):
    settings = _settings(tavily_api_key=None, workspace_dirs=[tmp_path])
    assert researcher_spec(settings) is None
    assert "ask_researcher" not in _names(settings)


def test_researcher_on_with_key(tmp_path):
    settings = _settings(tavily_api_key="tvly-test", workspace_dirs=[tmp_path])
    spec = researcher_spec(settings)
    assert spec.name == "ask_researcher"
    assert {t.name for t in spec.tools} == {"tavily_search", "tavily_extract", "calculator"}
    assert spec.interrupt_on == {}  # read-only: never asks for approval
    assert "ask_researcher" in _names(settings)


async def test_researcher_answers_from_search_results(make_fake_model):
    @tool("tavily_search")
    def fake_search(query: str) -> dict:
        """Search the web."""
        return {"results": [{"url": "https://example.com/langgraph", "content": "v2 released"}]}

    model = make_fake_model(
        tool_call("tavily_search", query="langgraph release"),
        "LangGraph v2 was released.\n\nSources:\n- https://example.com/langgraph",
    )
    spec = dataclasses.replace(
        researcher_spec(_settings(tavily_api_key="tvly-test")), tools=[fake_search], model=model
    )

    answer = await make_delegate_tool(spec, None).ainvoke({"task": "What's new in LangGraph?"})

    assert "https://example.com/langgraph" in answer
    # The search result was shown to the researcher's model, not returned raw.
    assert any("v2 released" in text for text in model.inputs[1])


async def test_cap_output_truncates_long_results():
    @tool
    def big(n: int) -> str:
        """Return n characters."""
        return "x" * n

    capped = cap_output(big, max_chars=10)
    assert capped.name == "big" and capped.description == big.description
    assert await capped.ainvoke({"n": 5}) == "xxxxx"
    out = await capped.ainvoke({"n": 25})
    assert out.startswith("x" * 10) and "truncated 15 characters" in out


async def test_cap_output_serialises_dicts():
    @tool
    def data() -> dict:
        """Return a dict."""
        return {"a": 1}

    assert await cap_output(data).ainvoke({}) == '{"a": 1}'
