"""
Researcher subagent — web search and reading pages (Tavily).

Why a subagent (spec2 rule 1): research is noisy and multi-step. Several
searches and long pages stay in the researcher's own context; the main
agent only gets the short, sourced answer.

Enabled only when LUNA_TAVILY_API_KEY is set. All tools are read-only, so
nothing here needs human approval.
"""

from __future__ import annotations

from langchain_tavily import TavilyExtract, TavilySearch

from luna.agent.subagents.base import SubagentSpec
from luna.config import Settings
from luna.tools.builtin import calculator
from luna.tools.limits import cap_output

RESEARCHER_PROMPT = """
You are Luna's research helper. Answer the task using the web.

- Start with tavily_search. Run several focused searches rather than one vague one.
- Use tavily_extract on the most promising URLs when snippets are not enough.
- Prefer recent, primary sources. Note dates when they matter.
- If sources disagree or you are unsure, say so.
- Reply in at most 300 words: the answer first, then a "Sources:" list of URLs.
""".strip()

DESCRIPTION = (
    "Research a question on the web and get back a short answer with sources. "
    "Use for current events, facts you are unsure of, comparisons, or anything "
    "that needs several searches or reading web pages."
)


def researcher_spec(settings: Settings) -> SubagentSpec | None:
    """The researcher, or None when no Tavily key is configured."""
    if not settings.tavily_api_key:
        return None
    key = settings.tavily_api_key
    return SubagentSpec(
        name="ask_researcher",
        description=DESCRIPTION,
        system_prompt=RESEARCHER_PROMPT,
        tools=[
            cap_output(TavilySearch(max_results=5, tavily_api_key=key)),
            cap_output(TavilyExtract(extract_depth="basic", tavily_api_key=key)),
            calculator,
        ],
        max_model_calls=10,
        timeout_seconds=180,
    )


__all__ = ["researcher_spec"]
