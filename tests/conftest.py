"""Shared test helpers: a fake chat model so tests never call OpenRouter."""

from __future__ import annotations

import itertools
import json
from typing import Any

import pytest
from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
from langchain_core.messages import AIMessage, AIMessageChunk
from langchain_core.outputs import ChatGeneration, ChatGenerationChunk, ChatResult
from pydantic import Field


class FakeToolModel(GenericFakeChatModel):
    """GenericFakeChatModel that accepts bind_tools (needed by create_agent).

    Each call records ``received`` (message count), ``system_prompts``
    (system prompt text) and ``inputs`` (every message's text), so tests can
    check what context the model saw.
    """

    received: list[int] = Field(default_factory=list)
    system_prompts: list[str] = Field(default_factory=list)
    inputs: list[list[str]] = Field(default_factory=list)

    def bind_tools(self, tools: Any, **kwargs: Any) -> "FakeToolModel":
        return self

    def _next(self, messages: list[Any]) -> AIMessage:
        self.received.append(len(messages))
        self.inputs.append([m.text for m in messages])
        first = messages[0] if messages else None
        self.system_prompts.append(first.text if first is not None and first.type == "system" else "")
        return next(self.messages)

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        return ChatResult(generations=[ChatGeneration(message=self._next(messages))])

    def _stream(self, messages, stop=None, run_manager=None, **kwargs):
        # Emit each canned reply as a single chunk (tool calls included).
        message = self._next(messages)
        chunk = AIMessageChunk(
            content=message.content,
            tool_call_chunks=[
                {"name": c["name"], "args": json.dumps(c["args"]), "id": c["id"], "index": i}
                for i, c in enumerate(message.tool_calls)
            ],
        )
        if run_manager and message.content:
            run_manager.on_llm_new_token(message.content, chunk=ChatGenerationChunk(message=chunk))
        yield ChatGenerationChunk(message=chunk)


def fake_model(*replies: AIMessage | str) -> FakeToolModel:
    messages = [r if isinstance(r, AIMessage) else AIMessage(content=r) for r in replies]
    return FakeToolModel(messages=iter(messages))


def tool_call(name: str, call_id: str = "c1", **args: Any) -> AIMessage:
    """An AI message that asks to run one tool."""
    return AIMessage(content="", tool_calls=[{"name": name, "args": args, "id": call_id}])


@pytest.fixture
def make_fake_model():
    return fake_model


@pytest.fixture
def make_looping_model():
    """A model that calls the same tool forever — for testing loop limits."""

    def make(name: str = "calculator", **args: Any) -> FakeToolModel:
        if name == "calculator" and not args:
            args = {"expression": "2+2"}
        # A new message (and call id) each time: reusing one object would make
        # LangGraph treat every repeat as an update of the same message.
        replies = (tool_call(name, f"c{i}", **args) for i in itertools.count())
        return FakeToolModel(messages=replies)

    return make


@pytest.fixture(autouse=True)
def _no_real_google(tmp_path, monkeypatch):
    """Never use a real Google sign-in in tests (Gmail, Calendar, Tasks sync).

    Tests that need Google replace luna.integrations.google.service with fakes.
    """
    monkeypatch.setenv("LUNA_GOOGLE_TOKEN_PATH", str(tmp_path / "no-google-token.json"))


class FakeRequest:
    """A googleapiclient request: nothing happens until execute()."""

    def __init__(self, run):
        self._run = run

    def execute(self):
        return self._run()


def missing(kind: str, key: str):
    """What a fake Google API does for an unknown id."""
    raise ValueError(f"Google API error 404: no {kind} {key}")
