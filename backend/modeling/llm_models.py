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
# (Anthropic pricing page, October 2026.)
_FAMILY_PRICING: list[tuple[str, tuple[float, float]]] = [
    ("claude-fable-",      (10.0 / 1e6, 50.0 / 1e6)),
    ("claude-mythos-",     (10.0 / 1e6, 50.0 / 1e6)),
    ("claude-opus-5-5",    (4.0 / 1e6, 20.0 / 1e6)),
    ("claude-opus-",       (5.0 / 1e6, 25.0 / 1e6)),
    ("claude-sonnet-4-",   (3.0 / 1e6, 15.0 / 1e6)),
    ("claude-sonnet-",     (2.0 / 1e6, 10.0 / 1e6)),
    ("claude-haiku-5-5",   (0.10 / 1e6, 0.50 / 1e6)),
    ("claude-haiku-",      (1.0 / 1e6, 5.0 / 1e6)),
]
# Long prompts cost more on some models: (prefix, prompt tokens, multiplier).
# The prompt counts every input token of the request, cached or not, and each
# request is priced on its own; the multiplier applies to all of its tokens.
_LONG_PROMPT: list[tuple[str, int, float]] = [
    ("claude-haiku-5-5", 100_000, 5.0),
]
# An unknown family is priced at the top tier so spend is never under-reported.
_UNKNOWN_PRICING = (10.0 / 1e6, 50.0 / 1e6)

# Snapshot used when the Models API can't be reached (no key, offline, error).
_STATIC: list[dict] = [
    {"id": "claude-haiku-5-5", "display_name": "Claude Haiku 5.5", "created_at": "2026-10-07"},
    {"id": "claude-sonnet-5-5", "display_name": "Claude Sonnet 5.5", "created_at": "2026-09-28"},
    {"id": "claude-opus-5-5", "display_name": "Claude Opus 5.5", "created_at": "2026-09-21"},
    {"id": "claude-fable-5-1", "display_name": "Claude Fable 5.1", "created_at": "2026-08-28"},
    {"id": "claude-opus-5", "display_name": "Claude Opus 5", "created_at": "2026-07-24"},
    {"id": "claude-sonnet-5", "display_name": "Claude Sonnet 5", "created_at": "2026-06-29"},
    {"id": "claude-fable-5", "display_name": "Claude Fable 5", "created_at": "2026-06-07"},
    {"id": "claude-opus-4-8", "display_name": "Claude Opus 4.8", "created_at": "2026-05-28"},
]

CACHE_TTL = float(os.environ.get("LLM_MODELS_TTL", "3600"))
# The API is asked at most once per RETRY_AFTER seconds — a refresh from the
# page, or a retry after a failed fetch — so an open editor can't hammer it.
RETRY_AFTER = 60.0
PER_TIER = int(os.environ.get("LLM_MODELS_PER_TIER", "2"))   # newest N of each tier

_TIER_ORDER = {"fable": 0, "mythos": 0, "opus": 1, "sonnet": 2, "haiku": 3}
_TIER_NOTE = {
    "fable": "strongest — for hard edits; ~2× the cost and slower",
    "mythos": "strongest — for hard edits; ~2× the cost and slower",
    "opus": "capable and fast — the everyday choice",
    "sonnet": "cheaper and quicker — fine for small, well-specified edits",
    "haiku": "cheapest — simple tweaks only",
}


# Prompt-cache prices as multiples of the input price (Anthropic pricing page,
# October 2026): a 5-minute cache write costs 1.25×, a cache read 0.1× — less on
# the newest models. Context files are cached, so these matter for a chat.
CACHE_WRITE_RATE = 1.25
_CACHE_READ_RATE: list[tuple[str, float]] = [
    ("claude-fable-5-1",  0.025),
    ("claude-mythos-5-1", 0.025),
    ("claude-opus-5-5",   0.05),
    ("claude-sonnet-5-5", 0.05),
]


def cache_read_rate(model_id: str) -> float:
    for prefix, r in _CACHE_READ_RATE:
        if model_id.startswith(prefix):
            return r
    return 0.1


def price_for(model_id: str) -> tuple[float, float]:
    for prefix, p in _FAMILY_PRICING:
        if model_id.startswith(prefix):
            return p
    return _UNKNOWN_PRICING


def call_cost(model_id: str, usage: dict) -> float:
    """USD for one API request, from its usage {input, output, cache_read,
    cache_write} (missing keys count as 0)."""
    i, o = usage.get("input", 0), usage.get("output", 0)
    cr, cw = usage.get("cache_read", 0), usage.get("cache_write", 0)
    pin, pout = price_for(model_id)
    for prefix, limit, mult in _LONG_PROMPT:
        if model_id.startswith(prefix) and i + cr + cw > limit:
            pin, pout = pin * mult, pout * mult
            break
    return i * pin + cw * pin * CACHE_WRITE_RATE + cr * pin * cache_read_rate(model_id) + o * pout


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
_cache: dict = {"at": 0.0, "tried": 0.0, "value": None}


def list_models(*, fetch: Callable[[], list[dict]] | None = None, force: bool = False) -> dict:
    """{models: [...], default: id, source: 'live'|'static'} — cached for CACHE_TTL.

    `force` (the picker's refresh) asks the API again even inside CACHE_TTL.
    Either way the API is asked at most once per RETRY_AFTER. `fetch` is
    injectable for tests. A failed fetch serves the previous good value if
    there is one, else the static snapshot, and is retried after RETRY_AFTER.
    """
    fetch = fetch or _fetch_live
    with _lock:
        now = time.time()
        value = _cache["value"]
        if value is not None:
            live_fresh = value["source"] == "live" and now - _cache["at"] < CACHE_TTL
            if (live_fresh and not force) or now - _cache["tried"] < RETRY_AFTER:
                return value
        _cache["tried"] = now
        try:
            models = select(fetch())
            if not models:
                raise RuntimeError("Models API returned nothing usable")
            value = {"models": models, "default": default_model(models), "source": "live"}
            _cache.update(at=now, value=value)
            return value
        except Exception:
            if value is not None and value["source"] == "live":
                return value
            models = select(_STATIC)
            value = {"models": models, "default": default_model(models), "source": "static"}
            _cache["value"] = value
            return value


def is_known(model_id: str) -> bool:
    return any(m["id"] == model_id for m in list_models()["models"])
