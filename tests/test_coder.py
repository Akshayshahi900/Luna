import dataclasses
import time

from langchain.agents import create_agent
from langgraph.checkpoint.memory import InMemorySaver

from conftest import tool_call
from luna.agent.subagents import make_delegate_tool
from luna.agent.subagents.coder import coder_spec
from luna.cli.chat import run_turn
from luna.config import Settings
from luna.tools.shell import make_run_command


def _settings(tmp_path, **overrides):
    return Settings(openrouter_api_key="test", workspace_dirs=[tmp_path], **overrides)


async def test_run_command_reports_exit_code_and_output(tmp_path):
    run = make_run_command([tmp_path])
    out = await run.ainvoke({"command": "echo hello && exit 3"})
    assert "(exit code 3)" in out and "hello" in out


async def test_run_command_runs_in_the_workspace(tmp_path):
    (tmp_path / "sub").mkdir()
    out = await make_run_command([tmp_path]).ainvoke({"command": "pwd", "cwd": "sub"})
    assert str(tmp_path / "sub") in out


async def test_run_command_refuses_cwd_outside(tmp_path):
    out = await make_run_command([tmp_path]).ainvoke({"command": "ls", "cwd": "/"})
    assert out.startswith("Error:")


async def test_run_command_timeout_kills_the_process(tmp_path):
    start = time.perf_counter()
    out = await make_run_command([tmp_path]).ainvoke(
        {"command": "sleep 30 & sleep 30", "timeout_seconds": 1}
    )
    assert "Timed out after 1s" in out
    assert time.perf_counter() - start < 5


async def test_run_command_trims_long_output(tmp_path):
    out = await make_run_command([tmp_path]).ainvoke(
        {"command": "python3 -c \"print('A'*3000 + 'B'*10000 + 'END')\""}
    )
    assert "characters omitted" in out and out.rstrip().endswith("END")
    assert len(out) < 9000


def test_coder_asks_before_writes_and_commands(tmp_path):
    spec = coder_spec(_settings(tmp_path))
    assert spec.interrupt_on == {"write_file": True, "edit_file": True, "run_command": True}
    assert "write_todos" in {t.name for m in spec.middleware for t in m.tools}


async def test_command_runs_only_after_approval(tmp_path, make_fake_model):
    settings = _settings(tmp_path)
    helper = make_fake_model(
        tool_call("run_command", "r1", command="touch ran.txt"), "Ran it."
    )
    spec = dataclasses.replace(coder_spec(settings), model=helper)
    main = make_fake_model(tool_call("ask_coder", task="touch a file"), "Done.")
    agent = create_agent(model=main, tools=[make_delegate_tool(spec, None)],
                         checkpointer=InMemorySaver())

    asked = []

    def ask(prompt=""):
        asked.append(prompt)
        assert not (tmp_path / "ran.txt").exists()  # nothing ran before the answer
        return "a"

    await run_turn(agent, "go", "t", settings, ask=ask)

    assert asked and (tmp_path / "ran.txt").exists()
