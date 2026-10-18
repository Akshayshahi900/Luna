import time

import pytest

from luna.tools.builtin import calculator, get_builtin_tools


@pytest.mark.parametrize(
    ("expression", "expected"),
    [("(3 + 5) * 12", "96"), ("2 ** 10", "1024"), ("7 // 2", "3"), ("-4 + 1", "-3"), ("2 ** -1", "0.5")],
)
def test_arithmetic(expression, expected):
    assert calculator.invoke({"expression": expression}) == expected


@pytest.mark.parametrize("expression", ["__import__('os')", "x + 1", "abs(-1)", "'a' * 3"])
def test_rejects_non_arithmetic(expression):
    assert calculator.invoke({"expression": expression}).startswith("Could not evaluate")


@pytest.mark.parametrize("expression", ["9**9**9**9", "10**999 * 10**999", "2**100000"])
def test_huge_numbers_fail_fast(expression):
    start = time.perf_counter()
    result = calculator.invoke({"expression": expression})
    assert result.startswith("Could not evaluate")
    assert time.perf_counter() - start < 1


def test_builtin_tool_names():
    assert {t.name for t in get_builtin_tools()} == {"get_current_time", "calculator", "ask_user"}
