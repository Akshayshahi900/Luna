"""
File tools, locked to a set of workspace folders.

BEGINNER MAP
------------
make_fs_tools(roots) builds five tools that can ONLY touch files inside
``roots`` (LUNA_WORKSPACE_DIRS):

  list_dir      what's in a folder
  read_file     a file's lines (numbered, in pages)
  search_files  regex search across files
  write_file    create / overwrite a file      ← asks for approval
  edit_file     replace one exact snippet       ← asks for approval

Approval is not done here: the subagents that use these tools list
write_file / edit_file in ``interrupt_on`` (see luna/agent/subagents/).

Every path is resolved (``..`` and symlinks included) and refused if it
lands outside the roots. Problems come back as "Error: ..." text, so the
model can correct itself instead of the run crashing.
"""

from __future__ import annotations

import re
from pathlib import Path

from langchain_core.tools import BaseTool, tool

# Folders that are almost never what the user means and are huge.
_SKIP_DIRS = {".git", ".venv", "venv", "node_modules", "__pycache__", ".mypy_cache", ".pytest_cache"}
_MAX_LIST = 200
_MAX_MATCHES = 100
_MAX_READ_LINES = 400
_MAX_FILE_BYTES = 2_000_000  # don't read or search files bigger than this


class SandboxError(ValueError):
    """A path outside the workspace, or another refused file operation."""


class Workspace:
    """The folders file tools may use. Relative paths start at the first root."""

    def __init__(self, roots: list[Path]) -> None:
        if not roots:
            raise ValueError("At least one workspace folder is required")
        self.roots = [Path(r).expanduser().resolve() for r in roots]

    def resolve(self, path: str) -> Path:
        """Absolute, symlink-free path, or SandboxError if outside every root."""
        candidate = Path(path).expanduser()
        if not candidate.is_absolute():
            candidate = self.roots[0] / candidate
        resolved = candidate.resolve()
        if not any(resolved == root or resolved.is_relative_to(root) for root in self.roots):
            allowed = ", ".join(str(r) for r in self.roots)
            raise SandboxError(f"'{path}' is outside the workspace ({allowed})")
        return resolved

    def display(self, path: Path) -> str:
        """Path relative to the first root when possible (shorter for the model)."""
        try:
            return str(path.relative_to(self.roots[0])) or "."
        except ValueError:
            return str(path)


def _is_text(path: Path) -> bool:
    try:
        with path.open("rb") as fh:
            return b"\0" not in fh.read(4096)
    except OSError:
        return False


def make_fs_tools(roots: list[Path]) -> list[BaseTool]:
    """Build the file tools for these workspace folders."""
    ws = Workspace(roots)

    @tool
    def list_dir(path: str = ".") -> str:
        """List files and folders (folders end with '/').

        Args:
            path: Folder to list, relative to the workspace. Defaults to its top.
        """
        try:
            folder = ws.resolve(path)
            if not folder.is_dir():
                return f"Error: '{path}' is not a folder"
            entries = sorted(folder.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
        except (SandboxError, OSError) as exc:
            return f"Error: {exc}"
        lines = [f"{e.name}/" if e.is_dir() else e.name for e in entries[:_MAX_LIST]]
        if len(entries) > _MAX_LIST:
            lines.append(f"…and {len(entries) - _MAX_LIST} more")
        return "\n".join(lines) or "(empty folder)"

    @tool
    def read_file(path: str, start_line: int = 1, max_lines: int = _MAX_READ_LINES) -> str:
        """Read a text file. Lines are numbered; long files come in pages.

        Args:
            path: File to read, relative to the workspace.
            start_line: First line to show (1-based).
            max_lines: How many lines to show (at most 400).
        """
        try:
            file = ws.resolve(path)
            if not file.is_file():
                return f"Error: '{path}' is not a file"
            if file.stat().st_size > _MAX_FILE_BYTES or not _is_text(file):
                return f"Error: '{path}' is too large or not a text file"
            lines = file.read_text(encoding="utf-8", errors="replace").splitlines()
        except (SandboxError, OSError) as exc:
            return f"Error: {exc}"
        start = max(start_line, 1)
        count = min(max(max_lines, 1), _MAX_READ_LINES)
        chunk = lines[start - 1 : start - 1 + count]
        body = "\n".join(f"{n:>5}  {text}" for n, text in enumerate(chunk, start))
        end = start + len(chunk) - 1
        if end < len(lines):
            body += f"\n…lines {start}-{end} of {len(lines)}; use start_line={end + 1} for more"
        return body or "(empty file)"

    @tool
    def search_files(pattern: str, path: str = ".", glob: str = "*") -> str:
        """Search text files for a regular expression; returns 'file:line: text'.

        Args:
            pattern: Python regular expression, e.g. 'def main' or 'TODO|FIXME'.
            path: Folder to search in, relative to the workspace.
            glob: Only files whose name matches, e.g. '*.py' or '*.md'.
        """
        try:
            regex = re.compile(pattern)
            folder = ws.resolve(path)
        except re.error as exc:
            return f"Error: invalid pattern ({exc})"
        except SandboxError as exc:
            return f"Error: {exc}"
        matches: list[str] = []
        for file in sorted(folder.rglob(glob)):
            if len(matches) >= _MAX_MATCHES:
                break
            if any(part in _SKIP_DIRS for part in file.relative_to(folder).parts):
                continue
            if not file.is_file() or file.stat().st_size > _MAX_FILE_BYTES or not _is_text(file):
                continue
            try:
                ws.resolve(str(file))  # symlinks pointing outside are skipped
                text = file.read_text(encoding="utf-8", errors="replace")
            except (SandboxError, OSError):
                continue
            for n, line in enumerate(text.splitlines(), 1):
                if regex.search(line):
                    matches.append(f"{ws.display(file)}:{n}: {line.strip()[:200]}")
                    if len(matches) >= _MAX_MATCHES:
                        break
        if not matches:
            return "No matches."
        suffix = f"\n…stopped at {_MAX_MATCHES} matches" if len(matches) >= _MAX_MATCHES else ""
        return "\n".join(matches) + suffix

    @tool
    def write_file(path: str, content: str) -> str:
        """Create a file, or replace its whole content. Creates missing folders.

        Args:
            path: File to write, relative to the workspace.
            content: The complete new file content.
        """
        try:
            file = ws.resolve(path)
            existed = file.exists()
            if file.is_dir():
                return f"Error: '{path}' is a folder"
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text(content, encoding="utf-8")
        except (SandboxError, OSError) as exc:
            return f"Error: {exc}"
        action = "Overwrote" if existed else "Created"
        return f"{action} {ws.display(file)} ({len(content)} characters)"

    @tool
    def edit_file(path: str, old_text: str, new_text: str) -> str:
        """Replace one exact snippet in a file. Read the file first.

        Args:
            path: File to edit, relative to the workspace.
            old_text: Text to replace; must appear exactly once in the file.
            new_text: Replacement text.
        """
        try:
            file = ws.resolve(path)
            if not file.is_file():
                return f"Error: '{path}' is not a file"
            text = file.read_text(encoding="utf-8")
        except (SandboxError, OSError) as exc:
            return f"Error: {exc}"
        count = text.count(old_text) if old_text else 0
        if count != 1:
            found = "not found" if count == 0 else f"found {count} times"
            return f"Error: old_text {found}; it must appear exactly once"
        file.write_text(text.replace(old_text, new_text, 1), encoding="utf-8")
        return f"Edited {ws.display(file)}"

    return [list_dir, read_file, search_files, write_file, edit_file]


__all__ = ["SandboxError", "Workspace", "make_fs_tools"]
