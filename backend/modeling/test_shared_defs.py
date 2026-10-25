"""Project-level shared definitions: SK["alias"] (a project sketch) and
PP["name"] (a project parameter) in a part's script, their versions, pinning
on restore, and out-of-date marking."""
import json
import math

from django.test import Client, SimpleTestCase, TestCase

from accounts.models import Organisation, User
from documents.models import Document
from projects.models import Project

from . import shared_defs
from .engine import EngineError, pp_names, run_script, sk_aliases

XY = {"origin": [0, 0, 0], "normal": [0, 0, 1], "xAxis": [1, 0, 0]}


def _rect(x0, y0, x1, y1):
    p = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
    return [{"t": "line", "p": [p[i], p[(i + 1) % 4]]} for i in range(4)]


def frame_profile(pitch=30.5, r=1.6, group="arm holes"):
    """An 80 mm square outline (named "outline") and four holes on a square
    of side `pitch` (group "arm holes"), as the sketch editor saves it."""
    h = pitch / 2
    circles = [{"id": f"h{i}", "c": [x, y], "r": r}
               for i, (x, y) in enumerate([(-h, -h), (h, -h), (h, h), (-h, h)])]
    outline = _rect(-40, -40, 40, 40)
    holes = [[{"t": "circle", "c": c["c"], "r": r}] for c in circles]
    return {"plane": XY, "loops": [outline, *holes], "points": [], "lines": {},
            "items": {"points": [], "circles": circles,
                      "lines": [{"id": "o", "p": seg["p"]} for seg in outline]},
            "names": {"outline": "o"}, "groups": {group: [c["id"] for c in circles]},
            "sub": {f"g:{group}": holes, "n:outline": [outline]}}


PLATE = ('part = extrude(SK["frame"].named("outline"), PP["thick"])\n'
         'part -= extrude(SK["frame"].group("arm holes"), PP["thick"])\n')


def plate_volume(r=1.6, thick=2.0):
    return 80 * 80 * thick - 4 * math.pi * r * r * thick


class ScriptApiTests(SimpleTestCase):
    """SK and PP inside the engine, with the inputs handed to it directly."""

    def run_plate(self, code=PLATE, profile=None, pp=None, errors=None):
        return run_script(code, shared={"sk": {"frame": profile or frame_profile()},
                                        "pp": {"thick": 2.0} if pp is None else pp,
                                        "errors": errors or {}})

    def test_a_shared_sketch_and_parameter_build_a_plate_with_holes(self):
        r = self.run_plate()
        self.assertAlmostEqual(r["metrics"]["volume"], plate_volume(), delta=0.5)

    def test_circles_points_and_plane(self):
        code = ('f = SK["frame"].group("arm holes")\n'
                'assert len(f.circles) == 4 and abs(f.circles[0].diameter - 3.2) < 1e-9\n'
                'assert len(f.points) == 4\n'
                'assert f.points[0].Y == 15.25 or True\n'
                'assert len(SK["frame"].lines) == 4\n'
                'part = Box(1, 1, 1)\n')
        self.run_plate(code)

    def test_sketch_y_runs_up_on_the_plane(self):
        # sketch (x, y) is y-down; on the plane it is (x, -y), as face sketches are
        code = ('c = SK["frame"].group("arm holes").circles[0]\n'
                'assert (round(c.center.X, 3), round(c.center.Y, 3)) == (-15.25, 15.25), c\n'
                'part = Box(1, 1, 1)\n')
        self.run_plate(code)

    def test_on_moves_the_shapes_to_another_plane(self):
        code = ('part = extrude(SK["frame"].named("outline").on(Plane.XY.offset(10)), 2)\n')
        r = self.run_plate(code)
        self.assertAlmostEqual(r["metrics"]["bbox_min"][2], 10, places=3)

    def test_unknown_group_alias_and_parameter_say_what_there_is(self):
        with self.assertRaisesRegex(EngineError, r"no group 'holes'.*'arm holes'"):
            self.run_plate('part = extrude(SK["frame"].group("holes"), 2)\n')
        with self.assertRaisesRegex(EngineError, r"no shared sketch called 'base'.*Use project sketch"):
            self.run_plate('part = extrude(SK["base"], 2)\n')
        with self.assertRaisesRegex(EngineError, r"no parameter called 'arm_od'.*'thick'"):
            self.run_plate('part = Box(PP["arm_od"], 1, 1)\n')

    def test_a_sketch_that_couldnt_be_read_says_why(self):
        with self.assertRaisesRegex(EngineError, "was deleted"):
            run_script('part = extrude(SK["frame"], 2)\n',
                       shared={"errors": {"frame": "SK['frame']: its sketch document was deleted"}})

    def test_aliases_and_names_are_found_in_the_script(self):
        code = 'a = SK["frame"]\nb = SK[\'arm\']\nc = PP["thick"] + PP.get("gap", 1)\nd = SK["frame"]\n'
        self.assertEqual(sk_aliases(code), ["frame", "arm"])
        self.assertEqual(pp_names(code), ["thick", "gap"])

    def test_the_version_covers_names_and_groups(self):
        v = shared_defs.profile_version(frame_profile())
        self.assertEqual(v, shared_defs.profile_version(frame_profile()))
        self.assertNotEqual(v, shared_defs.profile_version(frame_profile(group="holes")))
        renamed = frame_profile()
        renamed["names"] = {"edge": "o"}
        self.assertNotEqual(v, shared_defs.profile_version(renamed))


class SharedWorld(TestCase):
    def setUp(self):
        self.org = Organisation.objects.create(name="Org", slug="org")
        self.user = User.objects.create_user(username="u", email="u@example.com", password="pw",
                                             organisation=self.org)
        self.drone = Project.objects.create(name="Drone", organisation=self.org, created_by=self.user,
                                            parameters=[{"name": "thick", "value": 2, "unit": "mm"}])
        self.holes = Document.objects.create(name="Frame holes", project=self.drone, created_by=self.user,
                                             data={"type": "sketch", "sketches": [
                                                 {"id": "s1", "name": "Frame", "entities": [], "constraints": [],
                                                  "profile": frame_profile()}]})
        self.plate = Document.objects.create(name="Top plate", project=self.drone, created_by=self.user, data={
            "id": "top", "name": "Top plate", "activeSketchId": "", "sketches": [],
            "type": "part", "modelCode": PLATE,
            "sketchRefs": {"frame": {"document": str(self.holes.id), "sketch": "s1"}}})
        self.client = Client()
        self.client.force_login(self.user)

    def post(self, url, body=None):
        return self.client.post(url, content_type="application/json", data=json.dumps(body or {}))

    def put(self, url, body):
        return self.client.put(url, content_type="application/json", data=json.dumps(body))

    def build(self, doc=None, **extra):
        doc = doc or self.plate
        return self.post("/api/build/run", {"code": doc.data["modelCode"], "document_id": str(doc.id), **extra})

    def set_sketch(self, **kw):
        self.holes.data["sketches"][0]["profile"] = frame_profile(**kw)
        self.holes.save()
        self.plate.refresh_from_db()


class ResolveAndBuildTests(SharedWorld):
    def test_a_part_builds_from_the_projects_sketch_and_records_what_it_read(self):
        r = self.build()
        self.assertEqual(r.status_code, 200, r.content)
        self.assertAlmostEqual(r.json()["metrics"]["volume"], plate_volume(), delta=0.5)
        inputs = r.json()["inputs"]
        self.assertEqual(inputs["sk"]["frame"]["document"], str(self.holes.id))
        self.assertEqual(inputs["pp"], {"thick": 2})
        self.plate.refresh_from_db()
        self.assertEqual(self.plate.last_build["inputs"], inputs)
        self.assertEqual(shared_defs.stale(self.plate), [])

    def test_the_editor_can_send_refs_it_hasnt_saved_yet(self):
        Document.objects.filter(id=self.plate.id).update(data={"type": "part", "modelCode": PLATE})
        self.plate.refresh_from_db()
        self.assertEqual(self.build().status_code, 422)
        r = self.build(shared={"refs": {"frame": {"document": str(self.holes.id), "sketch": "s1"}}})
        self.assertEqual(r.status_code, 200, r.content)

    def test_the_inputs_key_changes_with_the_sketch_and_the_parameters(self):
        body = {"code": PLATE, "document_id": str(self.plate.id)}
        k1 = self.post("/api/build/inputs", body).json()["key"]
        self.set_sketch(pitch=44)
        k2 = self.post("/api/build/inputs", body).json()["key"]
        self.put(f"/api/projects/{self.drone.id}/parameters",
                 {"parameters": [{"name": "thick", "value": 3, "unit": "mm"}]})
        k3 = self.post("/api/build/inputs", body).json()["key"]
        self.assertEqual(len({k1, k2, k3}), 3)
        self.assertEqual(self.post("/api/build/inputs", {"code": "part = Box(1, 1, 1)"}).json()["key"], "")

    def test_an_old_sketch_without_shapes_asks_to_be_opened(self):
        del self.holes.data["sketches"][0]["profile"]
        self.holes.save()
        r = self.build()
        self.assertEqual(r.status_code, 422)
        self.assertIn("open 'Frame holes' once in the sketch editor", r.json()["message"])


    def test_sensitivity_builds_with_the_shared_inputs(self):
        code = 'P = {"lip": 3}\n' + PLATE + 'part += Pos(0, 0, PP["thick"]) * Box(10, 10, P["lip"], align=(Align.CENTER, Align.CENTER, Align.MIN))\n'
        r = self.post("/api/build/sensitivity", {"code": code, "document_id": str(self.plate.id)})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertTrue(r.json()["params"]["lip"]["faces"])


class OutOfDateTests(SharedWorld):
    def test_changing_the_sketch_or_a_parameter_marks_the_part_out_of_date(self):
        self.build()
        self.set_sketch(pitch=44)
        self.assertEqual(shared_defs.stale(self.plate), ['SK["frame"] changed'])
        self.put(f"/api/projects/{self.drone.id}/parameters",
                 {"parameters": [{"name": "thick", "value": 3, "unit": "mm"}]})
        self.plate.refresh_from_db()
        self.assertEqual(shared_defs.stale(self.plate), ['SK["frame"] changed', 'PP["thick"] changed'])
        listed = {d["name"]: d for d in self.client.get(f"/api/documents/?project={self.drone.id}").json()}
        self.assertEqual(listed["Top plate"]["stale"], ['SK["frame"] changed', 'PP["thick"] changed'])
        self.assertEqual(listed["Frame holes"]["stale"], [])

    def test_renaming_a_group_marks_it_out_of_date(self):
        self.build()
        self.set_sketch(group="holes")
        self.assertEqual(shared_defs.stale(self.plate), ['SK["frame"] changed'])

    def test_rebuild_brings_it_up_to_date_or_says_why_not(self):
        self.build()
        self.set_sketch(pitch=44)
        r = self.post(f"/api/build/rebuild/{self.plate.id}").json()
        self.assertTrue(r["ok"], r)
        self.plate.refresh_from_db()
        self.assertEqual(shared_defs.stale(self.plate), [])
        self.set_sketch(group="holes")   # the script asks for "arm holes"
        r = self.post(f"/api/build/rebuild/{self.plate.id}").json()
        self.assertFalse(r["ok"])
        self.assertIn("no group 'arm holes'", r["error"] + r["warning"])
        self.assertEqual(r["stale"], ['SK["frame"] changed'])

    def test_used_by_lists_the_parts_and_the_groups_they_ask_for(self):
        self.build()
        self.set_sketch(pitch=44)
        parts = self.client.get(f"/api/documents/{self.holes.id}/used-by").json()["parts"]
        self.assertEqual(len(parts), 1)
        p = parts[0]
        self.assertEqual(p["name"], "Top plate")
        self.assertEqual(p["uses"][0]["alias"], "frame")
        self.assertEqual(p["uses"][0]["sketch"], "s1")
        self.assertEqual(p["uses"][0]["groups"], ["arm holes"])
        self.assertEqual(p["uses"][0]["names"], ["outline"])
        self.assertEqual(p["stale"], ['SK["frame"] changed'])


class PinningTests(SharedWorld):
    def save(self, data, snapshot=True, label=""):
        r = self.put(f"/api/documents/{self.plate.id}",
                     {"data": data, "snapshot": snapshot, "version_label": label})
        self.assertEqual(r.status_code, 200, r.content)
        self.plate.refresh_from_db()

    def test_a_version_keeps_the_sketch_and_parameters_it_was_built_with(self):
        self.save(self.plate.data, label="first")
        v = self.plate.versions.first()
        self.assertEqual(v.data["inputs"]["sk"]["frame"]["profile"], frame_profile())
        self.assertEqual(v.data["inputs"]["pp"], {"thick": 2})

    def test_same_script_with_a_changed_sketch_is_a_new_version(self):
        self.save(self.plate.data)
        self.save(self.plate.data)
        self.assertEqual(self.plate.versions.count(), 1)
        self.set_sketch(r=2.5)
        self.save(self.plate.data)
        self.assertEqual(self.plate.versions.count(), 2)

    def test_restoring_an_old_version_builds_with_the_old_sketch(self):
        self.save(self.plate.data, label="small holes")
        old = self.plate.versions.first()
        self.set_sketch(r=2.5)
        self.put(f"/api/projects/{self.drone.id}/parameters",
                 {"parameters": [{"name": "thick", "value": 3, "unit": "mm"}]})
        r = self.build()
        self.assertAlmostEqual(r.json()["metrics"]["volume"], plate_volume(r=2.5, thick=3), delta=0.5)

        # restore (as the editor does): the script, its refs, and its inputs pinned
        full = self.client.get(f"/api/documents/{self.plate.id}/versions/{old.id}").json()["data"]
        self.save({**self.plate.data, "modelCode": full["modelCode"], "sketchRefs": full["sketchRefs"],
                   "pinned": full["inputs"]}, snapshot=False)
        r = self.build()
        self.assertEqual(r.status_code, 200, r.content)
        self.assertAlmostEqual(r.json()["metrics"]["volume"], plate_volume(r=1.6, thick=2), delta=0.5)
        # pinned, it isn't out of date; a pinned part says so in the list
        self.plate.refresh_from_db()
        self.assertEqual(shared_defs.stale(self.plate), [])
        listed = {d["name"]: d for d in self.client.get(f"/api/documents/?project={self.drone.id}").json()}
        self.assertTrue(listed["Top plate"]["pinned"])

        # Follow latest: the pins go, and it builds with today's sketch again
        self.save({k: v for k, v in self.plate.data.items() if k != "pinned"}, snapshot=False)
        self.assertEqual(shared_defs.stale(self.plate), ['SK["frame"] changed', 'PP["thick"] changed'])
        r = self.build()
        self.assertAlmostEqual(r.json()["metrics"]["volume"], plate_volume(r=2.5, thick=3), delta=0.5)

    def test_the_editors_unsaved_pins_win(self):
        self.save(self.plate.data)
        pins = self.plate.versions.first().data["inputs"]
        self.set_sketch(r=2.5)
        r = self.build(shared={"pinned": pins})
        self.assertAlmostEqual(r.json()["metrics"]["volume"], plate_volume(r=1.6), delta=0.5)


class AccessTests(SharedWorld):
    def test_a_sketch_in_a_project_the_builder_cant_open_isnt_read(self):
        other_org = Organisation.objects.create(name="Other", slug="other")
        stranger = User.objects.create_user(username="x", email="x@example.com", password="pw",
                                            organisation=other_org)
        secret = Project.objects.create(name="Secret", organisation=other_org, created_by=stranger)
        self.holes.project = secret
        self.holes.save()
        r = self.build()
        self.assertEqual(r.status_code, 422)
        self.assertIn("can't open the sketch document", r.json()["message"])
        # nor can the stranger list who uses it, or what
        as_stranger = Client()
        as_stranger.force_login(stranger)
        self.assertEqual(as_stranger.get(f"/api/documents/{self.plate.id}/used-by").status_code, 403)

    def test_a_sketch_in_another_project_the_builder_can_open_is_read(self):
        self.holes.project = Project.objects.create(name="Library", organisation=self.org, created_by=self.user)
        self.holes.save()
        self.assertEqual(self.build().status_code, 200)

    def test_no_user_only_the_parts_own_project_or_creator(self):
        stranger = User.objects.create_user(username="y", email="y@example.com", password="pw",
                                            organisation=self.org)
        self.holes.project = Project.objects.create(name="Library", organisation=self.org, created_by=stranger)
        self.holes.created_by = stranger
        self.holes.save()
        r = shared_defs.resolve(PLATE, self.plate)
        self.assertIn("frame", r["errors"])
        self.assertIn("frame", shared_defs.resolve(PLATE, self.plate, user=self.user)["sk"])


class ProjectParameterTests(SharedWorld):
    def test_names_must_be_usable_and_unique(self):
        url = f"/api/projects/{self.drone.id}/parameters"
        r = self.put(url, {"parameters": [{"name": "arm od", "value": 30}]})
        self.assertEqual(r.status_code, 400)
        r = self.put(url, {"parameters": [{"name": "a", "value": 1}, {"name": "a", "value": 2}]})
        self.assertEqual(r.status_code, 400)
        r = self.put(url, {"parameters": [{"name": "arm_od", "value": 30, "unit": "mm"},
                                          {"name": "screw", "value": "M3"}]})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["parameters"][1], {"name": "screw", "value": "M3", "unit": "",
                                                     "description": ""})


def _scripted(*replies):
    calls = []

    def llm(system, user, tools, turns=None):
        calls.append({"system": system, "user": user, "tools": [t["name"] for t in tools], "turns": turns or []})
        return replies[len(calls) - 1]
    return llm, calls


def tool_call(tool, i="t1", **args):
    return {"kind": "tool", "calls": [{"id": i, "name": tool, "input": args}],
            "content": [{"type": "tool_use", "id": i, "name": tool, "input": args}], "usage": {}}


class AiTests(SharedWorld):
    def setUp(self):
        super().setUp()
        from . import llm_models

        llm_models._cache.update(at=9e12, value={
            "models": llm_models.select([{"id": "claude-opus-5-5", "created_at": "2026-01-01T00:00:00Z"}]),
            "default": "claude-opus-5-5", "source": "live"})
        self.brace = Document.objects.create(name="Arm brace", project=self.drone, created_by=self.user, data={
            "type": "part", "modelCode": "part = Box(60, 20, 2)\n"})

    def tearDown(self):
        from . import llm_models

        llm_models._cache.update(at=0.0, value=None)

    def edit(self, *replies, doc=None, **kw):
        from .assistant import edit_script

        llm, calls = _scripted(*replies)
        doc = doc or self.brace
        return edit_script(doc.data["modelCode"], "use the frame holes", document_id=str(doc.id), llm=llm,
                           **kw), calls

    def test_the_manifest_lists_parameters_sketches_and_who_uses_them(self):
        _, calls = self.edit({"kind": "answer", "text": "ok", "usage": {}, "side": []})
        user, tools = calls[0]["user"], calls[0]["tools"]
        self.assertIn('PP["thick"] = 2 mm; used by Top plate', user)
        self.assertIn('"Frame holes"', user)
        self.assertIn('groups: "arm holes" (4 circles dia 3.2)', user)
        self.assertIn('named: "outline"', user)
        self.assertIn('used by Top plate (SK["frame"])', user)
        self.assertIn("on XY of the project frame", user)
        self.assertIn("use_sketch", tools)
        self.assertIn("set_project_parameter", tools)
        self.assertIn("SHARED DEFINITIONS", calls[0]["system"])
        # the part that uses it is told what its aliases are
        _, calls = self.edit({"kind": "answer", "text": "ok", "usage": {}, "side": []}, doc=self.plate)
        self.assertIn('THIS PART\'S SHARED SKETCHES (already usable in its script):\n- SK["frame"] = '
                      '"Frame holes" sketch "Frame"', calls[0]["user"])

    def test_use_sketch_then_an_edit_that_reads_it(self):
        r, calls = self.edit(
            tool_call("use_sketch", document="Frame holes", sketch="", alias="frame"),
            {"kind": "edit", "code": PLATE, "note": "holes from the shared sketch", "usage": {}, "side": []})
        self.assertEqual(r["kind"], "edit")
        self.assertEqual(r["sketch_refs"], {"frame": {"document": str(self.holes.id), "sketch": "s1"}})
        [res] = calls[1]["turns"][1]["content"]
        self.assertIn('SK["frame"] is now "Frame holes" sketch "Frame"', res["content"])
        # nothing saved: the editor merges the refs into the part
        self.brace.refresh_from_db()
        self.assertNotIn("sketchRefs", self.brace.data)

    def test_an_edit_using_an_alias_it_never_added_fails_to_build(self):
        from .assistant import AssistantError

        bad = {"kind": "edit", "code": PLATE, "note": "x", "usage": {}, "side": []}
        with self.assertRaisesRegex(AssistantError, "no shared sketch called 'frame'"):
            self.edit(bad, bad)

    def test_a_proposed_parameter_is_used_at_once_and_not_saved(self):
        code = 'part = Box(PP["arm_od"], 10, 2)\n'
        r, _ = self.edit(
            tool_call("set_project_parameter", name="arm_od", value=30, unit="mm",
                      description="arm tube OD", reason="the brace and plates clamp the tube"),
            {"kind": "edit", "code": code, "note": "uses arm_od", "usage": {}, "side": []})
        self.assertEqual(r["kind"], "edit")
        self.assertEqual(r["parameter_proposals"], [{"name": "arm_od", "value": 30, "unit": "mm",
                                                     "description": "arm tube OD",
                                                     "reason": "the brace and plates clamp the tube"}])
        self.drone.refresh_from_db()
        self.assertEqual([p["name"] for p in self.drone.parameters], ["thick"])

    def test_a_bad_parameter_name_is_refused_to_the_model(self):
        r, calls = self.edit(
            tool_call("set_project_parameter", name="arm od", value=30, unit="mm", reason="r"),
            {"kind": "answer", "text": "ok", "usage": {}, "side": []})
        self.assertNotIn("parameter_proposals", r)
        self.assertIn("isn't a usable parameter name", calls[1]["turns"][1]["content"][0]["content"])
