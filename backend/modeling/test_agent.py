"""Tests for the chat agent (modeling/agent.py).

The LLM call is injected, so these exercise prompt-context assembly and the
op->feature normalization without any network or key. A fake llm stands in for
Claude.
"""

from django.test import SimpleTestCase

from modeling.agent import plan_operations
from modeling.resolver import ResolverError
from modeling.test_resolver import EDGES, FACES

SKETCHES = [
    {"id": "sk-plate", "name": "plate", "entityCount": 12},
    {"id": "sk-ring", "name": "ring", "entityCount": 2},
]
TREE = [{"type": "extrude", "sketchId": "sk-plate", "distance": 10, "operation": "add"}]


def _fake(tool, inp):
    return lambda system, user, tools: {"tool": tool, "input": inp}


def _seq(*calls):
    """A stateful fake llm returning each call in turn (for retry paths)."""
    it = iter(calls)
    return lambda system, user, tools: next(it)


class ChamferTests(SimpleTestCase):
    def test_chamfer_the_joint(self):
        r = plan_operations(
            "chamfer the joint 3mm", SKETCHES, TREE, FACES, EDGES,
            llm=_fake("add_features", {
                "reply": "Chamfered the socket/top junction 3mm.",
                "features": [{"type": "chamfer", "edges": "between:cylinder,top", "distance": 3}],
            }),
        )
        self.assertEqual(r["status"], "ok")
        op = r["operations"][0]
        self.assertEqual(op["type"], "chamfer")
        self.assertEqual(op["edges"], "between:cylinder,top")
        self.assertEqual(op["distance"], 3)
        self.assertEqual(op["sketchId"], "")
        self.assertTrue(op["id"].startswith("op-"))


class SketchResolutionTests(SimpleTestCase):
    def test_extrude_resolves_sketch_name_to_id(self):
        r = plan_operations(
            "extrude the ring 5mm", SKETCHES, TREE, FACES, EDGES,
            llm=_fake("add_features", {
                "reply": "Extruded ring 5mm.",
                "features": [{"type": "extrude", "sketch": "ring", "distance": 5}],
            }),
        )
        op = r["operations"][0]
        self.assertEqual(op["sketchId"], "sk-ring")
        self.assertEqual(op["operation"], "add")

    def test_counterbore_needs_no_sketch(self):
        r = plan_operations(
            "counterbore the holes 8mm wide 3mm deep", SKETCHES, TREE, FACES, EDGES,
            llm=_fake("add_features", {
                "reply": "Counterbored the holes.",
                "features": [{"type": "counterbore", "cboreDia": 8, "cboreDepth": 3}],
            }),
        )
        op = r["operations"][0]
        self.assertEqual(op["type"], "counterbore")
        self.assertEqual(op["sketchId"], "")
        self.assertEqual(op["cboreDia"], 8)
        self.assertEqual(op["cboreDepth"], 3)

    def test_unmatched_sketch_falls_back_to_first(self):
        r = plan_operations(
            "extrude it", SKETCHES, TREE, FACES, EDGES,
            llm=_fake("add_features", {
                "reply": "x", "features": [{"type": "extrude", "sketch": "nope", "distance": 4}],
            }),
        )
        self.assertEqual(r["operations"][0]["sketchId"], "sk-plate")


class TrimTests(SimpleTestCase):
    def test_trim_past_axis(self):
        r = plan_operations(
            "cut off everything above z=10", SKETCHES, TREE, FACES, EDGES,
            llm=_fake("add_features", {
                "reply": "Trimmed above z=10.",
                "features": [{"type": "trim", "trimAxis": "Z", "at": 10, "keep": "min"}],
            }),
        )
        op = r["operations"][0]
        self.assertEqual(op["trimAxis"], "Z")
        self.assertEqual(op["at"], 10)
        self.assertEqual(op["keep"], "min")
        self.assertNotIn("trimFace", op)


class MultiAndControlTests(SimpleTestCase):
    def test_multiple_operations(self):
        r = plan_operations(
            "fillet all edges 1mm then trim the top", SKETCHES, TREE, FACES, EDGES,
            llm=_fake("add_features", {
                "reply": "Filleted and trimmed.",
                "features": [
                    {"type": "fillet", "edges": "all", "radius": 1},
                    {"type": "trim", "trimFace": "top"},
                ],
            }),
        )
        self.assertEqual(len(r["operations"]), 2)
        self.assertEqual(r["operations"][0]["radius"], 1)
        self.assertEqual(r["operations"][1]["trimFace"], "top")

    def test_clarify_passes_through(self):
        r = plan_operations(
            "make it better", SKETCHES, TREE, FACES, EDGES,
            llm=_fake("ask_clarification", {"question": "What would you like changed?"}),
        )
        self.assertEqual(r["status"], "clarify")
        self.assertEqual(r["question"], "What would you like changed?")

    def test_bad_edge_selector_retries_then_succeeds(self):
        """A faces:i,j that names no edge triggers one corrective retry."""
        bad = {"tool": "add_features", "input": {"reply": "x",
               "features": [{"type": "chamfer", "edges": "faces:9,9", "distance": 1}]}}
        good = {"tool": "add_features", "input": {"reply": "Chamfered the joint.",
                "features": [{"type": "chamfer", "edges": "between:cylinder,top", "distance": 1}]}}
        r = plan_operations("chamfer the join", SKETCHES, TREE, FACES, EDGES, llm=_seq(bad, good))
        self.assertEqual(r["status"], "ok")
        self.assertEqual(r["operations"][0]["edges"], "between:cylinder,top")

    def test_bad_edge_selector_exhausted_raises(self):
        bad = {"tool": "add_features", "input": {"reply": "x",
               "features": [{"type": "chamfer", "edges": "faces:9,9", "distance": 1}]}}
        with self.assertRaises(ResolverError):
            plan_operations("chamfer the join", SKETCHES, TREE, FACES, EDGES, llm=_seq(bad, bad))

    def test_empty_instruction_rejected(self):
        with self.assertRaises(ResolverError):
            plan_operations("  ", SKETCHES, TREE, FACES, EDGES, llm=_fake("add_features", {}))

    def test_no_operations_rejected(self):
        with self.assertRaises(ResolverError):
            plan_operations(
                "x", SKETCHES, TREE, FACES, EDGES,
                llm=_fake("add_features", {"reply": "ok", "features": []}),
            )
