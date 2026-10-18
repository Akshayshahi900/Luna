import dataclasses

from langchain.agents import create_agent
from langgraph.checkpoint.memory import InMemorySaver

from conftest import tool_call
from luna.agent.subagents import make_delegate_tool
from luna.agent.subagents.files import files_spec
from luna.cli.chat import run_turn
from luna.config import Settings


def _settings(tmp_path, **overrides):
    return Settings(openrouter_api_key="test", workspace_dirs=[tmp_path], **overrides)


def test_writes_need_approval_by_default(tmp_path):
    spec = files_spec(_settings(tmp_path))
    assert spec.interrupt_on == {"write_file": True, "edit_file": True}
    assert str(tmp_path) in spec.system_prompt


def test_auto_approve_removes_the_prompt(tmp_path):
    spec = files_spec(_settings(tmp_path, auto_approve=["write_file"]))
    assert spec.interrupt_on == {"edit_file": True}


async def _save_notes(tmp_path, make_fake_model, answers):
    settings = _settings(tmp_path)
    helper = make_fake_model(
        tool_call("write_file", "w1", path="notes.md", content="# Notes"), "Saved notes.md"
    )
    spec = dataclasses.replace(files_spec(settings), model=helper)
    main = make_fake_model(tool_call("ask_files", task="save my notes"), "Done.")
    agent = create_agent(model=main, tools=[make_delegate_tool(spec, None)],
                         checkpointer=InMemorySaver())
    queue = list(answers)
    await run_turn(agent, "save notes", "t", settings, ask=lambda _="": queue.pop(0))


async def test_write_happens_only_after_approval(tmp_path, make_fake_model):
    await _save_notes(tmp_path, make_fake_model, ["a"])
    assert (tmp_path / "notes.md").read_text() == "# Notes"


async def test_rejected_write_leaves_disk_untouched(tmp_path, make_fake_model):
    await _save_notes(tmp_path, make_fake_model, ["r", ""])
    assert not (tmp_path / "notes.md").exists()
