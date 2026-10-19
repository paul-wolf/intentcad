"""edge_ref() / edges_ref(): an edge named by its two faces, found again when
the part changes (modeling/edge_ref.py)."""

from django.test import SimpleTestCase

from modeling.engine import run_script

BOX = 'P = dict(h={h}, w={w}, d={d})\npart = Pos(0, 0, P["h"] / 2) * Box(P["w"], P["d"], P["h"])\n'
PLATE = ('P = dict(t={t}, hole_d={hd})\npart = Pos(0, 0, P["t"] / 2) * Box(60, 40, P["t"])\n'
         'part -= Pos(10, 0, 0) * Cylinder(P["hole_d"] / 2, 100)\n')
# where each lookup's edge went, read back from the script
PROBE = 'e = edge_ref({ref})\nP["mx"], P["my"], P["mz"] = tuple(e @ 0.5)\nP["len"] = e.length\n'


def _edge(r, hint):
    return next(e["ref"] for e in r["edges"] if e["ref"] and e["ref"]["hint"] == hint)


def _probe(code, ref):
    r = run_script(code + PROBE.format(ref=ref))
    return r, r["params"]


class DescribeTests(SimpleTestCase):
    def test_every_box_edge_has_a_ref_naming_its_faces(self):
        r = run_script(BOX.format(h=25, w=90, d=60))
        hints = sorted(e["ref"]["hint"] for e in r["edges"])
        self.assertEqual(len(hints), 12)
        self.assertIn("top-front edge", hints)
        self.assertIn("front-left edge", hints)
        ref = _edge(r, "top-front edge")
        self.assertEqual(ref["kind"], "line")
        self.assertEqual(ref["midpoint"], [0, -30, 25])
        self.assertEqual(ref["length"], 90)
        self.assertEqual(sorted(abs(x) for x in ref["direction"]), [0, 0, 1])
        self.assertEqual(sorted(f["hint"] for f in ref["faces"]), ["front face", "top face"])

    def test_a_hole_rim_is_a_circle_with_its_centre_and_radius(self):
        r = run_script(PLATE.format(t=5, hd=6))
        rim = _edge(r, "Ø6 circle on the top face")
        self.assertEqual(rim["kind"], "circle")
        self.assertEqual(rim["center"], [10, 0, 5])
        self.assertEqual(rim["radius"], 3)
        self.assertEqual([abs(x) for x in rim["axis"]], [0, 0, 1])
        self.assertEqual(sorted(f["hint"] for f in rim["faces"]), ["cylinder face", "top face"])


class FindTests(SimpleTestCase):
    def test_a_box_top_front_edge_survives_height_width_and_depth(self):
        ref = _edge(run_script(BOX.format(h=25, w=90, d=60)), "top-front edge")
        for (h, w, d), (y, z, length) in {(25, 90, 60): (-30, 25, 90), (40, 90, 60): (-30, 40, 90),
                                          (25, 120, 60): (-30, 25, 120), (25, 90, 80): (-40, 25, 90)}.items():
            r, p = _probe(BOX.format(h=h, w=w, d=d), ref)
            self.assertEqual(r["edge_refs"][0]["status"], "found", (h, w, d))
            self.assertAlmostEqual(p["my"], y)
            self.assertAlmostEqual(p["mz"], z)
            self.assertAlmostEqual(p["len"], length)

    def test_a_hole_rim_survives_the_hole_and_the_plate_changing(self):
        rim = _edge(run_script(PLATE.format(t=5, hd=6)), "Ø6 circle on the top face")
        for t, hd in [(5, 9), (8, 6), (3, 4)]:
            r, p = _probe(PLATE.format(t=t, hd=hd), rim)
            self.assertEqual(r["edge_refs"][0]["status"], "found", (t, hd))
            self.assertAlmostEqual(p["len"], 3.14159265 * hd, places=4)
            self.assertAlmostEqual(p["mz"], t)          # the top rim, not the bottom one

    def test_an_edge_whose_face_is_gone_is_not_found(self):
        boss = BOX.format(h=25, w=90, d=60) + 'part += Pos(0, 0, 30) * Box(10, 10, 10)\n'
        refs = [e["ref"] for e in run_script(boss)["edges"]
                if e["ref"] and e["ref"]["hint"] == "top-front edge" and e["ref"]["midpoint"][2] == 35]
        self.assertEqual(len(refs), 1)
        r = run_script(BOX.format(h=25, w=90, d=60) + f"part = part.fillet(1, edges_ref([{refs[0]}]))\n")
        self.assertEqual(r["edge_refs"][0]["status"], "not_found")
        self.assertIn("top-front edge", r["warning"])
        self.assertIn("no longer on the part", r["warning"])

    def test_of_two_edges_between_the_same_faces_the_nearest_is_chosen(self):
        # a notch across the middle of the top-front edge splits it in two
        notch = BOX.format(h=25, w=90, d=60) + 'part -= Pos(0, -30, 25) * Box({n}, 20, 10)\n'
        r = run_script(notch.format(n=10))
        left = next(e["ref"] for e in r["edges"] if e["ref"] and e["ref"]["hint"] == "top-front edge"
                    and e["ref"]["midpoint"][0] < 0)
        self.assertAlmostEqual(left["midpoint"][0], -25)
        r, p = _probe(notch.format(n=30), left)
        self.assertEqual(r["edge_refs"][0]["status"], "found")
        self.assertAlmostEqual(p["mx"], -30)
        self.assertAlmostEqual(p["len"], 30)

    def test_faces_not_found_falls_back_to_the_edge_that_looks_alike(self):
        ref = _edge(run_script(BOX.format(h=25, w=90, d=60)), "top-front edge")
        moved = {**ref, "faces": [{**f, "center": [500, 500, 500], "box": None} for f in ref["faces"]]}
        r, p = _probe(BOX.format(h=25, w=90, d=60), moved)
        self.assertEqual(r["edge_refs"][0]["status"], "ambiguous")
        self.assertAlmostEqual(p["my"], -30)
        self.assertAlmostEqual(p["mz"], 25)

    def test_edges_ref_gives_each_edge_once(self):
        r = run_script(BOX.format(h=25, w=90, d=60))
        top = [e["ref"] for e in r["edges"] if e["ref"]["hint"].startswith("top-")]
        code = BOX.format(h=25, w=90, d=60) + f"P['n'] = len(edges_ref({top + top[:1]}))\n"
        self.assertEqual(run_script(code)["params"]["n"], 4)
