"""Shared test helpers: a fake chat model so tests never call OpenRouter."""

from __future__ import annotations

import json
from typing import Any

import pytest
from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
from langchain_core.messages import AIMessage, AIMessageChunk
from langchain_core.outputs import ChatGenerationChunk


class FakeToolModel(GenericFakeChatModel):
    """GenericFakeChatModel that accepts bind_tools (needed by create_agent)."""

    def bind_tools(self, tools: Any, **kwargs: Any) -> "FakeToolModel":
        return self

    def _stream(self, messages, stop=None, run_manager=None, **kwargs):
        # Emit each canned reply as a single chunk (tool calls included).
        message = next(self.messages)
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


@pytest.fixture
def make_fake_model():
    return fake_model
