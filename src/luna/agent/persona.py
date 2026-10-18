"""
Persona — how Luna talks and who she talks to.

BEGINNER MAP
------------
The model's behaviour comes from its system prompt. Instead of one long
hard-coded string, the prompt is built here from small pieces, each one
controlled by a setting (see luna/config/settings.py):

  system_prompt     what Luna is and how she works (role, economy)
  response_style    'concise' (spoken, one or two sentences) or 'detailed'
  user_title        how she addresses you, e.g. "Sir" ("" = by name or not at all)
  user_name         your name, if you want her to know it
  user_location     your default place for weather, time, "near me" questions
  units             'metric' or 'imperial'
  timezone          your IANA timezone, e.g. Asia/Kolkata
  persona_path      optional Markdown file with any extra instructions

Example .env:

  LUNA_USER_TITLE=Sir
  LUNA_USER_LOCATION=Agra, India
  LUNA_TIMEZONE=Asia/Kolkata

Then "what's the weather?" gets something like
"It's 33 degrees, Sir, with a 30 percent chance of rain."

Only the main agent gets the persona. Helpers (researcher, coder, ...)
return facts to the main agent, which phrases the final reply.
"""

from __future__ import annotations

from pathlib import Path

from luna.config import Settings

CONCISE_STYLE = """
How to reply (your replies are usually spoken aloud):
- Answer in one or two short sentences, like a person talking. Lead with the answer.
- No lists, headings, markdown, URLs or source names unless the user asks for them.
- Give only what was asked: e.g. for weather, the temperature and chance of rain.
  Round numbers ("33 degrees", "30 percent"), and spell units the way you'd say them.
- If the user asks for detail, an explanation, steps or code, give it in full.
""".strip()

DETAILED_STYLE = """
How to reply:
- Lead with the answer, then the detail that helps. Use lists or code blocks when they help.
""".strip()

STYLES = {"concise": CONCISE_STYLE, "detailed": DETAILED_STYLE}


def _address_rule(settings: Settings) -> str:
    title = settings.user_title.strip()
    name = (settings.user_name or "").strip()
    if title:
        return (
            f'Address the user as "{title}", once per reply, '
            f'e.g. "It\'s 33 degrees, {title}, with a 30 percent chance of rain."'
        )
    if name:
        return f"Address the user by name ({name}) now and then, not in every reply."
    return ""


def _profile(settings: Settings) -> str:
    facts = []
    if settings.user_name:
        facts.append(f"- Name: {settings.user_name.strip()}")
    if settings.user_location:
        facts.append(
            f"- Location: {settings.user_location.strip()}. Use it when a question needs "
            "a place and none is given (weather, local time, news, \"near me\")."
        )
    facts.append(
        f"- Units: {settings.units}"
        + (" (Celsius, km, kg)." if settings.units == "metric" else " (Fahrenheit, miles, lb).")
    )
    if settings.timezone:
        facts.append(
            f"- Timezone: {settings.timezone}. Pass it to get_current_time for the local time."
        )
    return (
        "About the user:\n" + "\n".join(facts) + "\n"
        "When you hand a task to a helper, include the facts it needs (place, units)."
    )


def load_persona_file(path: Path | None) -> str:
    """Text of the user's persona file, or "" when there is none."""
    if path is None or not path.is_file():
        return ""
    return path.read_text(encoding="utf-8").strip()


def build_system_prompt(settings: Settings) -> str:
    """The main agent's full system prompt, built from the persona settings."""
    parts = [
        settings.system_prompt.strip(),
        STYLES[settings.response_style],
        _address_rule(settings),
        _profile(settings),
    ]
    extra = load_persona_file(settings.persona_path)
    if extra:
        parts.append("Extra instructions from the user (follow them):\n" + extra)
    return "\n\n".join(p for p in parts if p)


__all__ = ["build_system_prompt", "load_persona_file"]
