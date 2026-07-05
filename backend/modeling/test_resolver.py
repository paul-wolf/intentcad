"""Tests for the reference resolver (modeling/resolver.py).

The LLM call is injected, so these exercise the real machinery — the inventory
summary the model reads and the selector-application on the way back — without
any network or API key. A fake llm stands in for Claude.
"""

from django.test import SimpleTestCase

from modeling.resolver import (
    ResolverError,
    build_inventory_summary,
    resolve_reference,
)

# A small plate-with-socket-ish inventory: a top/bottom/4 sides box plus a
# cylinder, with a couple of adjacency-bearing edges.
FACES = [
    {"index": 0, "kind": "plane", "area": 3600.0, "center": [0, 0, 0], "normal": [0, 0, -1], "tags": ["bottom"]},
    {"index": 1, "kind": "plane", "area": 3600.0, "center": [0, 0, 10], "normal": [0, 0, 1], "tags": ["top"]},
    {"index": 2, "kind": "plane", "area": 600.0, "center": [0, 30, 5], "normal": [0, 1, 0], "tags": ["back"]},
    {"index": 3, "kind": "cylinder", "area": 500.0, "center": [0, 0, 15], "normal": [1, 0, 0], "tags": []},
]
EDGES = [
    {"index": 0, "kind": "line", "length": 60.0, "center": [0, 0, 0], "start": [0, 0, 0], "end": [0, 0, 0],
     "faces": [["plane", "top"], ["plane", "back"]], "faceIndices": [1, 2]},
    {"index": 1, "kind": "circle", "length": 40.0, "center": [0, 0, 10], "start": [0, 0, 0], "end": [0, 0, 0],
     "faces": [["cylinder"], ["plane", "top"]], "faceIndices": [3, 1]},
    {"index": 2, "kind": "circle", "length": 40.0, "center": [0, 0, 20], "start": [0, 0, 0], "end": [0, 0, 0],
     "faces": [["cylinder"], ["plane", "bottom"]], "faceIndices": [3, 0]},
]


class InventorySummaryTests(SimpleTestCase):
    def test_lists_faces_edges_and_junctions(self):
        s = build_inventory_summary(FACES, EDGES)
        self.assertIn("FACES (4)", s)
        self.assertIn("EDGES (3)", s)
        # a face descriptor line
        self.assertIn("#1 plane [top]", s)
        # adjacency shown on an edge, with its face indices
        self.assertIn("plane top | plane back", s)
        self.assertIn("[faces 1,2]", s)
        # junctions listed as concrete faces:i,j targets
        self.assertIn("JUNCTIONS", s)
        self.assertIn("faces:1,3", s)
        self.assertIn("cylinder ∩ plane top", s)


def _fake(tool, inp):
    """An llm stub that always returns the given tool call."""
    return lambda system, user, tools: {"tool": tool, "input": inp}


class ResolveTests(SimpleTestCase):
    def test_resolves_a_face_tag(self):
        r = resolve_reference(
            "the back face", FACES, EDGES,
            llm=_fake("choose_selector", {"target": "face", "selector": "tag:back", "rationale": "x"}),
        )
        self.assertEqual(r["status"], "resolved")
        self.assertEqual(r["target"], "face")
        self.assertEqual(r["indices"], [2])

    def test_resolves_a_junction_edge(self):
        r = resolve_reference(
            "the rim where the socket meets the top", FACES, EDGES,
            llm=_fake("choose_selector", {"target": "edge", "selector": "between:cylinder,top", "rationale": "x"}),
        )
        self.assertEqual(r["status"], "resolved")
        self.assertEqual(r["indices"], [1])  # not the cylinder/bottom edge

    def test_clarify_passes_through(self):
        r = resolve_reference(
            "that thing", FACES, EDGES,
            llm=_fake("ask_clarification", {"question": "Which face?"}),
        )
        self.assertEqual(r["status"], "clarify")
        self.assertEqual(r["question"], "Which face?")

    def test_bad_selector_from_model_is_an_error(self):
        with self.assertRaises(ResolverError):
            resolve_reference(
                "x", FACES, EDGES,
                llm=_fake("choose_selector", {"target": "face", "selector": "nonsense:zzz", "rationale": "x"}),
            )

    def test_empty_reference_rejected(self):
        with self.assertRaises(ResolverError):
            resolve_reference("  ", FACES, EDGES, llm=_fake("choose_selector", {}))
