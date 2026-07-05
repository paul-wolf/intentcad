"""Tests for the feature-tree → solid builder (no DB, no HTTP)."""

import math

from django.test import SimpleTestCase

from modeling.builder import BuildError, build
from modeling.schemas import AxisIn, BuildRequest, FeatureIn, Point, SketchEntityIn, SketchIn
from modeling.selectors import resolve_edges


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

    def test_face_inventory_box(self):
        """A box has exactly 6 planar faces of area 100."""
        res = build(BuildRequest(
            sketches=[SketchIn(id="s", entities=[
                SketchEntityIn(type="rectangle", center=Point(x=0, y=0), width=10, height=10),
            ])],
            features=[FeatureIn(id="f", type="extrude", sketchId="s", distance=10)],
        ))
        self.assertEqual(len(res.faces), 6)
        self.assertTrue(all(f["kind"] == "plane" for f in res.faces))
        self.assertTrue(all(math.isclose(f["area"], 100, rel_tol=1e-3) for f in res.faces))

    def test_edge_inventory_box(self):
        """A box has 12 straight edges of length 10."""
        res = build(BuildRequest(
            sketches=[SketchIn(id="s", entities=[
                SketchEntityIn(type="rectangle", center=Point(x=0, y=0), width=10, height=10),
            ])],
            features=[FeatureIn(id="f", type="extrude", sketchId="s", distance=10)],
        ))
        self.assertEqual(len(res.edges), 12)
        self.assertTrue(all(e["kind"] == "line" for e in res.edges))
        self.assertTrue(all(math.isclose(e["length"], 10, rel_tol=1e-3) for e in res.edges))

    def test_edge_adjacency_between(self):
        """Each edge records its two adjacent faces, so 'between:A,B' targets a
        specific junction — and distinguishes the top junction from the bottom
        (which the coarse kind:ellipse trick could not)."""
        res = build(BuildRequest(
            sketches=[
                SketchIn(id="slab", entities=[
                    SketchEntityIn(type="rectangle", center=Point(x=0, y=0), width=60, height=60)]),
                SketchIn(id="ring", entities=[
                    SketchEntityIn(type="circle", center=Point(x=0, y=0), radius=13),
                    SketchEntityIn(type="circle", center=Point(x=0, y=0), radius=8)]),
            ],
            features=[
                FeatureIn(id="p", type="extrude", sketchId="slab", distance=8),
                FeatureIn(id="s", type="extrude", sketchId="ring", distance=40,
                          tilt=20, tiltAxis="X", operation="add"),
            ],
        ))
        self.assertTrue(all(len(e["faces"]) == 2 for e in res.edges))
        top_j = set(resolve_edges("between:cylinder,top", res.edges))
        bot_j = set(resolve_edges("between:cylinder,bottom", res.edges))
        self.assertTrue(top_j and bot_j)
        self.assertEqual(top_j & bot_j, set())  # top and bottom junctions are disjoint

    def test_edge_inventory_has_circle(self):
        """A revolved tube has circular edges."""
        res = build(BuildRequest(
            sketches=[SketchIn(id="s", entities=[
                SketchEntityIn(type="rectangle", center=Point(x=15, y=0), width=10, height=10),
            ])],
            features=[FeatureIn(
                id="f", type="revolve", sketchId="s",
                axis=AxisIn(start=Point(x=0, y=0), end=Point(x=0, y=1)), angle=360,
            )],
        ))
        self.assertTrue(any(e["kind"] == "circle" for e in res.edges))

    def test_face_directional_tags(self):
        """A box: one face per world direction — top/bottom/left/right/front/back."""
        res = build(BuildRequest(
            sketches=[SketchIn(id="s", entities=[
                SketchEntityIn(type="rectangle", center=Point(x=0, y=0), width=10, height=10),
            ])],
            features=[FeatureIn(id="f", type="extrude", sketchId="s", distance=10)],
        ))
        tags = sorted(t for f in res.faces for t in f["tags"])
        self.assertEqual(tags, ["back", "bottom", "front", "left", "right", "top"])

    def test_trim_to_named_face(self):
        """Trim referencing a face tag ('top') cuts flush with that face — no
        coordinate typed. This is the selection subsystem paying off."""
        slab = SketchIn(id="slab", entities=[
            SketchEntityIn(type="rectangle", center=Point(x=0, y=0), width=10, height=10)])
        boss = SketchIn(id="boss", entities=[
            SketchEntityIn(type="circle", center=Point(x=0, y=0), radius=2)])
        res = build(BuildRequest(sketches=[slab, boss], features=[
            FeatureIn(id="e", type="extrude", sketchId="slab", distance=10),                     # box z 0..10
            FeatureIn(id="b", type="extrude", sketchId="boss", distance=10, offset=[0, 0, 5]),   # boss z 5..15
            FeatureIn(id="t", type="trim", trimFace="top", sketchId=""),
        ]))
        # 'top' resolves to the box top (z=10, the largest +Z face); the boss above is trimmed
        self.assertAlmostEqual(res.metrics["bbox_max"][2], 10, places=2)

    def test_trim_no_op_warns(self):
        """Trimming flush with a face that has no material beyond it removes
        nothing — surfaced as a warning (the wrong-face case, e.g. 'back' when
        the excess pokes out the bottom), not a silent no-op."""
        slab = SketchIn(id="slab", entities=[
            SketchEntityIn(type="rectangle", center=Point(x=0, y=0), width=10, height=10)])
        res = build(BuildRequest(sketches=[slab], features=[
            FeatureIn(id="e", type="extrude", sketchId="slab", distance=10),
            FeatureIn(id="t", type="trim", trimFace="back", sketchId=""),  # nothing beyond +Y face
        ]))
        self.assertTrue(any("removed no material" in w for w in res.warnings))

    def test_face_inventory_has_cylinder(self):
        """Revolving a rectangle offset from the axis yields cylindrical faces."""
        res = build(BuildRequest(
            sketches=[SketchIn(id="s", entities=[
                SketchEntityIn(type="rectangle", center=Point(x=15, y=0), width=10, height=10),
            ])],
            features=[FeatureIn(
                id="f", type="revolve", sketchId="s",
                axis=AxisIn(start=Point(x=0, y=0), end=Point(x=0, y=1)), angle=360,
            )],
        ))
        self.assertTrue(any(f["kind"] == "cylinder" for f in res.faces))

    def _box_size(self, plane):
        """Extrude a 10(x) × 6(y) rect by 20 on the given plane; return bbox sizes."""
        res = build(BuildRequest(
            sketches=[SketchIn(id="s", entities=[
                SketchEntityIn(type="rectangle", center=Point(x=0, y=0), width=10, height=6),
            ])],
            features=[FeatureIn(id="f", type="extrude", sketchId="s", distance=20, plane=plane)],
        ))
        m = res.metrics
        return [round(m["bbox_max"][i] - m["bbox_min"][i], 3) for i in range(3)]

    def test_extrude_on_base_planes(self):
        # XY: extrude runs along Z
        self.assertEqual(self._box_size("XY"), [10, 6, 20])
        # XZ: extrude swings to Y
        self.assertEqual(self._box_size("XZ"), [10, 20, 6])
        # YZ: extrude swings to X
        self.assertEqual(self._box_size("YZ"), [20, 6, 10])

    def test_placement_tilt_and_offset(self):
        # tilt 90° about X takes a Z-extrude horizontal (like XZ placement)
        res = build(BuildRequest(
            sketches=[SketchIn(id="s", entities=[
                SketchEntityIn(type="rectangle", center=Point(x=0, y=0), width=6, height=4),
            ])],
            features=[FeatureIn(id="f", type="extrude", sketchId="s", distance=20,
                                tilt=90, tiltAxis="X")],
        ))
        m = res.metrics
        size = [round(m["bbox_max"][i] - m["bbox_min"][i], 3) for i in range(3)]
        self.assertEqual(size, [6, 20, 4])

        # offset translates the solid into position
        res2 = build(BuildRequest(
            sketches=[SketchIn(id="s", entities=[
                SketchEntityIn(type="rectangle", center=Point(x=0, y=0), width=10, height=10),
            ])],
            features=[FeatureIn(id="f", type="extrude", sketchId="s", distance=10,
                                offset=[100, 0, 0])],
        ))
        self.assertTrue(math.isclose(res2.metrics["bbox_min"][0], 95, abs_tol=1e-4))

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

    def test_fillet_all_edges(self):
        """Extrude a box, then fillet every edge: rounds corners (less volume,
        more faces). First operation that consumes a selector."""
        res = build(BuildRequest(
            sketches=[SketchIn(id="s", entities=[
                SketchEntityIn(type="rectangle", center=Point(x=0, y=0), width=10, height=10),
            ])],
            features=[
                FeatureIn(id="box", type="extrude", sketchId="s", distance=10),
                FeatureIn(id="round", type="fillet", sketchId="", edges="all", radius=1),
            ],
        ))
        self.assertLess(res.metrics["volume"], 1000)     # material removed at corners
        self.assertGreater(len(res.faces), 6)            # new rounded faces

    def test_chamfer_all_edges(self):
        """Extrude a box, then chamfer every edge: bevels corners (less volume,
        more faces). Chamfer is fillet's twin — the FDM-robust-join primitive."""
        res = build(BuildRequest(
            sketches=[SketchIn(id="s", entities=[
                SketchEntityIn(type="rectangle", center=Point(x=0, y=0), width=10, height=10),
            ])],
            features=[
                FeatureIn(id="box", type="extrude", sketchId="s", distance=10),
                FeatureIn(id="bevel", type="chamfer", sketchId="", edges="all", distance=1),
            ],
        ))
        self.assertLess(res.metrics["volume"], 1000)
        self.assertGreater(len(res.faces), 6)

    def test_chamfer_is_tolerant_of_bad_edges(self):
        """A chamfer whose size is too big for one edge in the batch should still
        chamfer the rest and warn — not hard-fail the whole operation."""
        res = build(BuildRequest(
            sketches=[
                SketchIn(id="plate", entities=[
                    SketchEntityIn(type="rectangle", center=Point(x=0, y=0), width=60, height=60)]),
                SketchIn(id="ring", entities=[
                    SketchEntityIn(type="circle", center=Point(x=0, y=0), radius=13),
                    SketchEntityIn(type="circle", center=Point(x=0, y=0), radius=8)]),
            ],
            features=[
                FeatureIn(id="plate", type="extrude", sketchId="plate", distance=8, operation="add"),
                FeatureIn(id="sock", type="extrude", sketchId="ring", distance=50,
                          tilt=20, tiltAxis="X", operation="add"),
                FeatureIn(id="ch", type="chamfer", sketchId="", edges="all", distance=2),
            ],
        ))
        self.assertGreater(res.triangle_count, 0)
        self.assertTrue(any("skipped" in w for w in res.warnings))

    def test_chamfer_without_geometry_raises(self):
        with self.assertRaises(BuildError):
            build(BuildRequest(
                sketches=[],
                features=[FeatureIn(id="bevel", type="chamfer", sketchId="", edges="all", distance=1)],
            ))

    def test_fillet_without_geometry_raises(self):
        with self.assertRaises(BuildError):
            build(BuildRequest(
                sketches=[],
                features=[FeatureIn(id="round", type="fillet", sketchId="", edges="all", radius=1)],
            ))

    def test_fillet_selector_no_match_raises(self):
        with self.assertRaises(BuildError):
            build(BuildRequest(
                sketches=[SketchIn(id="s", entities=[
                    SketchEntityIn(type="rectangle", center=Point(x=0, y=0), width=10, height=10),
                ])],
                features=[
                    FeatureIn(id="box", type="extrude", sketchId="s", distance=10),
                    FeatureIn(id="round", type="fillet", sketchId="", edges="kind:circle", radius=1),
                ],
            ))

    def test_trim_cuts_past_plane(self):
        """Trim removes everything past an axis plane (e.g. a socket flush with a
        face) in one op — no sketch."""
        res = build(BuildRequest(
            sketches=[SketchIn(id="s", entities=[
                SketchEntityIn(type="rectangle", center=Point(x=0, y=0), width=10, height=10)])],
            features=[
                FeatureIn(id="e", type="extrude", sketchId="s", distance=10),  # box z 0..10
                FeatureIn(id="t", type="trim", trimAxis="Z", at=5, keep="min", sketchId=""),
            ],
        ))
        self.assertAlmostEqual(res.metrics["volume"], 500, delta=1)   # half the box
        self.assertAlmostEqual(res.metrics["bbox_max"][2], 5, places=3)

    def test_counterbore_recesses_top(self):
        """A slab with two holes (circles in the extruded profile); a counterbore
        recesses the top face at those circles — removing material near the top,
        not through the part."""
        slab = SketchIn(id="slab", entities=[
            SketchEntityIn(type="rectangle", center=Point(x=0, y=0), width=40, height=40),
            SketchEntityIn(type="circle", center=Point(x=-10, y=-10), radius=3),
            SketchEntityIn(type="circle", center=Point(x=10, y=10), radius=3)])
        base = [FeatureIn(id="e", type="extrude", sketchId="slab", distance=8, operation="add")]
        plain = build(BuildRequest(sketches=[slab], features=base))
        cbored = build(BuildRequest(sketches=[slab], features=base + [
            FeatureIn(id="cb", type="counterbore", sketchId="slab", cboreDia=8, cboreDepth=3)]))
        # recess removes material
        self.assertLess(cbored.metrics["volume"], plain.metrics["volume"])
        # ...but the overall height is unchanged (recess, not through)
        self.assertAlmostEqual(cbored.metrics["bbox_max"][2], plain.metrics["bbox_max"][2], places=3)
        self.assertAlmostEqual(cbored.metrics["bbox_min"][2], plain.metrics["bbox_min"][2], places=3)

    def test_counterbore_needs_dims(self):
        slab = SketchIn(id="slab", entities=[
            SketchEntityIn(type="rectangle", center=Point(x=0, y=0), width=40, height=40),
            SketchEntityIn(type="circle", center=Point(x=0, y=0), radius=3)])
        base = [FeatureIn(id="e", type="extrude", sketchId="slab", distance=8)]
        with self.assertRaises(BuildError):
            build(BuildRequest(sketches=[slab], features=base + [
                FeatureIn(id="cb", type="counterbore", sketchId="slab")]))  # no dia/depth

    def test_unsupported_feature_warns_not_fails(self):
        req = _plate_with_hole()
        req.features.append(FeatureIn(id="f2", type="sweep", sketchId="sk1"))  # not supported yet
        res = build(req)
        self.assertTrue(any("sweep" in w for w in res.warnings))

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
