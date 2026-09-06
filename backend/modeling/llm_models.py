"""Which Claude models the AI edit can use, discovered live.

The hard-coded model list went stale as soon as a new model shipped. Instead we
ask the Models API (GET /v1/models) and keep every current-generation model
that supports adaptive thinking (which is how assistant.py calls the API), newest
first. Pricing is not in the API, so it's a small table keyed by model family
that only needs touching when a family's price changes. The list is cached in
process for an hour and falls back to a static snapshot if the API is
unreachable, so the editor always has something to offer.
"""

from __future__ import annotations

import os
import re
import threading
import time
from typing import Callable

# USD per token (input, output) by model family — the API doesn't expose prices.
# Order matters: first matching prefix wins, so more specific entries go first.
_FAMILY_PRICING: list[tuple[str, tuple[float, float]]] = [
    ("claude-fable-",      (10.0 / 1e6, 50.0 / 1e6)),
    ("claude-mythos-",     (10.0 / 1e6, 50.0 / 1e6)),
    ("claude-opus-",       (5.0 / 1e6, 25.0 / 1e6)),
    ("claude-sonnet-4-6",  (3.0 / 1e6, 15.0 / 1e6)),
    ("claude-sonnet-",     (2.0 / 1e6, 10.0 / 1e6)),
    ("claude-haiku-",      (1.0 / 1e6, 5.0 / 1e6)),
]
# An unknown family is priced at the top tier so spend is never under-reported.
_UNKNOWN_PRICING = (10.0 / 1e6, 50.0 / 1e6)

# Snapshot used when the Models API can't be reached (no key, offline, error).
_STATIC: list[dict] = [
    {"id": "claude-fable-5-1", "display_name": "Claude Fable 5.1", "created_at": "2026-08-28"},
    {"id": "claude-opus-5", "display_name": "Claude Opus 5", "created_at": "2026-07-24"},
    {"id": "claude-sonnet-5", "display_name": "Claude Sonnet 5", "created_at": "2026-06-29"},
    {"id": "claude-fable-5", "display_name": "Claude Fable 5", "created_at": "2026-06-07"},
    {"id": "claude-opus-4-8", "display_name": "Claude Opus 4.8", "created_at": "2026-05-28"},
]

CACHE_TTL = float(os.environ.get("LLM_MODELS_TTL", "3600"))
PER_TIER = int(os.environ.get("LLM_MODELS_PER_TIER", "2"))   # newest N of each tier

_TIER_ORDER = {"fable": 0, "mythos": 0, "opus": 1, "sonnet": 2, "haiku": 3}
_TIER_NOTE = {
    "fable": "strongest — for hard edits; ~2× the cost and slower",
    "mythos": "strongest — for hard edits; ~2× the cost and slower",
    "opus": "capable and fast — the everyday choice",
    "sonnet": "cheaper and quicker — fine for small, well-specified edits",
    "haiku": "cheapest — simple tweaks only",
}


def price_for(model_id: str) -> tuple[float, float]:
    for prefix, p in _FAMILY_PRICING:
        if model_id.startswith(prefix):
            return p
    return _UNKNOWN_PRICING


def _family(model_id: str) -> str:
    m = re.match(r"claude-([a-z]+)-", model_id)
    return m.group(1) if m else ""


def _short_label(display_name: str) -> str:
    return display_name.removeprefix("Claude ").strip()


def _fetch_live() -> list[dict]:
    """Every model the API offers, as plain dicts (id, display_name, created_at,
    capabilities). Raises on any failure — the caller falls back."""
    import anthropic
    key = os.environ.get("ANTHROPIC_KEY") or os.environ.get("ANTHROPIC_API_KEY")
    if not (key or os.environ.get("ANTHROPIC_AUTH_TOKEN")):
        raise RuntimeError("no Anthropic credentials")
    client = anthropic.Anthropic(api_key=key, timeout=15.0, max_retries=1) if key \
        else anthropic.Anthropic(timeout=15.0, max_retries=1)
    out = []
    for m in client.models.list():
        d = m.to_dict()
        d["created_at"] = str(d.get("created_at", ""))[:10]
        out.append(d)
    return out


def _adaptive_thinking(d: dict) -> bool | None:
    """True/False from the capability tree; None if the payload doesn't carry it."""
    try:
        return bool(d["capabilities"]["thinking"]["types"]["adaptive"]["supported"])
    except (KeyError, TypeError):
        return None


def select(raw: list[dict]) -> list[dict]:
    """The models worth offering, newest first.

    Keep current-generation aliases only: ids without a date suffix (dated ids
    are older models that need the removed `budget_tokens` thinking style), and
    — when the payload says — only models that support adaptive thinking, since
    that's what the edit call sends. Only the newest PER_TIER of each tier are
    offered (older ones add menu length, not capability). Each entry carries
    its price per 1M tokens.
    """
    keep = []
    for d in raw:
        mid = d.get("id", "")
        if not mid.startswith("claude-") or re.search(r"-\d{8}$", mid):
            continue
        fam = _family(mid)
        if fam not in _TIER_ORDER:
            continue
        if _adaptive_thinking(d) is False:
            continue
        pin, pout = price_for(mid)
        keep.append({
            "id": mid,
            "label": _short_label(d.get("display_name") or mid),
            "tier": fam,
            "note": _TIER_NOTE.get(fam, ""),
            "released": d.get("created_at", ""),
            "input_per_m": round(pin * 1e6, 2),
            "output_per_m": round(pout * 1e6, 2),
        })
    # tiers strongest first; within a tier newest first; then trim each tier
    keep.sort(key=lambda m: (_TIER_ORDER[m["tier"]], -_stamp(m["released"])))
    seen: dict[str, int] = {}
    out = []
    for m in keep:
        seen[m["tier"]] = seen.get(m["tier"], 0) + 1
        if seen[m["tier"]] <= PER_TIER:
            out.append(m)
    return out


def _stamp(date: str) -> float:
    try:
        return time.mktime(time.strptime(date[:10], "%Y-%m-%d"))
    except (ValueError, TypeError):
        return 0.0


def default_model(models: list[dict]) -> str:
    """The newest Opus (capable + fast), else the newest of anything."""
    opus = [m for m in models if m["tier"] == "opus"]
    pool = opus or models
    return max(pool, key=lambda m: _stamp(m["released"]))["id"] if pool else "claude-opus-5"


_lock = threading.Lock()
_cache: dict = {"at": 0.0, "value": None}


def list_models(*, fetch: Callable[[], list[dict]] | None = None, force: bool = False) -> dict:
    """{models: [...], default: id, source: 'live'|'static'} — cached for CACHE_TTL.

    `fetch` is injectable for tests. A failed fetch serves the previous good
    value if there is one, else the static snapshot (and retries next call).
    """
    fetch = fetch or _fetch_live
    with _lock:
        fresh = _cache["value"] is not None and time.time() - _cache["at"] < CACHE_TTL
        if fresh and not force:
            return _cache["value"]
        try:
            models = select(fetch())
            if not models:
                raise RuntimeError("Models API returned nothing usable")
            value = {"models": models, "default": default_model(models), "source": "live"}
            _cache.update(at=time.time(), value=value)
            return value
        except Exception:
            if _cache["value"] is not None:
                return _cache["value"]
            models = select(_STATIC)
            return {"models": models, "default": default_model(models), "source": "static"}


def is_known(model_id: str) -> bool:
    return any(m["id"] == model_id for m in list_models()["models"])
