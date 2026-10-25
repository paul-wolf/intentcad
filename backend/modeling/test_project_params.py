"""Project parameters in project sketches: a sketch not solved for the current
values gives parts no shapes, one that can't be solved keeps its last good
shapes (and parts the values they were solved with), renaming rewrites where
a name is used, a name can't be both a project and a sketch's own parameter,
and the project page's Used by."""
from documents.models import Document

from . import shared_defs
from .test_shared_defs import PLATE, SharedWorld, frame_profile, plate_volume

PITCH_DIM = {"id": "d1", "type": "dimension", "targetEntityId": "h0", "segmentIndex": 0, "offset": 5,
             "expression": "pitch"}


class SketchParamWorld(SharedWorld):
    def setUp(self):
        super().setUp()
        self.drone.parameters = [{"name": "thick", "value": 2, "unit": "mm"},
                                 {"name": "pitch", "value": 30.5, "unit": "mm"}]
        self.drone.save()
        s = self.holes.data["sketches"][0]
        s["entities"] = [PITCH_DIM]
        s["solvedWith"] = {"pitch": 30.5}
        self.holes.save()

    def set_params(self, body, **extra):
        return self.put(f"/api/projects/{self.drone.id}/parameters", {"parameters": body, **extra})

    def set_pitch(self, v):
        r = self.set_params([{"name": "thick", "value": 2, "unit": "mm"}, {"name": "pitch", "value": v, "unit": "mm"}])
        self.assertEqual(r.status_code, 200, r.content)

    def solve(self, pitch, error=None):
        """What the browser saves after solving the sketch with `pitch`."""
        self.holes.refresh_from_db()
        s = self.holes.data["sketches"][0]
        if error:
            s["solveError"] = {"with": {"pitch": pitch}, "message": error, "dimensionIds": ["d1"]}
        else:
            s["profile"] = frame_profile(pitch=pitch)
            s["solvedWith"] = {"pitch": pitch}
            s.pop("solveError", None)
        self.holes.save()

    def inputs(self, code=PLATE):
        return self.post("/api/build/inputs", {"code": code, "document_id": str(self.plate.id)}).json()


class SolveStateTests(SketchParamWorld):
    def test_a_solved_sketch_builds(self):
        self.assertEqual(self.inputs()["unsolved"], {})
        self.assertEqual(self.build().status_code, 200)

    def test_a_changed_value_holds_parts_until_the_sketch_is_solved_again(self):
        self.assertEqual(self.build().status_code, 200)
        self.set_pitch(44)
        r = self.inputs()
        self.assertEqual(r["unsolved"]["frame"]["state"], "pending")
        self.assertEqual(r["unsolved"]["frame"]["names"], ["pitch"])
        self.assertEqual(r["unsolved"]["frame"]["document"], str(self.holes.id))
        self.assertIn("hasn't been solved for pitch = 44", r["errors"]["frame"])
        self.assertEqual(self.build().status_code, 422)   # never from an unsolved sketch
        self.plate.refresh_from_db()
        self.assertIn('SK["frame"] changed', shared_defs.stale(self.plate))
        self.solve(44)
        r = self.inputs()
        self.assertEqual((r["unsolved"], r["errors"]), ({}, {}))
        self.assertEqual(self.build().status_code, 200)

    def test_an_unsolvable_value_keeps_the_last_good_shapes_and_values(self):
        self.set_pitch(500)
        self.solve(500, error="the holes would be outside the outline")
        r = self.inputs(PLATE + 'assert PP["pitch"] == 30.5, PP["pitch"]\n')
        u = r["unsolved"]["frame"]
        self.assertEqual((u["state"], u["held"]), ("failed", {"pitch": 30.5}))
        self.assertIn("can't be solved with pitch = 500: the holes would be outside", u["message"])
        self.assertIn("keeps its shapes for pitch = 30.5", u["message"])
        self.assertEqual(r["errors"], {})
        self.assertEqual(r["inputs"]["pp"]["pitch"], 30.5)
        code = PLATE + 'assert PP["pitch"] == 30.5, PP["pitch"]\n'
        b = self.post("/api/build/run", {"code": code, "document_id": str(self.plate.id)})
        self.assertEqual(b.status_code, 200, b.content)
        self.assertAlmostEqual(b.json()["metrics"]["volume"], plate_volume(), delta=0.5)

    def test_another_value_after_a_failure_is_pending_again(self):
        self.set_pitch(500)
        self.solve(500, error="no")
        self.set_pitch(40)
        self.assertEqual(self.inputs()["unsolved"]["frame"]["state"], "pending")

    def test_a_sketch_never_solved_with_a_parameter_it_uses_is_pending(self):
        self.holes.data["sketches"][0].pop("solvedWith")
        self.holes.save()
        self.assertEqual(self.inputs()["unsolved"]["frame"]["state"], "pending")

    def test_the_sketchs_own_parameter_of_that_name_is_its_own_business(self):
        self.holes.data["parameters"] = {"pitch": 20}
        self.holes.data["sketches"][0].pop("solvedWith")
        self.holes.save()
        self.assertEqual(self.inputs()["unsolved"], {})

    def test_a_deleted_parameter_the_sketch_used_is_pending(self):
        r = self.set_params([{"name": "thick", "value": 2, "unit": "mm"}])
        self.assertEqual(r.status_code, 200)
        u = self.inputs()["unsolved"]["frame"]
        self.assertEqual(u["state"], "pending")
        self.assertIn("pitch = (deleted)", u["message"])


class RenameTests(SketchParamWorld):
    def test_renaming_rewrites_scripts_sketch_expressions_and_what_they_were_built_with(self):
        code = PLATE + 'x = PP["pitch"] + PP.get(\'pitch\', 0)\nassert PP["pitch_2"] if False else True\n'
        self.plate.data["modelCode"] = code
        self.plate.save()
        self.assertEqual(self.build().status_code, 200)
        self.plate.refresh_from_db()
        self.assertEqual(self.plate.last_build["inputs"]["pp"]["pitch"], 30.5)
        self.holes.data["sketches"][0]["entities"].append({**PITCH_DIM, "id": "d2", "expression": "pitch/2 + pitch_2"})
        self.holes.save()
        r = self.set_params([{"name": "thick", "value": 2, "unit": "mm"}, {"name": "hole_pitch", "value": 30.5}],
                            renames={"pitch": "hole_pitch"})
        self.assertEqual(r.status_code, 200, r.content)
        self.plate.refresh_from_db()
        self.holes.refresh_from_db()
        new = self.plate.data["modelCode"]
        self.assertIn('x = PP["hole_pitch"] + PP.get(\'hole_pitch\', 0)', new)
        self.assertIn('PP["pitch_2"]', new)
        self.assertEqual(self.plate.data["modelCodeHistory"][-1]["code"], code)
        self.assertEqual(self.plate.last_build["inputs"]["pp"], {"thick": 2, "hole_pitch": 30.5})
        s = self.holes.data["sketches"][0]
        self.assertEqual([e["expression"] for e in s["entities"]], ["hole_pitch", "hole_pitch/2 + pitch_2"])
        self.assertEqual(s["solvedWith"], {"hole_pitch": 30.5})
        # nothing is out of date for a rename alone
        self.assertEqual(self.inputs(new)["unsolved"], {})
        self.assertEqual(shared_defs.stale(self.plate), [])


class NameClashTests(SketchParamWorld):
    def test_a_name_a_sketch_has_as_its_own_parameter_cant_be_added(self):
        self.holes.data["parameters"] = {"hole_d": 3.2}
        self.holes.save()
        r = self.set_params([{"name": "thick", "value": 2}, {"name": "pitch", "value": 30.5},
                             {"name": "hole_d", "value": 3}])
        self.assertEqual(r.status_code, 400)
        self.assertIn("'Frame holes' has its own parameter called 'hole_d'", r.json()["message"])
        r = self.set_params([{"name": "thick", "value": 2}, {"name": "hole_d", "value": 3}],
                            renames={"pitch": "hole_d"})
        self.assertEqual(r.status_code, 400)

    def test_an_old_clash_doesnt_block_other_changes(self):
        self.holes.data["parameters"] = {"thick": 3}
        self.holes.save()
        self.assertEqual(self.set_params([{"name": "thick", "value": 4}, {"name": "pitch", "value": 30.5}]).status_code,
                         200)


class UsesTests(SketchParamWorld):
    def test_used_by_lists_sketches_and_parts_and_how(self):
        other = Document.objects.create(name="Arm", project=self.drone, created_by=self.user, data={
            "type": "part", "modelCode": 'part = Box(PP["pitch"], 1, 1)\n', "sketches": []})
        self.set_pitch(500)
        self.solve(500, error="the holes would be outside the outline")
        r = self.client.get(f"/api/projects/{self.drone.id}/parameters/uses")
        self.assertEqual(r.status_code, 200)
        u = r.json()
        self.assertEqual([(s["name"], s["state"]) for s in u["pitch"]["sketches"]], [("Frame holes", "failed")])
        self.assertIn("outside the outline", u["pitch"]["sketches"][0]["message"])
        self.assertEqual(sorted((p["name"], tuple(p["via"])) for p in u["pitch"]["parts"]),
                         [("Arm", ("script",)), ("Top plate", ("Frame holes",))])
        self.assertEqual([p["name"] for p in u["thick"]["parts"]], ["Top plate"])
        self.assertEqual(u["thick"]["sketches"], [])
        self.assertEqual(str(other.project_id), str(self.drone.id))
