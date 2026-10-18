"""
Translate agent events and pauses into JSON for the browser.

BEGINNER MAP
------------
run_task() calls ``on_event(namespace, mode, payload)`` for every streamed
event (see cli/chat.py `_Printer` for the terminal version). The browser
can't read LangChain message objects, so EventTranslator turns each event
into zero or more plain dicts:

  {"type": "token",       "text": "..."}                        main agent's reply text
  {"type": "tool_call",   "name": ..., "args": {...}, "depth": n}
  {"type": "tool_result", "name": ..., "preview": "...", "depth": n}
  {"type": "notice",      "text": "...", "depth": n}            e.g. limit reached

depth 0 = the main agent, 1 = a helper (subagent) running inside ask_*.

Pauses work the other way round: describe_pause() turns an Interrupt into
something the UI can show, and build_answer() turns the browser's reply
back into the exact format the paused tool expects (same formats as
cli/chat.py `answer_interrupt`).
"""

from __future__ import annotations

from typing import Any

from langgraph.types import Interrupt

# Tool results can be long; the UI only shows a glimpse.
TOOL_RESULT_PREVIEW = 240


def _short(text: str, limit: int = TOOL_RESULT_PREVIEW) -> str:
    text = " ".join(text.split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


class EventTranslator:
    """Callable that maps one run_task event to a list of JSON-ready dicts."""

    def __call__(self, namespace: tuple[str, ...], mode: str, payload: Any) -> list[dict]:
        if mode == "messages":
            chunk, metadata = payload
            # Same rule as the CLI: only the main agent's model text is the reply.
            if namespace or metadata.get("langgraph_node") != "model":
                return []
            text = chunk.text
            return [{"type": "token", "text": text}] if text else []

        events: list[dict] = []
        depth = len(namespace)
        for node, update in (payload or {}).items():
            if node == "__interrupt__":
                continue  # sent as a "pause" after the run, see server.py
            for message in (update or {}).get("messages", []) if isinstance(update, dict) else []:
                if message.type == "ai" and message.tool_calls:
                    for call in message.tool_calls:
                        events.append({
                            "type": "tool_call",
                            "id": call.get("id"),
                            "name": call["name"],
                            "args": call.get("args", {}),
                            "depth": depth,
                        })
                elif message.type == "tool":
                    events.append({
                        "type": "tool_result",
                        "id": getattr(message, "tool_call_id", None),
                        "name": getattr(message, "name", None),
                        "preview": _short(str(message.content)),
                        "depth": depth,
                    })
                elif message.type == "ai" and node != "model" and message.text:
                    # Written by middleware, e.g. "Model call limits exceeded".
                    events.append({"type": "notice", "text": message.text, "depth": depth})
        return events


def describe_pause(interrupt: Interrupt) -> dict:
    """What the UI needs to show one pause.

    kind "question" → ask_user; "approval" → HumanInTheLoopMiddleware
    (one entry per tool call waiting for a decision); "other" → anything else.
    """
    value = interrupt.value
    if isinstance(value, dict) and value.get("type") == "ask_user":
        return {"id": interrupt.id, "kind": "question", "question": value.get("question", "")}
    if isinstance(value, dict) and "action_requests" in value:
        configs = {c["action_name"]: c for c in value.get("review_configs", [])}
        return {
            "id": interrupt.id,
            "kind": "approval",
            "actions": [
                {
                    "name": action["name"],
                    "args": action.get("args", {}),
                    "description": action.get("description"),
                    "allowed": configs.get(action["name"], {}).get(
                        "allowed_decisions", ["approve", "edit", "reject"]
                    ),
                }
                for action in value["action_requests"]
            ],
        }
    return {"id": interrupt.id, "kind": "other", "text": str(value)}


def _decision(action: dict, reply: Any) -> dict:
    """One browser decision → one HumanInTheLoopMiddleware decision."""
    reply = reply if isinstance(reply, dict) else {"type": str(reply)}
    kind = reply.get("type")
    if kind not in action["allowed"]:
        raise ValueError(f"'{kind}' is not allowed for {action['name']}")
    if kind == "approve":
        return {"type": "approve"}
    if kind == "reject":
        message = str(reply.get("message") or "").strip()
        return {"type": "reject", "message": message} if message else {"type": "reject"}
    args = reply.get("args")
    if not isinstance(args, dict):
        raise ValueError("an edit needs 'args' as an object")
    return {"type": "edit", "edited_action": {"name": action["name"], "args": args}}


def build_answer(pause: dict, reply: Any) -> Any:
    """Turn the browser's reply to ``pause`` into the paused tool's resume value.

    Browser formats:
      question → {"answer": "text"} (or a bare string)
      approval → {"decisions": [{"type": "approve"} | {"type": "reject", "message"?}
                                | {"type": "edit", "args": {...}}, ...]}
                 one per action, in order; a single decision applies to all
    Raises ValueError for a reply that doesn't fit the pause.
    """
    if pause["kind"] == "approval":
        decisions = reply.get("decisions") if isinstance(reply, dict) else None
        if not isinstance(decisions, list) or not decisions:
            raise ValueError("an approval needs a 'decisions' list")
        actions = pause["actions"]
        if len(decisions) == 1 and len(actions) > 1:
            decisions = decisions * len(actions)
        if len(decisions) != len(actions):
            raise ValueError(f"expected {len(actions)} decisions, got {len(decisions)}")
        return {"decisions": [_decision(a, d) for a, d in zip(actions, decisions)]}
    answer = reply.get("answer", "") if isinstance(reply, dict) else reply
    return str(answer)


__all__ = ["EventTranslator", "build_answer", "describe_pause"]
