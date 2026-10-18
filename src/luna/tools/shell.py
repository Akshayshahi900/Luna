"""
run_command — run a shell command inside the workspace.

BEGINNER MAP
------------
The command runs with a workspace folder as its working directory, a time
limit, and its output (stdout + stderr) cut to a readable size.

A shell command can still reach outside the workspace (``cd /``, ``rm``),
so the folder check is a convenience, NOT a security boundary. The real
safeguard is approval: the coder subagent always asks before running a
command unless you list run_command in LUNA_AUTO_APPROVE (not recommended).
"""

from __future__ import annotations

import asyncio
import contextlib
import os
import signal
from pathlib import Path

from langchain_core.tools import BaseTool, tool

from luna.tools.fs import SandboxError, Workspace

_MAX_TIMEOUT = 600
_HEAD_CHARS = 2000  # keep the start (the command's first errors)…
_TAIL_CHARS = 6000  # …and the end (test summaries, final errors)


def _trim(output: str) -> str:
    if len(output) <= _HEAD_CHARS + _TAIL_CHARS:
        return output
    dropped = len(output) - _HEAD_CHARS - _TAIL_CHARS
    return f"{output[:_HEAD_CHARS]}\n…[{dropped} characters omitted]…\n{output[-_TAIL_CHARS:]}"


def make_run_command(roots: list[Path]) -> BaseTool:
    """Build run_command for these workspace folders."""
    ws = Workspace(roots)

    @tool
    async def run_command(command: str, cwd: str = ".", timeout_seconds: int = 60) -> str:
        """Run a shell command and return its exit code and output.

        Args:
            command: The command line, e.g. 'uv run pytest -q' or 'ls -la'.
            cwd: Folder to run in, relative to the workspace.
            timeout_seconds: Kill the command after this many seconds (max 600).
        """
        try:
            folder = ws.resolve(cwd)
        except SandboxError as exc:
            return f"Error: {exc}"
        if not folder.is_dir():
            return f"Error: '{cwd}' is not a folder"
        timeout = min(max(timeout_seconds, 1), _MAX_TIMEOUT)

        proc = await asyncio.create_subprocess_shell(
            command,
            cwd=folder,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            start_new_session=True,  # own process group, so a timeout kills children too
        )
        try:
            raw, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        except TimeoutError:
            os.killpg(proc.pid, signal.SIGKILL)
            await proc.wait()
            return f"$ {command}\nTimed out after {timeout}s (killed)."
        except asyncio.CancelledError:
            # The user cancelled the task (web UI "cancel"): don't leave it running.
            with contextlib.suppress(ProcessLookupError):
                os.killpg(proc.pid, signal.SIGKILL)
            raise
        output = _trim(raw.decode("utf-8", errors="replace")).rstrip()
        return f"$ {command}\n(exit code {proc.returncode})\n{output or '(no output)'}"

    return run_command


__all__ = ["make_run_command"]
