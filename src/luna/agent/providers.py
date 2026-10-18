"""
Model providers — where the "brain" runs.

BEGINNER MAP
------------
OpenRouter, Groq and Ollama all offer the same OpenAI-style API, so one
class (ChatOpenAI) talks to all of them; only the URL, key and model name
change. Settings pick the startup provider (LUNA_PROVIDER); the web UI can
switch at runtime by rebuilding the agent with make_model(...) (see
builder.assemble_agent and web/server.py AgentHost).

  openrouter  many hosted models, needs LUNA_OPENROUTER_API_KEY
  groq        very fast hosted models, needs LUNA_GROQ_API_KEY
  ollama      models on your own machine, no key (run `ollama serve`)
"""

from __future__ import annotations

from dataclasses import dataclass

import httpx
from langchain_openai import ChatOpenAI

from luna.config import Settings


@dataclass(frozen=True)
class Provider:
    """One OpenAI-compatible model host and where its settings live."""
    id: str
    label: str
    key_field: str | None  # Settings field holding the API key; None = no key needed
    model_field: str  # Settings field holding the default model
    env_key: str  # for error messages

    def base_url(self, settings: Settings) -> str:
        """The provider's OpenAI-compatible API URL."""
        if self.id == "ollama":
            return settings.ollama_base_url.rstrip("/")
        return _HOSTED_URLS[self.id]

    def api_key(self, settings: Settings) -> str | None:
        """The API key from settings (a dummy one for Ollama)."""
        if self.key_field is None:
            return "ollama"  # the OpenAI client insists on some key; Ollama ignores it
        return getattr(settings, self.key_field)

    def default_model(self, settings: Settings) -> str:
        """The model to use when none is chosen."""
        return getattr(settings, self.model_field)

    def configured(self, settings: Settings) -> bool:
        """True when the provider can be used (it has a key)."""
        return bool(self.api_key(settings))


_HOSTED_URLS = {
    "openrouter": "https://openrouter.ai/api/v1",
    "groq": "https://api.groq.com/openai/v1",
}

PROVIDERS: dict[str, Provider] = {
    p.id: p
    for p in (
        Provider("openrouter", "OpenRouter", "openrouter_api_key", "model_name", "LUNA_OPENROUTER_API_KEY"),
        Provider("groq", "Groq", "groq_api_key", "groq_model", "LUNA_GROQ_API_KEY"),
        Provider("ollama", "Ollama", None, "ollama_model", "LUNA_OLLAMA_BASE_URL"),
    )
}


def get_provider(provider_id: str) -> Provider:
    """The Provider for ``provider_id``; ValueError if unknown."""
    try:
        return PROVIDERS[provider_id]
    except KeyError:
        raise ValueError(f"Unknown provider '{provider_id}'. Use one of: {', '.join(PROVIDERS)}") from None


def make_model(settings: Settings, provider: str | None = None, model: str | None = None) -> ChatOpenAI:
    """Chat model for ``provider`` (default: settings.provider) and ``model``
    (default: that provider's model from settings).

    ``max_retries`` comes from settings (default 1, the OpenAI client's is 2):
    on a rate-limited free tier each retry is one more request against the limit."""
    p = get_provider(provider or settings.provider)
    if not p.configured(settings):
        raise ValueError(f"Set {p.env_key} in your .env file to use {p.label}.")
    return ChatOpenAI(
        model=model or p.default_model(settings),
        base_url=p.base_url(settings),
        api_key=p.api_key(settings),
        max_retries=settings.model_max_retries,
    )


def describe_providers(settings: Settings) -> list[dict]:
    """What the UI shows in its model switcher."""
    return [
        {
            "id": p.id,
            "label": p.label,
            "configured": p.configured(settings),
            "default_model": p.default_model(settings),
        }
        for p in PROVIDERS.values()
    ]


async def list_models(settings: Settings, provider: str, timeout: float = 6.0) -> list[str]:
    """Model ids the provider offers (GET /models). Raises on network/auth errors."""
    p = get_provider(provider)
    if not p.configured(settings):
        raise ValueError(f"Set {p.env_key} in your .env file to use {p.label}.")
    async with httpx.AsyncClient(timeout=timeout) as client:
        response = await client.get(
            f"{p.base_url(settings)}/models",
            headers={"Authorization": f"Bearer {p.api_key(settings)}"},
        )
        response.raise_for_status()
    return sorted(m["id"] for m in response.json().get("data", []) if m.get("id"))


__all__ = ["PROVIDERS", "Provider", "describe_providers", "get_provider", "list_models", "make_model"]
