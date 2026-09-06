"""Tests for live model discovery (modeling/llm_models.py) — the API call is
injected, so nothing here touches the network."""

from unittest import mock

from django.test import SimpleTestCase

from modeling import llm_models
from modeling.llm_models import default_model, list_models, price_for, select


def _m(mid, name, date, adaptive=True):
    return {"id": mid, "display_name": name, "created_at": date,
            "capabilities": {"thinking": {"types": {"adaptive": {"supported": adaptive}}}}}


LIVE = [
    _m("claude-fable-5-1", "Claude Fable 5.1", "2026-08-28"),
    _m("claude-opus-5", "Claude Opus 5", "2026-07-24"),
    _m("claude-sonnet-5", "Claude Sonnet 5", "2026-06-29"),
    _m("claude-opus-4-8", "Claude Opus 4.8", "2026-05-28"),
    _m("claude-haiku-4-5-20251001", "Claude Haiku 4.5", "2025-10-15", adaptive=False),
    _m("claude-opus-4-5-20251101", "Claude Opus 4.5", "2025-11-24", adaptive=False),
]


class SelectTests(SimpleTestCase):
    def test_keeps_current_generation_only_strongest_tier_first_newest_first(self):
        ids = [m["id"] for m in select(LIVE)]
        self.assertEqual(ids, ["claude-fable-5-1", "claude-opus-5", "claude-opus-4-8", "claude-sonnet-5"])

    def test_dated_ids_are_dropped_even_if_capabilities_missing(self):
        raw = [{"id": "claude-opus-4-5-20251101", "display_name": "Claude Opus 4.5", "created_at": "2025-11-24"},
               {"id": "claude-opus-5", "display_name": "Claude Opus 5", "created_at": "2026-07-24"}]
        self.assertEqual([m["id"] for m in select(raw)], ["claude-opus-5"])

    def test_models_without_adaptive_thinking_are_dropped(self):
        raw = [_m("claude-opus-9", "Claude Opus 9", "2027-01-01", adaptive=False)]
        self.assertEqual(select(raw), [])

    def test_only_newest_two_per_tier_are_offered(self):
        raw = [_m("claude-opus-5", "Claude Opus 5", "2026-07-24"),
               _m("claude-opus-4-8", "Claude Opus 4.8", "2026-05-28"),
               _m("claude-opus-4-7", "Claude Opus 4.7", "2026-04-14"),
               _m("claude-opus-4-6", "Claude Opus 4.6", "2026-02-04")]
        self.assertEqual([m["id"] for m in select(raw)], ["claude-opus-5", "claude-opus-4-8"])

    def test_entries_carry_label_and_price(self):
        m = select([_m("claude-opus-5", "Claude Opus 5", "2026-07-24")])[0]
        self.assertEqual(m["label"], "Opus 5")
        self.assertEqual((m["input_per_m"], m["output_per_m"]), (5.0, 25.0))

    def test_default_is_newest_opus(self):
        self.assertEqual(default_model(select(LIVE)), "claude-opus-5")

    def test_unknown_family_priced_at_top_tier(self):
        self.assertEqual(price_for("claude-zeta-7"), price_for("claude-fable-5-1"))


class CacheTests(SimpleTestCase):
    def setUp(self):
        llm_models._cache.update(at=0.0, value=None)

    def test_live_result_is_cached(self):
        calls = []
        def fetch():
            calls.append(1); return LIVE
        a = list_models(fetch=fetch); b = list_models(fetch=fetch)
        self.assertEqual(a["source"], "live")
        self.assertIs(a, b)
        self.assertEqual(len(calls), 1)

    def test_failure_falls_back_to_static_snapshot(self):
        def fetch():
            raise RuntimeError("offline")
        r = list_models(fetch=fetch)
        self.assertEqual(r["source"], "static")
        self.assertTrue(r["models"])
        self.assertTrue(r["default"].startswith("claude-opus-"))

    def test_failure_after_success_serves_previous_value(self):
        good = list_models(fetch=lambda: LIVE)
        with mock.patch.object(llm_models, "CACHE_TTL", 0):
            def fetch():
                raise RuntimeError("offline")
            self.assertIs(list_models(fetch=fetch), good)
