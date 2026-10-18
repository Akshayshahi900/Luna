"""
Coder subagent — read code, edit it, and run commands (tests, builds).

Why a subagent (spec2 rules 1 and 3): coding is long and noisy (reading
files, test output), and running commands needs the strictest permissions.

Always enabled. Uses the same workspace folders as the files helper.
write_file, edit_file and run_command ask for approval unless listed in
LUNA_AUTO_APPROVE. It also gets write_todos to plan multi-step changes.
"""

from __future__ import annotations

from langchain.agents.middleware import TodoListMiddleware

from luna.agent.subagents.base import SubagentSpec, needs_approval
from luna.agent.subagents.files import WRITE_TOOLS
from luna.config import Settings
from luna.tools.fs import make_fs_tools
from luna.tools.shell import make_run_command

CODER_PROMPT = """
You are Luna's coding helper. You can only use these folders:
{roots}
Relative paths start at {first}.

- Explore first: list_dir, search_files and read_file before changing anything.
  Every step costs an API request, so read several files in the same step.
- For multi-step changes, plan with write_todos and keep it updated.
- Make small, focused edits with edit_file; match the existing code style.
- After changing code, run the relevant tests or checks with run_command.
  Run commands directly; never write wrapper scripts just to execute something.
- Writes and commands may need the user's approval. If the user rejects one,
  do not retry it; explain what you wanted to do instead.
- Reply in at most 300 words: what you changed (file paths), what you ran and
  the result, and anything left to do.
""".strip()

DESCRIPTION = (
    "Coding help in the workspace: understand a codebase, fix bugs, write or change "
    "code, and run tests, scripts or any other shell command. Use this (not "
    "ask_files) whenever something has to be executed. Edits and commands ask the "
    "user for approval."
)


def coder_spec(settings: Settings) -> SubagentSpec:
    roots = settings.workspace_dirs
    roots[0].mkdir(parents=True, exist_ok=True)
    return SubagentSpec(
        name="ask_coder",
        description=DESCRIPTION,
        system_prompt=CODER_PROMPT.format(
            roots="\n".join(f"- {r}" for r in roots), first=roots[0]
        ),
        tools=[*make_fs_tools(roots), make_run_command(roots)],
        interrupt_on=needs_approval([*WRITE_TOOLS, "run_command"], settings.auto_approve),
        middleware=[TodoListMiddleware()],
        max_model_calls=10,
        timeout_seconds=600,
    )


__all__ = ["coder_spec"]
