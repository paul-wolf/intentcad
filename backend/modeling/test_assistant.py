"""Tests for the AI edit loop (modeling/assistant.py).

The Anthropic call is injected; the returned script is validated by really
building it (build123d), so these cover the prompt/validate/retry logic without
network — but do exercise the engine.
"""

from django.test import SimpleTestCase

from modeling import llm_models
from modeling.assistant import AssistantError, edit_script


def _fake(*outs):
    it = iter(outs)
    return lambda system, user, tools: next(it)


class EditTests(SimpleTestCase):
    def setUp(self):
        # model discovery must not hit the network here — seed the cache
        llm_models._cache.update(at=9e12, value={
            "models": llm_models.select([
                {"id": "claude-opus-5", "display_name": "Claude Opus 5", "created_at": "2026-07-24"},
                {"id": "claude-fable-5-1", "display_name": "Claude Fable 5.1", "created_at": "2026-08-28"},
            ]), "default": "claude-opus-5", "source": "live"})

    def tearDown(self):
        llm_models._cache.update(at=0.0, value=None)

    def test_unknown_model_is_priced_as_the_default(self):
        r = edit_script("part = Box(1,1,1)", "bigger", model="claude-nope-1",
                        llm=_fake({"code": "part = Box(2,2,2)", "note": "ok", "usage": {"input": 1_000_000, "output": 0}}))
        self.assertEqual(r["cost_usd"], 5.0)   # Opus input price, not Fable's

    def test_known_model_is_priced_by_family(self):
        r = edit_script("part = Box(1,1,1)", "bigger", model="claude-fable-5-1",
                        llm=_fake({"code": "part = Box(2,2,2)", "note": "ok", "usage": {"input": 1_000_000, "output": 0}}))
        self.assertEqual(r["cost_usd"], 10.0)

    def test_returns_validated_script(self):
        r = edit_script("part = Box(10,10,10)", "make it a cylinder",
                        llm=_fake({"code": "part = Cylinder(5, 10)", "note": "Made it a cylinder."}))
        self.assertIn("Cylinder", r["code"])
        self.assertEqual(r["note"], "Made it a cylinder.")

    def test_production_process_reaches_system_prompt(self):
        seen = {}
        def llm(system, user, tools):
            seen["system"] = system
            return {"code": "part = Box(1,1,1)", "note": "ok"}
        edit_script("part = Box(2,2,2)", "add a hole for a 4mm rod",
                    production="FDM 3D print: add 0.4mm clearance to bores.", llm=llm)
        self.assertIn("MANUFACTURING CONTEXT", seen["system"])
        self.assertIn("0.4mm clearance to bores", seen["system"])

    def test_no_production_leaves_system_prompt_clean(self):
        seen = {}
        def llm(system, user, tools):
            seen["system"] = system
            return {"code": "part = Box(1,1,1)", "note": "ok"}
        edit_script("part = Box(2,2,2)", "add a hole", llm=llm)
        self.assertNotIn("MANUFACTURING CONTEXT", seen["system"])

    def test_passes_selection_context_in_prompt(self):
        seen = {}
        def llm(system, user, tools):
            seen["user"] = user
            return {"code": "part = Box(1,1,1)", "note": "ok"}
        edit_script("part = Box(2,2,2)", "chamfer it", context="the top face", llm=llm)
        self.assertIn("SELECTION: the top face", seen["user"])

    def test_build_error_is_threaded_into_the_prompt(self):
        seen = {}
        def llm(system, user, tools):
            seen["user"] = user; seen["system"] = system
            return {"code": "part = Box(10,10,10)", "note": "fixed"}
        edit_script("part = fillet(Box(10,10,10).edges(), radius=6)", "fix it",
                    build_error="line 1: ...\nValueError: Failed creating a fillet", llm=llm)
        self.assertIn("BUILD ERROR", seen["user"])
        self.assertIn("Failed creating a fillet", seen["user"])
        self.assertIn("BUILD ERROR", seen["system"])   # the system prompt explains what to do with it

    def test_no_build_error_leaves_prompt_clean(self):
        seen = {}
        def llm(system, user, tools):
            seen["user"] = user
            return {"code": "part = Box(10,10,10)", "note": "ok"}
        edit_script("part = Box(1,1,1)", "bigger", llm=llm)
        self.assertNotIn("BUILD ERROR", seen["user"])

    def test_bad_script_retries_then_succeeds(self):
        r = edit_script("part = Box(10,10,10)", "add a hole", llm=_fake(
            {"code": "part = Box(10,10,10) - Cylinder(2, 20", "note": "hole"},  # syntax error
            {"code": "part = Box(10,10,10) - Cylinder(2, 20)", "note": "Added a hole."},
        ))
        self.assertIn("- Cylinder(2, 20)", r["code"])

    def test_oversized_param_is_fixed_without_a_second_model_call(self):
        calls = []
        def llm(system, user, tools):
            calls.append(user)
            return {"code": "P = {'r': 6.0}\npart = Box(10, 10, 4)\n"
                            "part = fillet(part.edges().filter_by(Axis.Z), radius=P['r'])",
                    "note": "Rounded the corners."}
        r = edit_script("part = Box(10,10,4)", "round the vertical edges", llm=llm)
        self.assertEqual(len(calls), 1)               # no corrective round-trip
        self.assertNotIn("'r': 6.0", r["code"])
        self.assertIn("'r': 4.7", r["code"])          # measured max 5, with margin
        self.assertIn("r reduced to 4.7", r["note"])

    def test_retry_exhausted_raises(self):
        with self.assertRaises(AssistantError):
            edit_script("part = Box(1,1,1)", "x", llm=_fake(
                {"code": "part = nope(", "note": "a"},
                {"code": "part = also_bad(", "note": "b"},
            ))

    def test_empty_instruction_rejected(self):
        with self.assertRaises(AssistantError):
            edit_script("part = Box(1,1,1)", "  ", llm=_fake({"code": "x", "note": "y"}))

    def test_asks_clarification_instead_of_editing(self):
        r = edit_script("part = Box(1,1,1)", "make it better", llm=_fake(
            {"kind": "question", "question": "Better how — larger, or filleted edges?"}))
        self.assertEqual(r["kind"], "question")
        self.assertIn("Better how", r["question"])

    def test_history_is_threaded_into_the_prompt(self):
        seen = {}
        def llm(system, user, tools):
            seen["user"] = user
            return {"code": "part = Box(1,1,1)", "note": "ok"}
        edit_script("part = Box(2,2,2)", "make that bigger",
                    history=[{"role": "user", "text": "add a boss"},
                             {"role": "assistant", "text": "Added a boss."}], llm=llm)
        self.assertIn("RECENT CONVERSATION", seen["user"])
        self.assertIn("add a boss", seen["user"])
