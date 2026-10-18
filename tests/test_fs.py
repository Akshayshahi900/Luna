import os

import pytest

from luna.tools.fs import SandboxError, Workspace, make_fs_tools


@pytest.fixture
def tools(tmp_path):
    (tmp_path / "notes").mkdir()
    (tmp_path / "notes" / "todo.md").write_text("buy milk\ncall mum\nTODO: taxes\n")
    (tmp_path / "app.py").write_text("def main():\n    return 1\n")
    (tmp_path / ".git").mkdir()
    (tmp_path / ".git" / "config").write_text("TODO: ignored\n")
    return {t.name: t for t in make_fs_tools([tmp_path])}


def test_list_dir(tools):
    assert tools["list_dir"].invoke({}).splitlines() == [".git/", "notes/", "app.py"]
    assert tools["list_dir"].invoke({"path": "notes"}) == "todo.md"


def test_read_file_numbers_and_pages(tools):
    out = tools["read_file"].invoke({"path": "notes/todo.md", "max_lines": 2})
    assert "    1  buy milk" in out and "    2  call mum" in out
    assert "use start_line=3" in out
    assert "taxes" in tools["read_file"].invoke({"path": "notes/todo.md", "start_line": 3})


def test_search_skips_vcs_folders(tools):
    out = tools["search_files"].invoke({"pattern": "TODO"})
    assert out == "notes/todo.md:3: TODO: taxes"
    assert tools["search_files"].invoke({"pattern": "def", "glob": "*.md"}) == "No matches."
    assert tools["search_files"].invoke({"pattern": "("}).startswith("Error: invalid pattern")


def test_write_and_edit(tools, tmp_path):
    assert tools["write_file"].invoke({"path": "new/a.txt", "content": "one two"}).startswith("Created")
    assert tools["edit_file"].invoke({"path": "new/a.txt", "old_text": "two", "new_text": "2"}) == "Edited new/a.txt"
    assert (tmp_path / "new" / "a.txt").read_text() == "one 2"
    assert "not found" in tools["edit_file"].invoke({"path": "new/a.txt", "old_text": "zzz", "new_text": ""})
    tools["write_file"].invoke({"path": "dup.txt", "content": "x x"})
    assert "found 2 times" in tools["edit_file"].invoke({"path": "dup.txt", "old_text": "x", "new_text": "y"})


@pytest.mark.parametrize("path", ["../outside.txt", "/etc/passwd", "notes/../../x", "~/x"])
def test_paths_outside_workspace_are_refused(tools, path):
    for name, args in [
        ("read_file", {"path": path}),
        ("write_file", {"path": path, "content": "x"}),
        ("list_dir", {"path": path}),
    ]:
        assert tools[name].invoke(args).startswith("Error:")


def test_symlink_escape_is_refused(tmp_path):
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.txt").write_text("secret")
    root = tmp_path / "root"
    root.mkdir()
    os.symlink(outside, root / "link")
    tools = {t.name: t for t in make_fs_tools([root])}
    assert tools["read_file"].invoke({"path": "link/secret.txt"}).startswith("Error:")
    assert tools["search_files"].invoke({"pattern": "secret", "path": "."}) == "No matches."


def test_multiple_roots(tmp_path):
    a, b = tmp_path / "a", tmp_path / "b"
    a.mkdir(), b.mkdir()
    (b / "f.txt").write_text("in b")
    ws = Workspace([a, b])
    assert ws.resolve("x.txt") == a / "x.txt"  # relative → first root
    assert ws.resolve(str(b / "f.txt")) == b / "f.txt"  # absolute in another root is fine
    with pytest.raises(SandboxError):
        ws.resolve(str(tmp_path / "c.txt"))
