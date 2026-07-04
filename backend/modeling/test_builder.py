"""Tests for the feature-tree → solid builder (no DB, no HTTP)."""

import math

from django.test import SimpleTestCase

from modeling.builder import BuildError, build
from modeling.schemas import BuildRequest, FeatureIn, Point, SketchEntityIn, SketchIn


def _plate_with_hole() -> BuildRequest:
    return BuildRequest(
        sketches=[
            SketchIn(
                id="sk1",
                entities=[
                    SketchEntityIn(
                        type="rectangle", center=Point(x=0, y=0),
                        width=40, height=30, anchor="corner",
                    ),
                    SketchEntityIn(type="circle", center=Point(x=20, y=15), radius=5),
                ],
            )
        ],
        features=[FeatureIn(id="f1", type="extrude", sketchId="sk1", distance=10, operation="add")],
    )


class BuilderTests(SimpleTestCase):
    def test_extrude_plate_with_hole(self):
        res = build(_plate_with_hole())
        self.assertGreater(res.triangle_count, 0)
        self.assertEqual(len(res.positions), res.triangle_count * 9)
        self.assertEqual(len(res.normals), len(res.positions))
        self.assertEqual(res.warnings, [])

        xs, ys, zs = res.positions[0::3], res.positions[1::3], res.positions[2::3]
        self.assertTrue(math.isclose(min(xs), 0, abs_tol=1e-6))
        self.assertTrue(math.isclose(max(xs), 40, abs_tol=1e-6))
        self.assertTrue(math.isclose(min(ys), -30, abs_tol=1e-6))
        self.assertTrue(math.isclose(max(ys), 0, abs_tol=1e-6))
        self.assertTrue(math.isclose(min(zs), 0, abs_tol=1e-6))
        self.assertTrue(math.isclose(max(zs), 10, abs_tol=1e-6))

        self.assertTrue(res.step.startswith("ISO-10303-21;"))
        self.assertIn("ENDSEC;", res.step)

    def test_line_polyline_profile(self):
        req = BuildRequest(
            sketches=[
                SketchIn(id="sk", entities=[
                    SketchEntityIn(type="line", closed=True, points=[
                        Point(x=0, y=0), Point(x=10, y=0),
                        Point(x=10, y=10), Point(x=0, y=10),
                    ]),
                ])
            ],
            features=[FeatureIn(id="f", type="extrude", sketchId="sk", distance=5)],
        )
        res = build(req)
        self.assertGreater(res.triangle_count, 0)

    def test_segmented_boundary_with_holes(self):
        """Boundary drawn as separate line segments must stitch into one plate,
        with circles inside treated as holes (regression: they used to extrude
        as disjoint cylinders)."""
        corners = [(0, 0), (100, 0), (100, 80), (0, 80), (0, 0)]
        segs = [
            SketchEntityIn(type="line", points=[Point(x=a[0], y=a[1]), Point(x=b[0], y=b[1])])
            for a, b in zip(corners, corners[1:])
        ]
        holes = [
            SketchEntityIn(type="circle", center=Point(x=x, y=y), radius=3)
            for x, y in [(20, 20), (80, 20), (50, 60)]
        ]
        res = build(BuildRequest(
            sketches=[SketchIn(id="s", entities=[*segs, *holes])],
            features=[FeatureIn(id="f", type="extrude", sketchId="s", distance=10)],
        ))
        xs, ys = res.positions[0::3], res.positions[1::3]
        self.assertTrue(math.isclose(min(xs), 0, abs_tol=1e-4))
        self.assertTrue(math.isclose(max(xs), 100, abs_tol=1e-4))
        self.assertTrue(math.isclose(min(ys), -80, abs_tol=1e-4))
        self.assertTrue(math.isclose(max(ys), 0, abs_tol=1e-4))
        self.assertEqual(res.warnings, [])

    def test_disjoint_shapes_stay_separate(self):
        """Two non-overlapping rectangles must become two solids, not a
        rectangle-with-a-hole."""
        res = build(BuildRequest(
            sketches=[SketchIn(id="s", entities=[
                SketchEntityIn(type="rectangle", center=Point(x=0, y=0), width=20, height=20),
                SketchEntityIn(type="rectangle", center=Point(x=100, y=0), width=20, height=20),
            ])],
            features=[FeatureIn(id="f", type="extrude", sketchId="s", distance=5)],
        ))
        xs = res.positions[0::3]
        self.assertTrue(math.isclose(min(xs), -10, abs_tol=1e-4))
        self.assertTrue(math.isclose(max(xs), 110, abs_tol=1e-4))

    def test_unsupported_feature_warns_not_fails(self):
        req = _plate_with_hole()
        req.features.append(FeatureIn(id="f2", type="fillet", sketchId="sk1"))
        res = build(req)
        self.assertTrue(any("fillet" in w for w in res.warnings))

    def test_bulge_arc_warns(self):
        req = BuildRequest(
            sketches=[
                SketchIn(id="sk", entities=[
                    SketchEntityIn(
                        type="line", closed=True,
                        points=[Point(x=0, y=0), Point(x=10, y=0), Point(x=5, y=10)],
                        bulge=[0.5, 0, 0],
                    ),
                ])
            ],
            features=[FeatureIn(id="f", type="extrude", sketchId="sk", distance=5)],
        )
        res = build(req)
        self.assertTrue(any("bulge" in w for w in res.warnings))

    def test_missing_sketch_raises(self):
        req = BuildRequest(
            sketches=[],
            features=[FeatureIn(id="f", type="extrude", sketchId="nope", distance=5)],
        )
        with self.assertRaises(BuildError):
            build(req)

    def test_no_profile_raises(self):
        req = BuildRequest(
            sketches=[SketchIn(id="sk", entities=[])],
            features=[FeatureIn(id="f", type="extrude", sketchId="sk", distance=5)],
        )
        with self.assertRaises(BuildError):
            build(req)
