"""Tests for the face selector resolver."""

from django.test import SimpleTestCase

from modeling.builder import build
from modeling.schemas import BuildRequest, FeatureIn, Point, SketchEntityIn, SketchIn
from modeling.selectors import SelectorError, resolve_faces

FACES = [
    {"index": 0, "kind": "plane", "area": 100, "tags": ["top"]},
    {"index": 1, "kind": "plane", "area": 100, "tags": ["bottom"]},
    {"index": 2, "kind": "plane", "area": 50, "tags": ["vertical"]},
    {"index": 3, "kind": "cylinder", "area": 314, "tags": []},
]


class SelectorTests(SimpleTestCase):
    def test_all(self):
        self.assertEqual(resolve_faces("all", FACES), [0, 1, 2, 3])
        self.assertEqual(resolve_faces("*", FACES), [0, 1, 2, 3])

    def test_by_tag(self):
        self.assertEqual(resolve_faces("tag:top", FACES), [0])
        self.assertEqual(resolve_faces("face:bottom", FACES), [1])  # face: is an alias

    def test_by_kind(self):
        self.assertEqual(resolve_faces("kind:cylinder", FACES), [3])
        self.assertEqual(resolve_faces("kind:plane", FACES), [0, 1, 2])

    def test_extremes(self):
        self.assertEqual(resolve_faces("largest", FACES), [3])
        self.assertEqual(resolve_faces("smallest", FACES), [2])

    def test_no_match_is_empty(self):
        self.assertEqual(resolve_faces("tag:nope", FACES), [])

    def test_case_insensitive(self):
        self.assertEqual(resolve_faces("KIND:Cylinder", FACES), [3])

    def test_bad_selectors_raise(self):
        for bad in ("", "wat", "color:red"):
            with self.assertRaises(SelectorError):
                resolve_faces(bad, FACES)

    def test_against_real_inventory(self):
        """Resolve against a freshly built box so field names stay in sync."""
        res = build(BuildRequest(
            sketches=[SketchIn(id="s", entities=[
                SketchEntityIn(type="rectangle", center=Point(x=0, y=0), width=10, height=10),
            ])],
            features=[FeatureIn(id="f", type="extrude", sketchId="s", distance=10)],
        ))
        self.assertEqual(len(resolve_faces("kind:plane", res.faces)), 6)
        self.assertEqual(len(resolve_faces("tag:top", res.faces)), 1)
        self.assertEqual(len(resolve_faces("all", res.faces)), 6)
