"""Tests for the feature-tree → solid builder (no DB, no HTTP)."""

import math

from django.test import SimpleTestCase

from modeling.builder import BuildError, build
from modeling.schemas import AxisIn, BuildRequest, FeatureIn, Point, SketchEntityIn, SketchIn


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

    def test_metrics_of_a_box(self):
        """A 10x10 profile extruded 10 is a unit box: known volume, area, bbox."""
        res = build(BuildRequest(
            sketches=[SketchIn(id="s", entities=[
                SketchEntityIn(type="rectangle", center=Point(x=0, y=0), width=10, height=10),
            ])],
            features=[FeatureIn(id="f", type="extrude", sketchId="s", distance=10)],
        ))
        m = res.metrics
        self.assertTrue(math.isclose(m["volume"], 1000, rel_tol=1e-3))
        self.assertTrue(math.isclose(m["area"], 600, rel_tol=1e-3))
        size = [m["bbox_max"][i] - m["bbox_min"][i] for i in range(3)]
        for s in size:
            self.assertTrue(math.isclose(s, 10, abs_tol=1e-4))

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

    def test_revolve_ring(self):
        """A rectangle offset from the Y axis, revolved 360 deg, is a ring
        (tube): outer radius 20, inner radius 10 -> known volume/bbox."""
        res = build(BuildRequest(
            sketches=[SketchIn(id="s", entities=[
                SketchEntityIn(type="rectangle", center=Point(x=15, y=0), width=10, height=10),
            ])],
            features=[FeatureIn(
                id="f", type="revolve", sketchId="s",
                axis=AxisIn(start=Point(x=0, y=0), end=Point(x=0, y=1)),  # Y axis
                angle=360,
            )],
        ))
        self.assertGreater(res.triangle_count, 0)
        xs, zs = res.positions[0::3], res.positions[2::3]
        # revolving about the sketch Y axis sweeps into X/Z; radius reaches 20
        self.assertTrue(math.isclose(max(xs), 20, abs_tol=0.2))
        self.assertTrue(math.isclose(min(xs), -20, abs_tol=0.2))
        self.assertTrue(math.isclose(max(zs), 20, abs_tol=0.2))

    def test_revolve_partial_angle(self):
        res = build(BuildRequest(
            sketches=[SketchIn(id="s", entities=[
                SketchEntityIn(type="rectangle", center=Point(x=15, y=0), width=10, height=10),
            ])],
            features=[FeatureIn(
                id="f", type="revolve", sketchId="s",
                axis=AxisIn(start=Point(x=0, y=0), end=Point(x=0, y=1)), angle=90,
            )],
        ))
        self.assertGreater(res.triangle_count, 0)

    def test_revolve_with_edge_on_axis(self):
        """A profile whose edge lies exactly on the axis revolves fine (solid of
        revolution). This is what the 'edge' axis options rely on."""
        res = build(BuildRequest(
            sketches=[SketchIn(id="s", entities=[
                SketchEntityIn(type="rectangle", center=Point(x=0, y=0), width=100, height=57),
            ])],
            features=[FeatureIn(
                id="f", type="revolve", sketchId="s",
                axis=AxisIn(start=Point(x=-50, y=0), end=Point(x=-50, y=1)),  # left edge
                angle=360,
            )],
        ))
        self.assertGreater(res.triangle_count, 0)

    def test_revolve_profile_crossing_axis_raises(self):
        with self.assertRaises(BuildError):
            build(BuildRequest(
                sketches=[SketchIn(id="s", entities=[
                    SketchEntityIn(type="rectangle", center=Point(x=0, y=0), width=100, height=57),
                ])],
                features=[FeatureIn(
                    id="f", type="revolve", sketchId="s",
                    axis=AxisIn(start=Point(x=0, y=0), end=Point(x=0, y=1)),  # cuts the profile
                    angle=360,
                )],
            ))

    def test_revolve_without_axis_raises(self):
        with self.assertRaises(BuildError):
            build(BuildRequest(
                sketches=[SketchIn(id="s", entities=[
                    SketchEntityIn(type="rectangle", center=Point(x=15, y=0), width=10, height=10),
                ])],
                features=[FeatureIn(id="f", type="revolve", sketchId="s", angle=360)],
            ))

    def test_unsupported_feature_warns_not_fails(self):
        req = _plate_with_hole()
        req.features.append(FeatureIn(id="f2", type="fillet", sketchId="sk1"))
        res = build(req)
        self.assertTrue(any("fillet" in w for w in res.warnings))

    def test_bulge_full_circle(self):
        """Two vertices joined by two semicircular arcs (bulge 1) form a full
        circle; extruded, it is a cylinder of diameter = chord length."""
        res = build(BuildRequest(
            sketches=[SketchIn(id="sk", entities=[
                SketchEntityIn(type="line", closed=True,
                               points=[Point(x=0, y=0), Point(x=10, y=0)],
                               bulge=[1.0, 1.0]),
            ])],
            features=[FeatureIn(id="f", type="extrude", sketchId="sk", distance=4)],
        ))
        self.assertEqual(res.warnings, [])
        xs, ys = res.positions[0::3], res.positions[1::3]
        # circle radius 5 centered at (5,0) -> x in [0,10], y in [-5,5]
        self.assertTrue(math.isclose(min(xs), 0, abs_tol=0.05))
        self.assertTrue(math.isclose(max(xs), 10, abs_tol=0.05))
        self.assertTrue(math.isclose(min(ys), -5, abs_tol=0.05))
        self.assertTrue(math.isclose(max(ys), 5, abs_tol=0.05))

    def test_open_polyline_arc_is_preserved(self):
        """A multi-vertex polyline that was never marked `closed` (points don't
        repeat) must still close as a profile with its arc intact — not get
        flattened by the straight-only stitcher. Regression for a real sketch."""
        pts = [Point(x=50.58, y=-28.65), Point(x=83.76, y=-44.41),
               Point(x=86.35, y=35.25), Point(x=50.25, y=28.50)]

        def run(bulge):
            return build(BuildRequest(
                sketches=[SketchIn(id="s", entities=[
                    SketchEntityIn(type="line", points=pts, bulge=bulge),  # note: no closed flag
                ])],
                features=[FeatureIn(id="f", type="extrude", sketchId="s", distance=5)],
            ))

        arced = run([0, 0.4142, 0])
        straight = run([0, 0, 0])
        self.assertEqual(arced.warnings, [])
        # a curved side face tessellates into many more triangles than a flat one
        self.assertGreater(arced.triangle_count, straight.triangle_count + 4)

    def test_bulge_arc_no_longer_warns(self):
        """A closed profile with an arc segment builds without the old
        'treated as straight' warning."""
        res = build(BuildRequest(
            sketches=[SketchIn(id="sk", entities=[
                SketchEntityIn(
                    type="line", closed=True,
                    points=[Point(x=0, y=0), Point(x=20, y=0), Point(x=20, y=10), Point(x=0, y=10)],
                    bulge=[0, 0, 0.5, 0],  # arc on the top edge
                ),
            ])],
            features=[FeatureIn(id="f", type="extrude", sketchId="sk", distance=5)],
        ))
        self.assertGreater(res.triangle_count, 0)
        self.assertFalse(any("straight" in w for w in res.warnings))

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
