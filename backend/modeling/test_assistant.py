"""Tests for the AI edit loop (modeling/assistant.py).

The Anthropic call is injected; the returned script is validated by really
building it (build123d), so these cover the prompt/validate/retry logic without
network — but do exercise the engine.
"""

from unittest import mock

from django.test import SimpleTestCase

from modeling import llm_models
from modeling.assistant import AssistantError, edit_script, geometry_summary
from modeling.engine import run_script


def _fake(*outs):
    it = iter(outs)
    return lambda system, user, tools: next(it)


class EditTests(SimpleTestCase):
    def setUp(self):
        # model discovery must not hit the network here — seed the cache
        llm_models._cache.update(at=9e12, value={
            "models": llm_models.select([
                {"id": "claude-opus-5", "display_name": "Claude Opus 5", "created_at": "2026-07-24"},
                {"id": "claude-fable-5-1", "display_name": "Claude Fable 5.1", "created_at": "2026-08-28"},
            ]), "default": "claude-opus-5", "source": "live"})

    def tearDown(self):
        llm_models._cache.update(at=0.0, value=None)

    def test_unknown_model_is_priced_as_the_default(self):
        r = edit_script("part = Box(1,1,1)", "bigger", model="claude-nope-1",
                        llm=_fake({"code": "part = Box(2,2,2)", "note": "ok", "usage": {"input": 1_000_000, "output": 0}}))
        self.assertEqual(r["cost_usd"], 5.0)   # Opus input price, not Fable's

    def test_known_model_is_priced_by_family(self):
        r = edit_script("part = Box(1,1,1)", "bigger", model="claude-fable-5-1",
                        llm=_fake({"code": "part = Box(2,2,2)", "note": "ok", "usage": {"input": 1_000_000, "output": 0}}))
        self.assertEqual(r["cost_usd"], 10.0)

    def test_context_files_go_before_the_text_on_every_call(self):
        seen = []
        outs = iter([{"code": "part = Box(1,1,1) +", "note": "x"},     # fails to build
                     {"code": "part = Box(2,2,2)", "note": "ok"}])
        def llm(system, user, tools):
            seen.append(user)
            return next(outs)
        pdf = {"type": "document", "source": {"type": "base64", "media_type": "application/pdf",
                                              "data": "JVBERi0="}, "cache_control": {"type": "ephemeral"}}
        edit_script("part = Box(1,1,1)", "make a case for the board", files=[pdf],
                    file_listing=["1. carrier.pdf: all 7 pages"], llm=llm)
        self.assertEqual(len(seen), 2)              # the retry sends the files too (cached)
        for user in seen:
            self.assertIs(user[0], pdf)
            self.assertEqual(user[1]["type"], "text")
            self.assertTrue(user[1]["text"].startswith(
                "CONTEXT FILES (attached above, in this order):\n1. carrier.pdf: all 7 pages"))
        self.assertIn("failed to build", seen[1][1]["text"])

    def test_without_files_the_prompt_is_plain_text(self):
        seen = {}
        def llm(system, user, tools):
            seen["user"] = user
            return {"code": "part = Box(1,1,1)", "note": "ok"}
        edit_script("part = Box(2,2,2)", "smaller", llm=llm)
        self.assertIsInstance(seen["user"], str)
        self.assertNotIn("CONTEXT FILES", seen["user"])

    def test_cached_tokens_are_priced_and_reported(self):
        usage = {"input": 2_000, "output": 1_000, "cache_read": 1_000_000, "cache_write": 0}
        r = edit_script("part = Box(1,1,1)", "bigger", model="claude-opus-5",
                        llm=_fake({"code": "part = Box(2,2,2)", "note": "ok", "usage": usage}))
        self.assertEqual(r["tokens_in"], 1_002_000)
        self.assertEqual((r["cache_read_tokens"], r["cache_write_tokens"]), (1_000_000, 0))
        # $5/MTok input: 2k fresh = 0.01, 1M read at 0.1× = 0.5; 1k out at $25/MTok = 0.025
        self.assertAlmostEqual(r["cost_usd"], 0.535, places=4)
        self.assertEqual(llm_models.cache_read_rate("claude-opus-5-5"), 0.05)
        self.assertEqual(llm_models.cache_read_rate("claude-fable-5-1"), 0.025)

    def test_system_prompt_has_the_provenance_rules(self):
        seen = {}
        def llm(system, user, tools):
            seen["system"], seen["tools"] = system, tools
            return {"code": "part = Box(1,1,1)", "note": "ok"}
        edit_script("part = Box(2,2,2)", "a case", llm=llm)
        s = seen["system"]
        for kind in ("(stated)", "(estimated from drawing scale, ±0.5)", "(user said 3.2 in chat)"):
            self.assertIn(kind, s)
        self.assertIn("Never present an estimate as exact", s)
        self.assertIn("note MUST list every estimated value", s)
        self.assertIn("ask_clarification instead of guessing", s)
        self.assertIn("known reference", s)
        note = seen["tools"][0]["input_schema"]["properties"]["note"]["description"]
        self.assertIn("estimated", note)

    def test_returns_validated_script(self):
        r = edit_script("part = Box(10,10,10)", "make it a cylinder",
                        llm=_fake({"code": "part = Cylinder(5, 10)", "note": "Made it a cylinder."}))
        self.assertIn("Cylinder", r["code"])
        self.assertEqual(r["note"], "Made it a cylinder.")

    def test_production_process_reaches_system_prompt(self):
        seen = {}
        def llm(system, user, tools):
            seen["system"] = system
            return {"code": "part = Box(1,1,1)", "note": "ok"}
        edit_script("part = Box(2,2,2)", "add a hole for a 4mm rod",
                    production="FDM 3D print: add 0.4mm clearance to bores.", llm=llm)
        self.assertIn("MANUFACTURING CONTEXT", seen["system"])
        self.assertIn("0.4mm clearance to bores", seen["system"])

    def test_no_production_leaves_system_prompt_clean(self):
        seen = {}
        def llm(system, user, tools):
            seen["system"] = system
            return {"code": "part = Box(1,1,1)", "note": "ok"}
        edit_script("part = Box(2,2,2)", "add a hole", llm=llm)
        self.assertNotIn("MANUFACTURING CONTEXT", seen["system"])

    def test_system_prompt_explains_auto_round(self):
        seen = {}
        def llm(system, user, tools):
            seen["system"] = system
            return {"code": "part = Box(1,1,1)", "note": "ok"}
        edit_script("part = Box(2,2,2)", "soften this part", llm=llm)
        s = seen["system"]
        self.assertIn("auto_round(part", s)
        self.assertIn("LAST", s)              # the final step of the script
        self.assertIn("radii in P", s)
        for word in ("mounting", "mating", "clamping", "bearing", "sealing"):
            self.assertIn(word, s)            # functional faces go in keep
        self.assertIn("not hand-picked fillet()", s)

    def test_system_prompt_explains_organic_shapes(self):
        seen = {}
        def llm(system, user, tools):
            seen["system"] = system
            return {"code": "part = Box(1,1,1)", "note": "ok"}
        edit_script("part = Box(2,2,2)", "make it organic", llm=llm)
        s = seen["system"]
        for api in ("spoke(a, b", "frame(nodes=", "window(part, face", "truss_windows(part, face"):
            self.assertIn(api, s)
        self.assertIn("organic, sculpted, lighter or aerodynamic", s)
        self.assertIn("protected nodes", s)
        self.assertIn("auto_round() LAST", s)
        self.assertIn("flat_bottom_z = the bed plane", s)
        self.assertIn("min_wall", s)
        self.assertIn("remove 30-40% of the mass", s)

    def test_passes_selection_context_in_prompt(self):
        seen = {}
        def llm(system, user, tools):
            seen["user"] = user
            return {"code": "part = Box(1,1,1)", "note": "ok"}
        edit_script("part = Box(2,2,2)", "chamfer it", context="the top face", llm=llm)
        self.assertIn("SELECTION: the top face", seen["user"])

    def test_build_error_is_threaded_into_the_prompt(self):
        seen = {}
        def llm(system, user, tools):
            seen["user"] = user; seen["system"] = system
            return {"code": "part = Box(10,10,10)", "note": "fixed"}
        edit_script("part = fillet(Box(10,10,10).edges(), radius=6)", "fix it",
                    build_error="line 1: ...\nValueError: Failed creating a fillet", llm=llm)
        self.assertIn("BUILD ERROR", seen["user"])
        self.assertIn("Failed creating a fillet", seen["user"])
        self.assertIn("BUILD ERROR", seen["system"])   # the system prompt explains what to do with it

    def test_no_build_error_leaves_prompt_clean(self):
        seen = {}
        def llm(system, user, tools):
            seen["user"] = user
            return {"code": "part = Box(10,10,10)", "note": "ok"}
        edit_script("part = Box(1,1,1)", "bigger", llm=llm)
        self.assertNotIn("BUILD ERROR", seen["user"])

    def test_bad_script_retries_then_succeeds(self):
        r = edit_script("part = Box(10,10,10)", "add a hole", llm=_fake(
            {"code": "part = Box(10,10,10) - Cylinder(2, 20", "note": "hole"},  # syntax error
            {"code": "part = Box(10,10,10) - Cylinder(2, 20)", "note": "Added a hole."},
        ))
        self.assertIn("- Cylinder(2, 20)", r["code"])

    def test_oversized_param_is_fixed_without_a_second_model_call(self):
        calls = []
        def llm(system, user, tools):
            calls.append(user)
            return {"code": "P = {'r': 6.0}\npart = Box(10, 10, 4)\n"
                            "part = fillet(part.edges().filter_by(Axis.Z), radius=P['r'])",
                    "note": "Rounded the corners."}
        r = edit_script("part = Box(10,10,4)", "round the vertical edges", llm=llm)
        self.assertEqual(len(calls), 1)               # no corrective round-trip
        self.assertNotIn("'r': 6.0", r["code"])
        self.assertIn("'r': 4.7", r["code"])          # measured max 5, with margin
        self.assertIn("r reduced to 4.7", r["note"])

    def test_retry_exhausted_raises(self):
        with self.assertRaises(AssistantError):
            edit_script("part = Box(1,1,1)", "x", llm=_fake(
                {"code": "part = nope(", "note": "a"},
                {"code": "part = also_bad(", "note": "b"},
            ))

    def test_failed_edit_still_reports_what_it_cost(self):
        u = {"input": 1000, "output": 500}
        with self.assertRaises(AssistantError) as cm:
            edit_script("part = Box(1,1,1)", "x", llm=_fake(
                {"code": "part = nope(", "note": "a", "usage": u},
                {"code": "part = also_bad(", "note": "b", "usage": u},
            ))
        usage = cm.exception.usage
        self.assertEqual((usage["tokens_in"], usage["tokens_out"]), (2000, 1000))
        self.assertGreater(usage["cost_usd"], 0)

    def test_empty_instruction_rejected(self):
        with self.assertRaises(AssistantError):
            edit_script("part = Box(1,1,1)", "  ", llm=_fake({"code": "x", "note": "y"}))

    def test_asks_clarification_instead_of_editing(self):
        r = edit_script("part = Box(1,1,1)", "make it better", llm=_fake(
            {"kind": "question", "question": "Better how — larger, or filleted edges?"}))
        self.assertEqual(r["kind"], "question")
        self.assertIn("Better how", r["question"])

    def test_history_is_threaded_into_the_prompt(self):
        seen = {}
        def llm(system, user, tools):
            seen["user"] = user
            return {"code": "part = Box(1,1,1)", "note": "ok"}
        edit_script("part = Box(2,2,2)", "make that bigger",
                    history=[{"role": "user", "text": "add a boss"},
                             {"role": "assistant", "text": "Added a boss."}], llm=llm)
        self.assertIn("RECENT CONVERSATION", seen["user"])
        self.assertIn("add a boss", seen["user"])


def _plane(i, center, normal, area=100.0):
    return {"index": i, "kind": "plane", "area": area, "center": center, "normal": normal, "radius": None}


class GeometrySummaryTests(SimpleTestCase):
    def test_groups_planes_by_normal_with_their_positions(self):
        faces = [
            _plane(0, [0, 0, 10], [0, 0, 1], 800), _plane(1, [5, 0, 4], [0, 0, 1], 50),
            _plane(2, [0, 0, 0], [0, 0, -1], 800), _plane(3, [20, 0, 5], [1, 0, 0], 200),
            _plane(4, [0, 7.07, 7.07], [0, 0.7071, 0.7071], 30),
        ]
        s = geometry_summary(faces, {"bbox_min": [-20, -15, 0], "bbox_max": [20, 15, 10]})
        self.assertIn("bbox: min (-20, -15, 0) max (20, 15, 10)  size (40, 30, 10)", s)
        self.assertIn("5 faces: 5 planes", s.replace("5 plane", "5 planes"))
        self.assertIn("normal +Z: 2 faces, area 850", s)
        self.assertIn("z=10: 1 face, area 800 [#0]", s)
        self.assertIn("z=4: 1 face, area 50 [#1]", s)
        self.assertIn("normal -Z", s)
        self.assertIn("z=0: 1 face", s)             # a -Z face reports its z, not -z
        self.assertIn("x=20: 1 face", s)
        self.assertIn("d=10: 1 face", s)            # slanted: offset along the normal
        # largest normal group first
        self.assertLess(s.index("normal +Z"), s.index("normal +X"))

    def test_describes_holes_and_bosses(self):
        r = run_script("part = Box(40, 30, 10) - Pos(8, 4, 0) * Cylinder(3, 20) "
                       "+ Pos(-10, 0, 7) * Cylinder(4, 4)")
        s = geometry_summary(r["faces"], r["metrics"])
        self.assertIn("r=3 (dia 6) axis (0, 0, 1) center (8, 4, 0) hole, ~10 long", s)
        self.assertIn("r=4 (dia 8) axis (0, 0, 1) center (-10, 0, 7) boss/round, ~4 long", s)

    def test_is_capped(self):
        faces = [_plane(i, [0, 0, float(i)], [0, 0, 1]) for i in range(200)]
        s = geometry_summary(faces, max_lines=60)
        self.assertLessEqual(len(s.splitlines()), 60)
        self.assertIn("more lines omitted", s)


class ImportedGeometryEditTests(SimpleTestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        import hashlib
        cls.step = run_script("part = Box(30, 20, 10)", export=["step"])["exports"]["step"].encode()
        cls.sha = hashlib.sha256(cls.step).hexdigest()
        cls.code = f'P = dict()\npart = import_step(ASSETS["{cls.sha}"])'

    def setUp(self):
        llm_models._cache.update(at=9e12, value={
            "models": llm_models.select([
                {"id": "claude-opus-5", "display_name": "Claude Opus 5", "created_at": "2026-07-24"},
            ]), "default": "claude-opus-5", "source": "live"})
        p = mock.patch("modeling.engine.load_assets", return_value={self.sha: self.step})
        p.start()
        self.addCleanup(p.stop)
        q = mock.patch("modeling.assistant.load_assets", return_value={self.sha: self.step})
        q.start()
        self.addCleanup(q.stop)

    def tearDown(self):
        llm_models._cache.update(at=0.0, value=None)

    def test_the_prompt_gets_a_geometry_summary_and_the_rules(self):
        seen = {}
        new = self.code.replace("dict()", "dict(d=4)") + ' - Cylinder(P["d"] / 2, 30)'

        def llm(system, user, tools):
            seen.update(system=system, user=user)
            return {"code": new, "note": "hole"}
        r = edit_script(self.code, "add a hole", document_id="doc", llm=llm)
        self.assertEqual(r["code"], new)
        self.assertIn("GEOMETRY SUMMARY", seen["user"])
        self.assertIn("6 faces: 6 planes", seen["user"].replace("6 plane", "6 planes"))
        self.assertIn("z=5: 1 face, area 600", seen["user"])
        self.assertIn("Never invent, change or remove an ASSETS[...]", seen["system"])

    def test_no_summary_without_assets(self):
        seen = {}

        def llm(system, user, tools):
            seen["user"] = user
            return {"code": "part = Box(2,2,2)", "note": "ok"}
        edit_script("part = Box(1,1,1)", "bigger", llm=llm)
        self.assertNotIn("GEOMETRY SUMMARY", seen["user"])

    def test_an_edit_that_drops_the_import_is_retried(self):
        seen = []

        def llm(system, user, tools):
            seen.append(user)
            return ({"code": "part = Box(30, 20, 10)", "note": "rebuilt"} if len(seen) == 1
                    else {"code": self.code + " - Cylinder(2, 30)", "note": "hole"})
        r = edit_script(self.code, "add a hole", document_id="doc", llm=llm)
        self.assertIn(self.sha, r["code"])
        self.assertIn("no longer imports", seen[1])
