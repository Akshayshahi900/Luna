"""
Describe every setting for the Control Center, and save changes to `.env`.

BEGINNER MAP
------------
The browser builds its settings forms from ``settings_schema()``: one entry
per Settings field with its env name, type, choices, description, group and
when a change takes effect:

  "live"     read fresh on every use (the mail / Google MCP servers)
  "rebuild"  the agent is rebuilt right away (persona, limits, keys, ...)
  "restart"  only after restarting luna-web (storage paths, web server, voice)

``save_settings()`` turns the browser's values into `.env` text
(envfile.update_env), then re-reads the file with Settings() to validate.
A value Settings rejects puts the old file back, so a typo in the UI can
never stop Luna from starting.

Secrets (API keys, the mail password) are write-only: the browser only
learns whether one is set.

Read next: luna/web/control.py (the HTTP routes that use this).
"""

from __future__ import annotations

import os
import types
import typing
from pathlib import Path
from typing import Any

from pydantic import ValidationError

from luna.config.envfile import read_env, update_env
from luna.config.settings import Settings

ENV_PREFIX = "LUNA_"

# (group id, title, fields). Every Settings field belongs to exactly one.
GROUPS: list[tuple[str, str, list[str]]] = [
    ("models", "Model providers", [
        "provider", "model_name", "openrouter_api_key", "groq_api_key", "groq_model",
        "ollama_base_url", "ollama_model", "model_max_retries",
    ]),
    ("persona", "Persona", [
        "system_prompt", "response_style", "user_title", "user_name", "user_location",
        "units", "timezone", "persona_path",
    ]),
    ("limits", "Limits", ["max_model_calls", "max_tool_calls", "task_budget"]),
    ("memory", "Memory", [
        "memory_backend", "checkpoint_path", "summary_trigger_tokens", "summary_keep_tokens",
        "enable_longterm_memory", "longterm_memory_path", "memory_recall_limit",
        "memory_prompt_chars", "memory_max_suggestions",
    ]),
    ("tools", "Tools", ["tavily_api_key", "mcp_config_path", "enable_builtin_tools", "enable_mcp_tools"]),
    ("mail", "Mail", [
        "mail_backend", "mail_address", "mail_password", "mail_username", "mail_imap_host",
        "mail_imap_port", "mail_smtp_host", "mail_smtp_port", "mail_max_body_chars",
    ]),
    ("google", "Google", [
        "google_credentials_path", "google_token_path", "google_calendar_id",
        "google_tasklist_id", "tasks_google_sync",
    ]),
    ("permissions", "Permissions", ["workspace_dirs", "auto_approve"]),
    ("network", "Web server & network", [
        "web_host", "web_port", "web_allowed_origins", "web_open_window", "web_close_with_window", "web_browser",
    ]),
    ("voice", "Voice", [
        "tts_engine", "tts_voice", "tts_voices_dir", "tts_length_scale",
        "stt_engine", "stt_model", "stt_models_dir", "stt_threads",
    ]),
    ("routines", "Routines", ["routines_enabled", "routines_path"]),
]

SECRETS = frozenset({"openrouter_api_key", "groq_api_key", "tavily_api_key", "mail_password"})

CHOICES: dict[str, list[str]] = {
    "provider": ["openrouter", "groq", "ollama"],
    "response_style": ["concise", "detailed"],
    "units": ["metric", "imperial"],
    "memory_backend": ["sqlite", "memory"],
    "mail_backend": ["gmail", "imap"],
    "tts_engine": ["piper", "browser"],
    "stt_engine": ["whisper", "browser"],
}

# Read fresh by the MCP servers on every tool call (servers/*_mcp_server.py).
_LIVE = {f for _, _, fields in GROUPS if _ in {"mail", "google"} for f in fields}
# Opened once at startup.
_RESTART = {
    "provider", "model_name", "memory_backend", "checkpoint_path", "enable_longterm_memory",
    "longterm_memory_path", "mcp_config_path", "enable_mcp_tools", "web_host", "web_port",
    "web_allowed_origins", "web_open_window", "web_close_with_window", "web_browser", "tts_engine", "tts_voice", "tts_voices_dir", "tts_length_scale",
    "stt_engine", "stt_model", "stt_models_dir", "stt_threads", "routines_enabled", "routines_path",
}


def env_name(field: str) -> str:
    """Settings field → its environment variable (``units`` → ``LUNA_UNITS``)."""
    return ENV_PREFIX + field.upper()


def applies(field: str) -> str:
    """When a change to ``field`` takes effect: "live", "rebuild" or "restart"."""
    if field in _LIVE:
        return "live"
    if field in _RESTART:
        return "restart"
    return "rebuild"


def _kind(annotation: Any) -> str:
    """bool / int / float / path / list / str, ignoring ``| None``."""
    origin = typing.get_origin(annotation)
    if origin is typing.Annotated:
        return _kind(typing.get_args(annotation)[0])
    if origin in (typing.Union, types.UnionType):
        inner = [a for a in typing.get_args(annotation) if a is not type(None)]
        return _kind(inner[0]) if inner else "str"
    if origin is list:
        return "list"
    if annotation is bool:
        return "bool"
    if annotation is int:
        return "int"
    if annotation is float:
        return "float"
    if annotation is Path:
        return "path"
    return "str"


def to_json(value: Any) -> Any:
    """A Settings value as plain JSON (paths become text)."""
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, list):
        return [to_json(v) for v in value]
    return value


def to_env(kind: str, value: Any) -> str | None:
    """A value from the browser as `.env` text. None or "" removes the key
    (back to the default)."""
    if value is None:
        return None
    if kind == "bool":
        return "true" if value in (True, "true", "1", 1) else "false"
    if kind == "list":
        items = value if isinstance(value, list) else str(value).split(",")
        text = ",".join(str(v).strip() for v in items if str(v).strip())
        return text or None
    text = str(value).strip()
    return text or None


def settings_schema(settings: Settings, env_path: Path | str) -> dict[str, Any]:
    """Groups of fields with their current values (secrets masked) plus any
    LUNA_* keys in `.env` that Settings doesn't know (e.g. removed options)."""
    fields = Settings.model_fields
    in_file = read_env(env_path)
    groups = []
    for group_id, title, names in GROUPS:
        items = []
        for name in names:
            info = fields[name]
            kind = _kind(info.annotation)
            secret = name in SECRETS
            value = getattr(settings, name)
            default = info.get_default(call_default_factory=True)
            items.append({
                "name": name,
                "env": env_name(name),
                "kind": kind,
                "choices": CHOICES.get(name),
                "description": info.description or "",
                "secret": secret,
                "applies": applies(name),
                "value": None if secret else to_json(value),
                "is_set": bool(value) if secret else None,
                "default": None if secret else to_json(default),
                "in_file": env_name(name) in in_file,
            })
        groups.append({"id": group_id, "title": title, "fields": items})
    known = {env_name(n) for n in fields}
    unknown = sorted(k for k in in_file if k.startswith(ENV_PREFIX) and k not in known)
    return {"env_path": str(env_path), "groups": groups, "unknown": unknown}


class SettingsRejected(ValueError):
    """A change Settings refused; `.env` was left as it was."""


def save_settings(
    env_path: Path | str,
    values: dict[str, Any],
    remove_unknown: list[str] | None = None,
) -> tuple[Settings, dict[str, str]]:
    """Write ``{field: value}`` to `.env`, validate, and return the new
    Settings plus ``{field: applies}`` for every changed field.

    Unknown field names are refused. ``remove_unknown`` deletes stale
    LUNA_* keys that Settings no longer reads.
    """
    env_path = Path(env_path)
    fields = Settings.model_fields
    changes: dict[str, str | None] = {}
    effects: dict[str, str] = {}
    for name, value in values.items():
        if name not in fields:
            raise SettingsRejected(f"Unknown setting: {name}")
        changes[env_name(name)] = to_env(_kind(fields[name].annotation), value)
        effects[name] = applies(name)
    known = {env_name(n) for n in fields}
    for key in remove_unknown or []:
        if not key.startswith(ENV_PREFIX) or key in known:
            raise SettingsRejected(f"{key} is not an unknown LUNA_ key")
        changes[key] = None

    before = env_path.read_bytes() if env_path.exists() else None
    try:
        update_env(env_path, changes)
        settings = Settings(_env_file=env_path)
    except (ValidationError, ValueError) as exc:
        _restore(env_path, before)
        raise SettingsRejected(_short_error(exc)) from exc
    return settings, effects


def _restore(path: Path, data: bytes | None) -> None:
    """Put the original file back byte for byte (not re-formatted)."""
    if data is None:
        path.unlink(missing_ok=True)
        return
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_bytes(data)
    os.chmod(tmp, path.stat().st_mode & 0o777)
    tmp.replace(path)


def _short_error(exc: Exception) -> str:
    if isinstance(exc, ValidationError):
        return "; ".join(
            f"{env_name(str(e['loc'][0])) if e['loc'] else 'value'}: {e['msg']}" for e in exc.errors()
        )
    return str(exc)


__all__ = [
    "CHOICES",
    "GROUPS",
    "SECRETS",
    "SettingsRejected",
    "applies",
    "env_name",
    "save_settings",
    "settings_schema",
    "to_env",
    "to_json",
]
