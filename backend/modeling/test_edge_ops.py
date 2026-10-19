"""fillet() / chamfer() on edges picked in the editor, and the script lines the
Fillet and Chamfer dialogs write (paramedit.add_edge_op / op_at)."""

from django.test import SimpleTestCase

from modeling.engine import run_script
from modeling.paramedit import ParamError, add_edge_op, op_at, op_lines

BOX = 'P = dict(h={h}, w={w}, d={d})\npart = Pos(0, 0, P["h"] / 2) * Box(P["w"], P["d"], P["h"])\n'
VOL = 90 * 60 * 25


def _edges(r, *hints):
    """The run result's refs of the edges with these hints, as the editor sends them."""
    return [e["ref"] for h in hints for e in r["edges"] if e["ref"] and e["ref"]["hint"] == h]


class EdgeOpTests(SimpleTestCase):
    def setUp(self):
        self.code = BOX.format(h=25, w=90, d=60)
        self.r = run_script(self.code)
        self.top_front = _edges(self.r, "top-front edge")

    def test_a_fillet_rounds_the_edge_and_takes_the_volume_it_should(self):
        code, key = add_edge_op(self.code, "fillet", self.top_front, 3)
        self.assertEqual(key, "fillet_r")
        self.assertIn('part = fillet(part, edges_ref([{"faces": ', code)
        self.assertIn('radius=P["fillet_r"])', code)
        r = run_script(code)
        self.assertFalse(r.get("warning"), r.get("warning"))
        self.assertEqual(r["edge_refs"][0]["status"], "found")
        # a quarter of a 3 x 3 square, less a quarter circle, along the 90 mm edge
        self.assertAlmostEqual(r["metrics"]["volume"], VOL - 90 * (9 - 3.14159265 * 9 / 4), delta=0.05)

    def test_a_chamfer_bevels_the_edges(self):
        loop = _edges(self.r, "top-front edge", "top-right edge", "top-back edge", "top-left edge")
        self.assertEqual(len(loop), 4)
        code, key = add_edge_op(self.code, "chamfer", loop, 1)
        self.assertEqual(key, "chamfer_d")
        self.assertIn('length=P["chamfer_d"])', code)
        r = run_script(code)
        self.assertFalse(r.get("warning"), r.get("warning"))
        # a 1 x 1 / 2 prism round the 300 mm rim, the four mitred corners added back (d³/3 each)
        self.assertAlmostEqual(r["metrics"]["volume"], VOL - 0.5 * 2 * (90 + 60) + 4 / 3, delta=0.01)

    def test_build123d_s_own_form_still_works(self):
        code = self.code + 'part = fillet(part.edges().group_by(Axis.Z)[-1], radius=2)\n'
        r = run_script(code)
        self.assertFalse(r.get("warning"), r.get("warning"))
        self.assertLess(r["metrics"]["volume"], VOL)

    def test_the_fillet_stays_on_its_edge_when_the_box_changes(self):
        code, _ = add_edge_op(self.code, "fillet", self.top_front, 3)
        for h, w, d in [(40, 90, 60), (25, 120, 60), (25, 90, 80)]:
            r = run_script(code.replace("h=25, w=90, d=60", f"h={h}, w={w}, d={d}"))
            self.assertEqual(r["edge_refs"][0]["status"], "found", (h, w, d))
            self.assertAlmostEqual(r["metrics"]["volume"], h * w * d - w * (9 - 3.14159265 * 9 / 4),
                                   delta=0.05, msg=(h, w, d))

    def test_a_radius_too_large_says_what_fits_as_a_one_click_fix(self):
        code, _ = add_edge_op(self.code, "fillet", self.top_front, 40)
        r = run_script(code)
        self.assertIn("too large", r["warning"])
        fix = r["fix"]
        self.assertEqual(fix["kind"], "fillet")
        self.assertEqual(fix["param"], "fillet_r")
        self.assertGreater(fix["max"], 20)     # the 25 mm high face limits it
        self.assertLessEqual(fix["max"], 25.01)
        self.assertLess(fix["value"], fix["max"])
        ok = run_script(code.replace("fillet_r=40", f"fillet_r={fix['value']}"))
        self.assertFalse(ok.get("warning"), ok.get("warning"))


class EdgeOpLineTests(SimpleTestCase):
    def setUp(self):
        self.code = BOX.format(h=25, w=90, d=60)
        self.r = run_script(self.code)
        self.top_front, self.top_back = _edges(self.r, "top-front edge"), _edges(self.r, "top-back edge")

    def test_reopening_reads_the_line_back(self):
        code, _ = add_edge_op(self.code, "fillet", self.top_front, 3)
        op = op_at(code, 3)
        self.assertEqual(op["op"], "fillet")
        self.assertEqual(op["line"], 3)
        self.assertEqual(op["args"]["size"], 3)
        self.assertEqual(op["params"], {"size": "fillet_r"})
        self.assertEqual([e["hint"] for e in op["args"]["edges"]], ["top-front edge"])
        self.assertEqual(op_lines(code), [{"op": "fillet", "line": 3, "end_line": 3}])

    def test_editing_the_value_and_adding_an_edge_rewrites_only_that_line(self):
        code, _ = add_edge_op(self.code, "chamfer", self.top_front, 1)
        code += 'part -= Pos(0, 0, 0) * Cylinder(3, 100)\n'
        op = op_at(code, 3)
        new, key = add_edge_op(code, "chamfer", op["args"]["edges"] + self.top_back, 0.6, line=3)
        self.assertEqual(key, "chamfer_d")
        self.assertIn("chamfer_d=0.6", new)
        self.assertEqual(new.count("chamfer("), 1)
        self.assertTrue(new.rstrip().endswith("part -= Pos(0, 0, 0) * Cylinder(3, 100)"))
        again = op_at(new, 3)
        self.assertEqual(again["args"]["size"], 0.6)
        self.assertEqual([e["hint"] for e in again["args"]["edges"]], ["top-front edge", "top-back edge"])
        r = run_script(new)
        self.assertFalse(r.get("warning"), r.get("warning"))
        self.assertEqual([x["status"] for x in r["edge_refs"]], ["found", "found"])

    def test_a_second_fillet_gets_its_own_key(self):
        code, _ = add_edge_op(self.code, "fillet", self.top_front, 3)
        code, key = add_edge_op(code, "fillet", self.top_back, 2)
        self.assertEqual(key, "fillet2_r")

    def test_refused(self):
        with self.assertRaises(ParamError):
            add_edge_op(self.code, "fillet", [], 1)
        with self.assertRaises(ParamError):
            add_edge_op(self.code, "fillet", self.top_front, 0)
        with self.assertRaises(ParamError):
            add_edge_op("P = dict()\n", "fillet", self.top_front, 1)

    def test_the_build_says_which_line_looked_each_edge_up_and_how_long_it_is_now(self):
        code, _ = add_edge_op(self.code, "fillet", self.top_front + self.top_back, 3)
        r = run_script(code.replace("w=90", "w=110"))
        self.assertEqual([(x["hint"], x["line"], x["length"]) for x in r["edge_refs"]],
                         [("top-front edge", 3, 110), ("top-back edge", 3, 110)])
        self.assertEqual(r["edge_refs"][0]["midpoint"], [0, -30, 25])
