"""Model providers: one ChatOpenAI client, three OpenAI-compatible APIs."""

import httpx
import pytest

from luna.agent import providers
from luna.agent.providers import describe_providers, list_models, make_model
from luna.config import Settings


def _settings(**overrides):
    return Settings(_env_file=None, openrouter_api_key="or-key", **overrides)


def test_make_model_per_provider():
    s = _settings(groq_api_key="gq-key", ollama_base_url="http://box:11434/v1/")
    openrouter = make_model(s)
    assert openrouter.openai_api_base == "https://openrouter.ai/api/v1"
    assert openrouter.model_name == s.model_name

    groq = make_model(s, "groq")
    assert groq.openai_api_base == "https://api.groq.com/openai/v1"
    assert groq.model_name == s.groq_model
    assert groq.openai_api_key.get_secret_value() == "gq-key"

    ollama = make_model(s, "ollama", "llama3.2")
    assert ollama.openai_api_base == "http://box:11434/v1"
    assert ollama.model_name == "llama3.2"


def test_startup_provider_comes_from_settings():
    s = _settings(provider="OLLAMA")
    assert s.provider == "ollama"
    assert make_model(s).model_name == s.ollama_model


def test_missing_key_and_unknown_provider():
    with pytest.raises(ValueError, match="LUNA_GROQ_API_KEY"):
        make_model(_settings(), "groq")
    with pytest.raises(ValueError, match="Unknown provider"):
        make_model(_settings(), "acme")
    with pytest.raises(ValueError):
        Settings(_env_file=None, provider="acme")


def test_describe_providers_marks_configured():
    info = {p["id"]: p for p in describe_providers(_settings())}
    assert info["openrouter"]["configured"] is True
    assert info["groq"]["configured"] is False
    assert info["ollama"]["configured"] is True  # local, no key
    assert info["groq"]["default_model"] == "llama-3.3-70b-versatile"


async def test_list_models_reads_the_models_endpoint(monkeypatch):
    seen = {}

    def handler(request):
        seen["url"] = str(request.url)
        seen["auth"] = request.headers["authorization"]
        return httpx.Response(200, json={"data": [{"id": "b"}, {"id": "a"}, {}]})

    real_client = httpx.AsyncClient
    monkeypatch.setattr(
        providers.httpx, "AsyncClient",
        lambda **kw: real_client(transport=httpx.MockTransport(handler), **kw),
    )
    assert await list_models(_settings(groq_api_key="gq"), "groq") == ["a", "b"]
    assert seen == {"url": "https://api.groq.com/openai/v1/models", "auth": "Bearer gq"}
