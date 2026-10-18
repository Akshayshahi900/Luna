"""Persona: the main agent's system prompt is built from the persona settings."""

import pytest
from langgraph.checkpoint.memory import InMemorySaver

from luna.agent.builder import assemble_agent
from luna.agent.persona import CONCISE_STYLE, DETAILED_STYLE, build_system_prompt
from luna.agent.subagents.researcher import RESEARCHER_PROMPT
from luna.config import Settings


def _settings(tmp_path, **overrides):
    overrides.setdefault("persona_path", tmp_path / "persona.md")  # absent by default
    return Settings(_env_file=None, openrouter_api_key="test", workspace_dirs=[tmp_path], **overrides)


def test_defaults_are_concise_and_say_sir(tmp_path):
    prompt = build_system_prompt(_settings(tmp_path))
    assert prompt.startswith("You are Luna")
    assert CONCISE_STYLE in prompt
    assert DETAILED_STYLE not in prompt
    assert 'Address the user as "Sir"' in prompt
    assert "Units: metric" in prompt


def test_profile_facts_are_included(tmp_path):
    prompt = build_system_prompt(_settings(
        tmp_path, user_name="Akshay", user_location="Agra, India",
        timezone="Asia/Kolkata", units="IMPERIAL",
    ))
    assert "Name: Akshay" in prompt
    assert "Location: Agra, India" in prompt
    assert "Timezone: Asia/Kolkata" in prompt
    assert "Units: imperial (Fahrenheit" in prompt


def test_detailed_style_and_no_title(tmp_path):
    prompt = build_system_prompt(_settings(tmp_path, response_style="detailed", user_title=""))
    assert DETAILED_STYLE in prompt
    assert CONCISE_STYLE not in prompt
    assert "Address the user" not in prompt

    named = build_system_prompt(_settings(tmp_path, user_title="", user_name="Akshay"))
    assert "Address the user by name (Akshay)" in named


def test_persona_file_is_appended(tmp_path):
    (tmp_path / "persona.md").write_text("Use 24-hour time.\n", encoding="utf-8")
    prompt = build_system_prompt(_settings(tmp_path))
    assert prompt.endswith("Extra instructions from the user (follow them):\nUse 24-hour time.")


def test_missing_or_disabled_persona_file_is_fine(tmp_path):
    assert "Extra instructions" not in build_system_prompt(_settings(tmp_path))
    assert "Extra instructions" not in build_system_prompt(_settings(tmp_path, persona_path=None))


def test_bad_values_are_rejected(tmp_path):
    with pytest.raises(ValueError, match="response_style"):
        _settings(tmp_path, response_style="chatty")
    with pytest.raises(ValueError, match="units"):
        _settings(tmp_path, units="furlongs")


async def test_main_agent_sees_the_persona(tmp_path, make_fake_model):
    settings = _settings(tmp_path, user_location="Agra, India", enable_mcp_tools=False)
    model = make_fake_model("It's 33 degrees, Sir.")
    agent, _ = await assemble_agent(settings, model, InMemorySaver(), {})

    await agent.ainvoke(
        {"messages": [{"role": "user", "content": "weather?"}]},
        {"configurable": {"thread_id": "t"}},
    )
    assert 'Address the user as "Sir"' in model.system_prompts[0]
    assert "Location: Agra, India" in model.system_prompts[0]


def test_researcher_returns_short_facts():
    assert "at most 60 words" in RESEARCHER_PROMPT
    assert "at most two URLs" in RESEARCHER_PROMPT
