"""
Files subagent — read, search and write files in the workspace.

Why a subagent (spec2 rules 1 and 3): reading and searching files fills
the context with noise, and writing needs tighter permissions. The main
agent gets a short summary (and file paths), never whole files.

Always enabled. Tools only reach LUNA_WORKSPACE_DIRS (default ./workspace).
write_file and edit_file ask for approval unless listed in LUNA_AUTO_APPROVE.
"""

from __future__ import annotations

from luna.agent.subagents.base import SubagentSpec, needs_approval
from luna.config import Settings
from luna.tools.fs import make_fs_tools

WRITE_TOOLS = ["write_file", "edit_file"]

FILES_PROMPT = """
You are Luna's files helper. You can only use these folders:
{roots}
Relative paths start at {first}.

- Look before you act: list_dir / search_files to find things, read_file before edit_file.
- Prefer edit_file for small changes; write_file for new files or full rewrites.
- write_file and edit_file may need the user's approval. If the user rejects an
  action, do not retry it; report what you were going to do instead.
- You cannot run commands or programs. Never write scripts as a way to "run"
  something. If the task needs something executed, do the file part and say
  that running it needs the coding helper.
- Reply in at most 300 words. For long results, save them to a file and give the path.
""".strip()

DESCRIPTION = (
    "Work with the user's documents and notes: find, read, summarise, create or "
    "edit files in the workspace folders. Cannot run commands or programs; for "
    "code changes, tests or anything that must be executed, use ask_coder. "
    "Writes ask the user for approval."
)


def files_spec(settings: Settings) -> SubagentSpec:
    roots = settings.workspace_dirs
    roots[0].mkdir(parents=True, exist_ok=True)
    return SubagentSpec(
        name="ask_files",
        description=DESCRIPTION,
        system_prompt=FILES_PROMPT.format(
            roots="\n".join(f"- {r}" for r in roots), first=roots[0]
        ),
        tools=make_fs_tools(roots),
        interrupt_on=needs_approval(WRITE_TOOLS, settings.auto_approve),
        max_model_calls=12,
        timeout_seconds=180,
    )


__all__ = ["WRITE_TOOLS", "files_spec"]
