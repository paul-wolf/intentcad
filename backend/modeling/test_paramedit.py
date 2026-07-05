"""Tests for the params editor (modeling/paramedit.py) — pure text/AST."""

from django.test import SimpleTestCase

from modeling.paramedit import ParamError, set_params


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
