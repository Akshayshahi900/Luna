"""
Read and edit the project's `.env` file in place (used by the Control Center).

BEGINNER MAP
------------
Settings (settings.py) only READS `.env`. The Control Center in the web UI
also needs to WRITE it, without wrecking the file you edit by hand:

  read_env(path)              → {"LUNA_UNITS": "metric", ...}
  update_env(path, changes)   → set keys, or remove them with None

update_env keeps every comment (also a "# note" after a value), blank
line and the order of the keys:
it only rewrites the lines of the keys it changes and adds new keys at the
end. The new file is written next to the old one and renamed over it, so
a crash never leaves half a file. A new `.env` is created readable by you
only (it holds API keys).

Values with newlines are refused: one would turn into a second key.

Read next: luna/config/schema.py (what the UI shows for each setting).
"""

from __future__ import annotations

import os
import re
from pathlib import Path

# KEY=value, optionally with "export " in front (both are valid .env lines).
_LINE = re.compile(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$")
_KEY = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
# Unquoted values may hold these; anything else gets double quotes.
_PLAIN = re.compile(r"^[A-Za-z0-9_./:@,+\-~%]*$")


class EnvFileError(ValueError):
    """A change update_env refuses (bad key, newline in a value, ...)."""


def parse_value(raw: str) -> str:
    """The value part of one line, without quotes or a trailing comment."""
    raw = raw.strip()
    if len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in "\"'":
        inner = raw[1:-1]
        if raw[0] == '"':
            inner = inner.replace('\\"', '"').replace("\\\\", "\\")
        return inner
    # A quoted value followed by a comment: "abc" # note
    if raw[:1] in "\"'":
        end = raw.find(raw[0], 1)
        if end > 0:
            return parse_value(raw[: end + 1])
    # Unquoted: " #" starts a comment.
    hash_at = raw.find(" #")
    return (raw[:hash_at] if hash_at >= 0 else raw).strip()


def trailing_comment(raw: str) -> str:
    """The " # note" after a value (with its spacing), or "" if there is none."""
    stripped = raw.strip()
    if stripped[:1] in "\"'":
        end = stripped.find(stripped[0], 1)
        rest = stripped[end + 1:] if end > 0 else ""
        at = rest.find("#")
        return "  " + rest[at:] if at >= 0 else ""
    at = raw.find(" #")
    if at < 0:
        return ""
    value_end = len(raw[:at].rstrip())
    return raw[value_end:]


def format_value(value: str) -> str:
    """How a value is written: bare when safe, otherwise double-quoted."""
    if _PLAIN.match(value):
        return value
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def read_env(path: Path | str) -> dict[str, str]:
    """Every KEY=value in the file (the last one wins). {} if it doesn't exist."""
    path = Path(path)
    if not path.exists():
        return {}
    values: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.lstrip().startswith("#"):
            continue
        match = _LINE.match(line)
        if match:
            values[match.group(1)] = parse_value(match.group(2))
    return values


def _check(changes: dict[str, str | None]) -> None:
    for key, value in changes.items():
        if not _KEY.match(key):
            raise EnvFileError(f"Invalid key: {key!r}")
        if value is not None and any(c in value for c in "\r\n\0"):
            raise EnvFileError(f"{key}: values must be on one line")


def update_env(path: Path | str, changes: dict[str, str | None]) -> None:
    """Set (str) or remove (None) keys, keeping everything else as it was.

    A key that appears twice is set on its first line and the later
    duplicates are dropped, so the file can't contradict itself.
    """
    _check(changes)
    path = Path(path)
    lines = path.read_text(encoding="utf-8").splitlines() if path.exists() else []
    pending = dict(changes)
    seen: set[str] = set()
    out: list[str] = []
    for line in lines:
        match = None if line.lstrip().startswith("#") else _LINE.match(line)
        key = match.group(1) if match else None
        if key is None or key not in changes:
            out.append(line)
            continue
        if key in seen:
            continue  # a duplicate of a key we already wrote
        seen.add(key)
        value = pending.pop(key)
        if value is not None:
            out.append(f"{key}={format_value(value)}{trailing_comment(match.group(2))}")
    for key, value in pending.items():
        if value is not None:
            out.append(f"{key}={format_value(value)}")

    text = "\n".join(out) + ("\n" if out else "")
    mode = path.stat().st_mode & 0o777 if path.exists() else 0o600
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.chmod(tmp, mode)
    tmp.replace(path)


__all__ = ["EnvFileError", "format_value", "parse_value", "read_env", "trailing_comment", "update_env"]
