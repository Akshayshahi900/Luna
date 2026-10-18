"""
Built-in tools — normal Python functions Luna can call without MCP.

BEGINNER MAP
------------
A "tool" is just a function the language model is allowed to use.

The @tool decorator (from LangChain) does two important things:
  1. Reads the function name, arguments, and docstring.
  2. Turns that into a schema the model can understand
     ("there is a tool called calculator that takes an expression string").

The docstring matters! The model uses it to decide WHEN to call the tool.

To add your own tool:
  1. Write a function with @tool above it.
  2. Add it to the list in get_builtin_tools() at the bottom.
  3. Restart `uv run luna` and check with /tools.
"""

from __future__ import annotations

import ast
import operator
from datetime import datetime
from zoneinfo import ZoneInfo

from langchain.tools import tool

from luna.tools.builtin.ask_user import ask_user

# Limits so a request like 9**9**9**9 can't freeze the process.
_MAX_EXPONENT = 1000
_MAX_INT_DIGITS = 1000


def _safe_pow(base: float | int, exponent: float | int) -> float | int:
    """Like ``base ** exponent`` but refuses huge exponents."""
    if abs(exponent) > _MAX_EXPONENT:
        raise ValueError(f"Exponent too large (max {_MAX_EXPONENT})")
    return operator.pow(base, exponent)


def _check_size(value: float | int) -> float | int:
    """Reject integers so big they would be slow to compute or print."""
    if isinstance(value, int) and value.bit_length() > _MAX_INT_DIGITS * 4:
        raise ValueError("Result too large")
    return value


# Maps AST operator node types → real Python math functions.
# Used by the safe calculator so we never call eval() on raw user text.
_BIN_OPS = {
    ast.Add: operator.add,
    ast.Sub: operator.sub,
    ast.Mult: operator.mul,
    ast.Div: operator.truediv,
    ast.FloorDiv: operator.floordiv,
    ast.Mod: operator.mod,
    ast.Pow: _safe_pow,
}
_UNARY_OPS = {
    ast.UAdd: operator.pos,
    ast.USub: operator.neg,
}


def _safe_eval(node: ast.AST) -> float | int:
    """Evaluate a parsed math AST. Only numbers and + - * / ** etc. allowed.

    Why not eval(expression)? Because eval can run arbitrary Python
    (files, network, ...). Walking the AST lets us allow only math.
    """
    if isinstance(node, ast.Expression):
        return _safe_eval(node.body)
    if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
        return node.value
    if isinstance(node, ast.BinOp) and type(node.op) in _BIN_OPS:
        return _check_size(
            _BIN_OPS[type(node.op)](_safe_eval(node.left), _safe_eval(node.right))
        )
    if isinstance(node, ast.UnaryOp) and type(node.op) in _UNARY_OPS:
        return _check_size(_UNARY_OPS[type(node.op)](_safe_eval(node.operand)))
    raise ValueError("Only basic arithmetic is allowed")


@tool
def get_current_time(timezone_name: str = "UTC") -> str:
    """Return the current date and time for a given IANA timezone.

    Args:
        timezone_name: IANA timezone string such as 'UTC', 'Asia/Kolkata',
            or 'America/New_York'. Defaults to UTC.
    """
    try:
        tz = ZoneInfo(timezone_name)
    except Exception:
        return (
            f"Unknown timezone '{timezone_name}'. "
            "Use an IANA name like 'Asia/Kolkata'."
        )
    now = datetime.now(tz)
    return now.strftime("%Y-%m-%d %H:%M:%S %Z (UTC%z)")


@tool
def calculator(expression: str) -> str:
    """Evaluate a simple arithmetic expression.

    Supports +, -, *, /, //, %, **, and parentheses. No variables or function calls.

    Args:
        expression: Math expression, e.g. '(3 + 5) * 12'.
    """
    try:
        # Parse text → tree of math nodes, then evaluate safely.
        tree = ast.parse(expression, mode="eval")
        result = _safe_eval(tree)
    except Exception as exc:  # noqa: BLE001 — return error text to the model
        return f"Could not evaluate expression: {exc}"
    return str(result)


def get_builtin_tools() -> list:
    """Return the tools that ship with Luna (add new ones to this list)."""
    return [get_current_time, calculator, ask_user]
