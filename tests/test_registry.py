from langchain.tools import tool

from luna.tools.registry import ToolRegistry


def _make(name: str, reply: str):
    @tool(name)
    def _t() -> str:
        """Test tool."""
        return reply

    return _t


def test_register_and_list():
    registry = ToolRegistry()
    registry.register_many([_make("b", "1"), _make("a", "2")])
    assert registry.names() == ["a", "b"]
    assert len(registry.list_tools()) == 2


def test_last_writer_wins():
    registry = ToolRegistry()
    registry.register(_make("dup", "old"))
    registry.register(_make("dup", "new"))
    (only,) = registry.list_tools()
    assert only.invoke({}) == "new"


def test_clear():
    registry = ToolRegistry()
    registry.register(_make("x", "1"))
    registry.clear()
    assert registry.names() == [] and registry.list_tools() == []
