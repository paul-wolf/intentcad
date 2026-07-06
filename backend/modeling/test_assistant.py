"""Tests for the AI edit loop (modeling/assistant.py).

The Anthropic call is injected; the returned script is validated by really
building it (build123d), so these cover the prompt/validate/retry logic without
network — but do exercise the engine.
"""

from django.test import SimpleTestCase

from modeling.assistant import AssistantError, edit_script


def _fake(*outs):
    it = iter(outs)
    return lambda system, user, tools: next(it)


class EditTests(SimpleTestCase):
    def test_returns_validated_script(self):
        r = edit_script("part = Box(10,10,10)", "make it a cylinder",
                        llm=_fake({"code": "part = Cylinder(5, 10)", "note": "Made it a cylinder."}))
        self.assertIn("Cylinder", r["code"])
        self.assertEqual(r["note"], "Made it a cylinder.")

    def test_passes_selection_context_in_prompt(self):
        seen = {}
        def llm(system, user, tools):
            seen["user"] = user
            return {"code": "part = Box(1,1,1)", "note": "ok"}
        edit_script("part = Box(2,2,2)", "chamfer it", context="the top face", llm=llm)
        self.assertIn("SELECTION: the top face", seen["user"])

    def test_bad_script_retries_then_succeeds(self):
        r = edit_script("part = Box(10,10,10)", "add a hole", llm=_fake(
            {"code": "part = Box(10,10,10) - Cylinder(2, 20", "note": "hole"},  # syntax error
            {"code": "part = Box(10,10,10) - Cylinder(2, 20)", "note": "Added a hole."},
        ))
        self.assertIn("- Cylinder(2, 20)", r["code"])

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
