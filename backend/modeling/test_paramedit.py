"""Tests for the params editor (modeling/paramedit.py) — pure text/AST."""

from django.test import SimpleTestCase

from modeling.paramedit import ParamError, add_extrude, add_param, set_params


class ParamEditTests(SimpleTestCase):
    def test_dict_call_preserves_formatting_and_comments(self):
        code = "# top\nP = dict(a=1, b=2)  # keep\npart = Box(P['a'], P['b'], 1)\n"
        out = set_params(code, {"b": 5})
        self.assertIn("P = dict(a=1, b=5)  # keep", out)
        self.assertIn("# top", out)

    def test_brace_dict(self):
        code = "P = {'a': 1, 'b': 2}\npart = Box(1,1,1)"
        out = set_params(code, {"a": 9})
        self.assertIn("'a': 9", out)

    def test_float_and_int(self):
        code = "P = dict(x=6)\npart = Box(1,1,1)"
        self.assertIn("x=8", set_params(code, {"x": 8.0}))    # integral float -> int
        self.assertIn("x=2.5", set_params(code, {"x": 2.5}))

    def test_only_named_keys_changed(self):
        code = "P = dict(a=1, b=2, c=3)\npart = Box(1,1,1)"
        out = set_params(code, {"b": 20})
        self.assertIn("a=1", out)
        self.assertIn("b=20", out)
        self.assertIn("c=3", out)

    def test_no_params_dict_raises(self):
        with self.assertRaises(ParamError):
            set_params("part = Box(1,1,1)", {"a": 1})

    def test_empty_overrides_is_noop(self):
        code = "P = dict(a=1)\npart = Box(1,1,1)"
        self.assertEqual(set_params(code, {}), code)


class AddParamTests(SimpleTestCase):
    def test_one_line_dict_call(self):
        out = add_param("P = dict(a=1)  # keep\npart = Box(1,1,1)", "b", 2.0)
        self.assertIn("P = dict(a=1, b=2)  # keep", out)

    def test_one_entry_per_line_keeps_the_layout(self):
        code = "P = dict(\n    a=1,   # first\n    b=2.5\n)\npart = Box(1,1,1)"
        out = add_param(code, "c", 3.0)
        self.assertEqual(out.split("\n")[:5], ["P = dict(", "    a=1,   # first", "    b=2.5,", "    c=3,", ")"])

    def test_brace_dict_and_empty_dict(self):
        self.assertIn('"b": 4', add_param("P = {'a': 1}\n", "b", 4.0))
        self.assertIn("P = dict(b=4)", add_param("P = dict()\n", "b", 4.0))

    def test_no_dict_creates_one_after_the_imports(self):
        out = add_param("import math\npart = Box(1,1,1)\n", "d", 5.0)
        self.assertEqual(out.split("\n")[:3], ["import math", "P = dict(d=5)", ""])
        compile(out, "<t>", "exec")


class AddExtrudeTests(SimpleTestCase):
    code = "P = dict(w=10)\npart = Box(P['w'], 10, 2)\n"

    def test_cut_to_a_depth_adds_a_param(self):
        out, param = add_extrude(self.code, "Sketch 1", "cut", 3)
        self.assertEqual(param, "cut1_depth")
        self.assertIn("P = dict(w=10, cut1_depth=3)", out)
        self.assertTrue(out.endswith('part -= extrude(sketch("Sketch 1"), amount=-P["cut1_depth"])\n'))

    def test_second_cut_gets_a_fresh_name(self):
        once, _ = add_extrude(self.code, "S", "cut", 3)
        _, param = add_extrude(once, "S", "cut", 4)
        self.assertEqual(param, "cut2_depth")

    def test_through_all_has_no_param(self):
        out, param = add_extrude(self.code, "S", "cut", 3, through=True)
        self.assertIsNone(param)
        self.assertIn("amount=-part.bounding_box().diagonal)", out)
        self.assertNotIn("cut1", out)

    def test_join_grows_out_and_flip_reverses(self):
        out, param = add_extrude(self.code, "S", "join", 5)
        self.assertEqual(param, "join1_height")
        self.assertIn('part += extrude(sketch("S"), amount=P["join1_height"])', out)
        flipped, _ = add_extrude(self.code, "S", "join", 5, flip=True)
        self.assertIn('amount=-P["join1_height"]', flipped)

    def test_unknown_op_raises(self):
        with self.assertRaises(ParamError):
            add_extrude(self.code, "S", "revolve", 5)

    def test_new_body_starts_an_empty_script(self):
        out, param = add_extrude("", "Sketch on Top plane", "new", 12)
        self.assertEqual(param, "body1_height")
        self.assertEqual(out, 'P = dict(body1_height=12)\n\n'
                              'part = extrude(sketch("Sketch on Top plane"), amount=P["body1_height"])\n')

    def test_new_body_refuses_a_script_that_has_a_part(self):
        with self.assertRaises(ParamError):
            add_extrude(self.code, "S", "new", 5)

    def test_datum_sketch_cuts_along_the_normal_and_through_both_ways(self):
        out, _ = add_extrude(self.code, "S", "cut", 3, datum=True)
        self.assertIn('amount=P["cut1_depth"])', out)
        through, _ = add_extrude(self.code, "S", "cut", 3, through=True, datum=True)
        self.assertIn("both=True)", through)

    def test_both_ways_from_a_base_plane(self):
        out, param = add_extrude(self.code, "S", "join", 4, datum=True, both=True, flip=True)
        self.assertIn('part += extrude(sketch("S"), amount=P["join1_height"], both=True)', out)
        # a face sketch has no "both": it stays one-sided
        face, _ = add_extrude(self.code, "S", "join", 4, both=True)
        self.assertNotIn("both=True", face)
