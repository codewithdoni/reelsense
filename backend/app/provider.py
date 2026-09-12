"""Model provider wiring.

The Agents SDK talks to OpenAI by default, but it is really an OpenAI-protocol
client, and both Gemini and OpenRouter expose that protocol. So the same four
agents run unchanged against whichever provider the builder actually has
credits for — which at a hackathon is rarely the default one.

Set LLM_PROVIDER explicitly, or leave it blank and the first configured key
wins.
"""

from __future__ import annotations

import logging
import os

from agents import (
    OpenAIChatCompletionsModel,
    set_default_openai_api,
    set_default_openai_client,
    set_tracing_disabled,
)
from openai import AsyncOpenAI

log = logging.getLogger("reelsense.provider")

PROVIDERS = {
    "openai": {
        "key_env": "OPENAI_API_KEY",
        "base_url": None,  # the SDK's own default
        "default_model": "gpt-5.6-terra",
        "fallbacks": ["gpt-5.6-luna", "gpt-4o"],
        "native": True,  # supports the Responses API
    },
    "gemini": {
        "key_env": "GEMINI_API_KEY",
        "base_url": "https://generativelanguage.googleapis.com/v1beta/openai/",
        # Google retires model ids quickly — gemini-2.5-flash is already closed to
        # new keys. The -latest alias is the safety net when a pinned id lapses.
        "default_model": "gemini-3.6-flash",
        "fallbacks": ["gemini-flash-latest", "gemini-3.5-flash"],
        "native": False,
    },
    "openrouter": {
        "key_env": "OPENROUTER_API_KEY",
        "base_url": "https://openrouter.ai/api/v1",
        "default_model": "openai/gpt-5.6-luna",
        "fallbacks": ["google/gemini-3.5-flash-lite", "openai/gpt-4o-mini"],
        "native": False,
    },
}

_PLACEHOLDER_HINTS = ("...", "your", "sk-xxx", "changeme")


def _real(value: str | None) -> bool:
    """A key copied from .env.example fails at call time instead of at startup."""
    v = (value or "").strip()
    return len(v) > 20 and not any(h in v.lower() for h in _PLACEHOLDER_HINTS)


def _detect() -> str | None:
    explicit = (os.getenv("LLM_PROVIDER") or "").strip().lower()
    if explicit in PROVIDERS:
        if _real(os.getenv(PROVIDERS[explicit]["key_env"])):
            return explicit
        log.warning("LLM_PROVIDER=%s but %s is not set", explicit, PROVIDERS[explicit]["key_env"])
    for name, cfg in PROVIDERS.items():
        if _real(os.getenv(cfg["key_env"])):
            return name
    return None


ACTIVE: str | None = None
MODEL: str = ""
FALLBACKS: list[str] = []
_client: AsyncOpenAI | None = None


def configure() -> None:
    """Point the Agents SDK at whichever provider has a usable key."""
    global ACTIVE, MODEL, FALLBACKS, _client

    ACTIVE = _detect()
    if not ACTIVE:
        log.error(
            "No model key configured. Set one of: %s",
            ", ".join(c["key_env"] for c in PROVIDERS.values()),
        )
        MODEL = PROVIDERS["openai"]["default_model"]
        return

    cfg = PROVIDERS[ACTIVE]
    MODEL = os.getenv("REELSENSE_MODEL") or cfg["default_model"]
    FALLBACKS = [
        m.strip()
        for m in (os.getenv("REELSENSE_FALLBACK_MODELS") or ",".join(cfg["fallbacks"])).split(",")
        if m.strip() and m.strip() != MODEL
    ]

    if not cfg["native"]:
        # Third-party endpoints speak Chat Completions, not the Responses API,
        # and tracing would try to upload to OpenAI with a key we do not have.
        _client = AsyncOpenAI(api_key=os.getenv(cfg["key_env"]), base_url=cfg["base_url"])
        set_default_openai_client(_client, use_for_tracing=False)
        set_default_openai_api("chat_completions")
        set_tracing_disabled(True)

    log.info("LLM provider: %s · model=%s · fallbacks=%s", ACTIVE, MODEL, FALLBACKS or "none")


def model_for(name: str):
    """Agents take either a model id or a Model object; third-party providers need
    the explicit client attached."""
    if _client is not None:
        return OpenAIChatCompletionsModel(model=name, openai_client=_client)
    return name


def configured() -> bool:
    return ACTIVE is not None


def status() -> dict:
    return {"provider": ACTIVE, "model": MODEL, "fallbacks": FALLBACKS}
