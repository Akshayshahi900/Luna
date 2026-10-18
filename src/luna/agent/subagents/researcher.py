"""
Researcher subagent — web search and reading pages (Tavily).

Why a subagent (spec2 rule 1): research is noisy and multi-step. Several
searches and long pages stay in the researcher's own context; the main
agent only gets the key facts (≤ 60 words) and a source or two.

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

- Every step costs an API request, so be brief: one or two focused tavily_search
  calls usually suffice. When you need several searches, make them in the same step.
- Use tavily_extract only when the snippets truly are not enough, on one or two URLs.
- Answer as soon as you have enough; do not keep searching to be thorough.
- Prefer recent, primary sources. Note dates when they matter.
- tavily_search returns a short "answer" next to the results; if it answers the
  task, use it and stop.
- If sources disagree or you are unsure, say so in a few words.
- Your reply is turned into one or two spoken sentences, so return only the facts
  that answer the task (numbers with units, names, dates), at most 60 words, no
  background or filler. If the task asks for a detailed report, up to 300 words is fine.
- End with a "Sources:" line of at most two URLs.
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
            # Fewer, shorter results plus Tavily's own one-paragraph answer:
            # most questions are settled by the answer alone (less noise, fewer calls).
            cap_output(
                TavilySearch(
                    max_results=3,
                    include_answer="basic",
                    search_depth="basic",
                    tavily_api_key=key,
                ),
                max_chars=4000,
            ),
            cap_output(TavilyExtract(extract_depth="basic", tavily_api_key=key)),
            calculator,
        ],
        max_model_calls=5,
        timeout_seconds=180,
    )


__all__ = ["researcher_spec"]
