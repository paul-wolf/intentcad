"""Generated sketches: a run's outputs, checks, annotations and the parameters
it read; the profile parts use (hashing, pinning, SK["…"].group(output)); re-runs
on a parameter save making parts out of date; the warning before outputs parts
use go; a failed run keeping the last good result; and who may run or save one."""
import math

from django.test import Client, SimpleTestCase

from accounts.models import Organisation, User
from documents.models import Document
from projects.models import Project

from . import generated_sketch as gs
from . import shared_defs
from .engine import run_sketch_code
from .test_shared_defs import SharedWorld

LAYOUT = '''\
w = PP["w"]
if w > 200:
    raise ValueError("too wide for the bed")
plate = Rectangle(w, 60)
output("plate", plate, "the outline")
output("holes", holes([(-w / 2 + 8, 0), (w / 2 - 8, 0)], 3.4), "2 fixing holes")
check("fits the bed", w <= 256, f"{w:g} mm", output="plate")
check("hole edge", w / 2 - 8 - 1.7 >= 2)
label("front", (0, -40))
dim((-w / 2, -35), (w / 2, -35))
'''

PART = 'part = extrude(SK["layout"].group("plate"), 2) - extrude(SK["layout"].group("holes"), 2)\n'


def part_volume(w):
    return w * 60 * 2 - 2 * math.pi * 1.7 ** 2 * 2


class RunTests(SimpleTestCase):
    def test_outputs_checks_annotations_and_reads(self):
        r = run_sketch_code(LAYOUT, {"w": 100, "unused": 3})
        self.assertTrue(r["ok"], r)
        self.assertEqual([o["name"] for o in r["outputs"]], ["plate", "holes"])
        self.assertEqual(r["outputs"][0]["size"], "100 × 60 mm")
        self.assertEqual((r["outputs"][1]["kind"], r["outputs"][1]["size"]), ("holes", "2 holes Ø3.4"))
        self.assertEqual([(c["name"], c["ok"]) for c in r["checks"]], [("fits the bed", True), ("hole edge", True)])
        self.assertEqual(r["checks"][0]["output"], "plate")
        self.assertEqual(r["annotations"]["labels"], [{"text": "front", "at": [0, 40]}])   # sketch y is down
        self.assertEqual(r["annotations"]["dims"][0]["text"], "100")
        self.assertEqual(r["reads"], {"w": 100})
        p = r["profile"]
        self.assertEqual(sorted(p["groups"]), ["holes", "plate"])
        self.assertEqual(p["names"], {"plate": "g:plate:0"})
        self.assertEqual(len(p["items"]["circles"]), 2)
        self.assertTrue(all(e["generated"] for e in r["entities"]))

    def test_arcs_bulge_the_way_the_editor_draws_them(self):
        r = run_sketch_code('output("r", RectangleRounded(20, 10, 3))\n', {})
        e, loop = r["entities"][0], r["profile"]["loops"][0]
        pts = e["points"] + [e["points"][0]]
        arcs = 0
        for i, seg in enumerate(loop):
            if seg["t"] != "arc":
                continue
            arcs += 1
            (ax, ay), (bx, by), b = (pts[i]["x"], pts[i]["y"]), (pts[i + 1]["x"], pts[i + 1]["y"]), e["bulge"][i]
            d = math.hypot(bx - ax, by - ay)
            # utils/arcGeometry.ts arcMidpoint
            mid = ((ax + bx) / 2 + b * d / 2 * (by - ay) / d, (ay + by) / 2 - b * d / 2 * (bx - ax) / d)
            self.assertAlmostEqual(mid[0], seg["p"][1][0], places=3)
            self.assertAlmostEqual(mid[1], seg["p"][1][1], places=3)
        self.assertEqual(arcs, 4)

    def test_an_error_says_where(self):
        r = run_sketch_code(LAYOUT, {"w": 300})
        self.assertFalse(r["ok"])
        self.assertIn("too wide", r["error"])
        self.assertEqual(r["line"], 3)
        self.assertEqual(r["reads"], {"w": 300})

    def test_a_missing_parameter_names_those_there_are(self):
        r = run_sketch_code(LAYOUT, {"width": 1})
        self.assertFalse(r["ok"])
        self.assertIn("'width'", r["error"])


class GeneratedWorld(SharedWorld):
    def setUp(self):
        super().setUp()
        self.drone.parameters = [{"name": "thick", "value": 2, "unit": "mm"},
                                 {"name": "w", "value": 100, "unit": "mm"}]
        self.drone.save()
        r = self.post("/api/sketches/create", {"project_id": str(self.drone.id), "name": "Layout", "code": LAYOUT})
        self.assertEqual(r.status_code, 200, r.content)
        self.layout = Document.objects.get(id=r.json()["id"])
        self.part = Document.objects.create(name="Plate", project=self.drone, created_by=self.user, data={
            "id": "p", "name": "Plate", "activeSketchId": "", "sketches": [], "type": "part",
            "modelCode": PART,
            "sketchRefs": {"layout": {"document": str(self.layout.id), "sketch": self.sketch()["id"]}}})

    def sketch(self):
        self.layout.refresh_from_db()
        return gs.the_sketch(self.layout)

    def set_w(self, v, **extra):
        r = self.put(f"/api/projects/{self.drone.id}/parameters", {"parameters": [
            {"name": "thick", "value": 2, "unit": "mm"}, {"name": "w", "value": v, "unit": "mm", **extra}]})
        return r

    def rebuild(self):
        r = self.post(f"/api/build/rebuild/{self.part.id}")
        self.assertTrue(r.json()["ok"], r.content)

    def save_code(self, code, **extra):
        return self.put(f"/api/sketches/{self.layout.id}/code", {"code": code, **extra}).json()


class GeneratedSketchTests(GeneratedWorld):
    def test_create_runs_it_and_stores_the_result(self):
        s = self.sketch()
        self.assertEqual(self.layout.data["source"], "generated")
        self.assertEqual(s["solvedWith"], {"w": 100})
        self.assertEqual([o["name"] for o in s["generated"]["outputs"]], ["plate", "holes"])
        self.assertIsNone(s["generated"]["error"])
        self.assertEqual([g["name"] for g in s["groups"]], ["plate", "holes"])

    def test_a_part_uses_its_outputs_by_group(self):
        r = self.build(self.part)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertAlmostEqual(r.json()["metrics"]["volume"], part_volume(100), delta=0.5)

    def test_the_version_is_a_hash_of_its_result(self):
        v1 = shared_defs.profile_version(self.sketch()["profile"])
        self.save_code(LAYOUT.replace("Rectangle(w, 60)", "Rectangle(w, 50)"))
        v2 = shared_defs.profile_version(self.sketch()["profile"])
        self.assertNotEqual(v1, v2)
        self.save_code(LAYOUT)   # the same result, the same version
        self.assertEqual(shared_defs.profile_version(self.sketch()["profile"]), v1)

    def test_a_trial_run_saves_nothing(self):
        before = self.sketch()
        r = self.post(f"/api/sketches/{self.layout.id}/run", {"pp": {"w": 80}}).json()
        self.assertEqual(r["result"]["outputs"][0]["size"], "80 × 60 mm")
        self.assertEqual(self.sketch(), before)
        self.assertEqual(self.layout.versions.count(), 0)

    def test_a_trial_run_of_unsaved_code(self):
        r = self.post(f"/api/sketches/{self.layout.id}/run", {"code": LAYOUT.replace("60", "70")}).json()
        self.assertEqual(r["result"]["outputs"][0]["size"], "100 × 70 mm")

    def test_a_parameter_save_reruns_it_and_parts_go_out_of_date(self):
        self.rebuild()
        self.assertEqual(shared_defs.stale(self.part.id), [])
        self.assertEqual(self.set_w(80).status_code, 200)
        s = self.sketch()
        self.assertEqual(s["solvedWith"], {"w": 80})
        self.assertEqual(s["generated"]["outputs"][0]["size"], "80 × 60 mm")
        self.assertEqual(shared_defs.stale(self.part.id), ['SK["layout"] changed'])
        self.rebuild()
        self.assertEqual(shared_defs.stale(self.part.id), [])
        self.assertAlmostEqual(self.build(self.part).json()["metrics"]["volume"], part_volume(80), delta=0.5)

    def test_a_pinned_part_keeps_the_old_shapes(self):
        resolved = shared_defs.resolve(PART, self.part)
        self.part.data["pinned"] = shared_defs.pin_inputs(resolved)
        self.part.save()
        self.set_w(80)
        self.assertAlmostEqual(self.build(self.part).json()["metrics"]["volume"], part_volume(100), delta=0.5)

    def test_a_pending_sketch_runs_when_a_part_needs_it(self):
        self.drone.parameters[1]["value"] = 90    # changed without the parameters endpoint
        self.drone.save()
        self.assertEqual(shared_defs.sketch_state(self.layout, self.sketch(), shared_defs.params_of(self.drone))["state"],
                         "pending")
        self.assertAlmostEqual(self.build(self.part).json()["metrics"]["volume"], part_volume(90), delta=0.5)
        self.assertEqual(self.sketch()["solvedWith"], {"w": 90})

    def test_used_by_and_the_parameters_it_reads(self):
        from .project_params import uses

        u = uses(self.drone)
        self.assertEqual([s["name"] for s in u["w"]["sketches"]], ["Layout"])
        self.assertEqual([(p["name"], p["via"]) for p in u["w"]["parts"]], [("Plate", ["Layout"])])
        self.assertEqual(gs.used_outputs(self.layout), {"holes": ["Plate"], "plate": ["Plate"]})

    def test_saving_code_keeps_a_revert_point(self):
        self.save_code(LAYOUT.replace("60", "50"), label="edited in Code")
        self.layout.refresh_from_db()
        hist = self.layout.data["codeHistory"]
        self.assertEqual(hist[-1]["code"], LAYOUT)
        self.assertEqual(hist[-1]["label"], "edited in Code")
        self.assertIn("Rectangle(w, 50)", self.layout.data["code"])

    def test_renaming_the_parameter_rewrites_the_code(self):
        r = self.put(f"/api/projects/{self.drone.id}/parameters", {"parameters": [
            {"name": "thick", "value": 2, "unit": "mm"}, {"name": "width", "value": 100, "unit": "mm"}],
            "renames": {"w": "width"}})
        self.assertEqual(r.status_code, 200, r.content)
        s = self.sketch()
        self.assertIn('PP["width"]', self.layout.data["code"])
        self.assertEqual(s["solvedWith"], {"width": 100})
        self.assertIsNone(s["generated"]["error"])
        self.assertEqual(self.layout.data["codeHistory"][-1]["code"], LAYOUT)


    def test_the_part_chat_sees_its_outputs_and_failing_checks(self):
        from .project_context import shared_context, use_sketch
        docs = list(Document.objects.filter(project=self.drone))
        out = shared_context(self.part, docs)
        self.assertIn('outputs (use as .group("name")): plate (100 × 60 mm, the outline); '
                      'holes (2 holes Ø3.4, 2 fixing holes)', out)
        self.assertNotIn("FAILING", out)
        self.set_w(14)                            # the holes now sit too near the edge
        out = shared_context(self.part, [Document.objects.get(id=d.id) for d in docs])
        self.assertIn("FAILING checks: hole edge", out)
        _, said = use_sketch(self.part.id, "Layout", "", "frame")
        self.assertIn("outputs (use as", said)


class OutputWarningTests(GeneratedWorld):
    def test_dropping_an_output_a_part_uses_asks_first(self):
        renamed = LAYOUT.replace('output("holes"', 'output("fixing_holes"')
        r = self.save_code(renamed)
        self.assertFalse(r["saved"])
        self.assertEqual(r["broken"], [{"name": "holes", "parts": ["Plate"]}])
        self.layout.refresh_from_db()
        self.assertEqual(self.layout.data["code"], LAYOUT)
        r = self.save_code(renamed, confirm=True)
        self.assertTrue(r["saved"])
        self.assertEqual([o["name"] for o in self.sketch()["generated"]["outputs"]], ["plate", "fixing_holes"])

    def test_a_trial_run_says_what_it_would_break(self):
        r = self.post(f"/api/sketches/{self.layout.id}/run",
                      {"code": LAYOUT.replace('output("plate", plate, "the outline")\n', "")}).json()
        self.assertEqual(r["broken"], [{"name": "plate", "parts": ["Plate"]}])

    def test_an_output_no_part_uses_goes_quietly(self):
        self.part.data["modelCode"] = 'part = extrude(SK["layout"].group("plate"), 2)\n'
        self.part.save()
        r = self.save_code(LAYOUT.replace('output("holes"', 'output("fixing_holes"'))
        self.assertTrue(r["saved"])


class ErrorTests(GeneratedWorld):
    def test_bad_code_keeps_the_last_good_result(self):
        good = self.sketch()
        r = self.save_code(LAYOUT + "oops(\n")
        self.assertTrue(r["saved"])
        self.assertFalse(r["result"]["ok"])
        s = self.sketch()
        self.assertEqual(s["profile"], good["profile"])
        self.assertEqual(s["entities"], good["entities"])
        self.assertEqual(s["generated"]["outputs"], good["generated"]["outputs"])
        self.assertIsNotNone(s["generated"]["error"])
        self.assertEqual(s["generated"]["error"]["line"], 11)
        # parts keep building from it
        self.assertAlmostEqual(self.build(self.part).json()["metrics"]["volume"], part_volume(100), delta=0.5)

    def test_a_value_it_fails_on_holds_the_value_it_last_worked_with(self):
        self.rebuild()
        self.set_w(250)
        s = self.sketch()
        self.assertIn("too wide", s["generated"]["error"]["message"])
        self.assertEqual(s["generated"]["error"]["line"], 3)
        self.drone.refresh_from_db()
        state = shared_defs.sketch_state(self.layout, s, shared_defs.params_of(self.drone))
        self.assertEqual(state["state"], "failed")
        self.assertEqual(state["held"], {"w": 100})
        # the part still builds as it was, and isn't out of date
        self.assertAlmostEqual(self.build(self.part).json()["metrics"]["volume"], part_volume(100), delta=0.5)
        self.assertEqual(shared_defs.stale(self.part.id), [])
        # a value that works again runs again
        self.set_w(120)
        s = self.sketch()
        self.assertIsNone(s["generated"]["error"])
        self.assertNotIn("solveError", s)
        self.assertEqual(s["solvedWith"], {"w": 120})

    def test_fixing_the_code_clears_the_error(self):
        self.save_code("raise ValueError('no')\n")
        self.save_code(LAYOUT)
        self.assertIsNone(self.sketch()["generated"]["error"])


class StorageTests(GeneratedWorld):
    def test_a_document_save_cant_overwrite_its_code_or_runs(self):
        self.layout.refresh_from_db()
        data = {**self.layout.data, "code": "evil", "codeHistory": [],
                "sketches": [{"id": "x", "name": "x", "visible": True, "entities": [], "constraints": []}],
                "chat": [{"role": "user", "text": "hi"}]}
        r = self.put(f"/api/documents/{self.layout.id}", {"data": data})
        self.assertEqual(r.status_code, 200, r.content)
        self.layout.refresh_from_db()
        self.assertEqual(self.layout.data["code"], LAYOUT)
        self.assertEqual(gs.the_sketch(self.layout)["generated"]["outputs"][0]["name"], "plate")
        self.assertEqual(self.layout.data["chat"], [{"role": "user", "text": "hi"}])

    def test_a_drawn_document_cant_become_generated_by_a_save(self):
        self.holes.data.update({"id": "h", "name": "Frame holes", "activeSketchId": "s1"})
        self.holes.data["sketches"][0]["visible"] = True
        data = {**self.holes.data, "source": "generated", "code": "x = 1"}
        r = self.put(f"/api/documents/{self.holes.id}", {"data": data})
        self.assertEqual(r.status_code, 200, r.content)
        self.holes.refresh_from_db()
        self.assertNotIn("source", self.holes.data)
        self.assertNotIn("code", self.holes.data)

    def test_an_empty_drawn_sketch_becomes_generated_in_place(self):
        empty = Document.objects.create(name="Empty", project=self.drone, created_by=self.user, data={
            "id": "e", "name": "Empty", "type": "sketch", "activeSketchId": "s",
            "sketches": [{"id": "s", "name": "Sketch 1", "visible": True, "entities": [], "constraints": []}]})
        r = self.post("/api/sketches/create", {"from_document": str(empty.id), "code": LAYOUT}).json()
        self.assertEqual(r["id"], str(empty.id))
        self.assertFalse(r["created"])
        empty.refresh_from_db()
        self.assertEqual(empty.data["source"], "generated")
        self.assertEqual(gs.the_sketch(empty)["id"], "s")
        self.assertEqual(len(gs.the_sketch(empty)["generated"]["outputs"]), 2)

    def test_a_sketch_still_called_sketch_takes_the_proposed_name(self):
        empty = Document.objects.create(name="Sketch 2", project=self.drone, created_by=self.user, data={
            "name": "Sketch 2", "type": "sketch", "sketches": [{"id": "s", "entities": [], "constraints": []}]})
        named = Document.objects.create(name="Mine", project=self.drone, created_by=self.user, data={
            "name": "Mine", "type": "sketch", "sketches": [{"id": "s", "entities": [], "constraints": []}]})
        for doc in (empty, named):
            self.post("/api/sketches/create", {"from_document": str(doc.id), "code": LAYOUT, "name": "Frame layout"})
            doc.refresh_from_db()
        self.assertEqual((empty.name, empty.data["name"]), ("Frame layout", "Frame layout"))
        self.assertEqual(named.name, "Mine")

    def test_a_drawn_sketch_with_shapes_gets_a_new_document(self):
        self.holes.data["sketches"][0]["entities"] = [
            {"id": "c", "type": "circle", "center": {"x": 0, "y": 0}, "radius": 3}]
        self.holes.save()
        r = self.post("/api/sketches/create", {"from_document": str(self.holes.id), "name": "Layout"}).json()
        self.assertTrue(r["created"])
        self.assertNotEqual(r["id"], str(self.holes.id))
        self.assertEqual(r["name"], "Layout (2)")
        self.holes.refresh_from_db()
        self.assertNotIn("source", self.holes.data)

    def test_a_new_one_starts_with_an_outline(self):
        r = self.post("/api/sketches/create", {"project_id": str(self.drone.id), "name": "Blank"}).json()
        self.assertEqual([o["name"] for o in r["data"]["sketches"][0]["generated"]["outputs"]], ["outline"])

    def test_the_project_list_says_generated_and_its_outputs(self):
        self.layout.data["sketches"][0]["generated"]["checks"].append({"name": "x", "ok": False, "message": ""})
        self.layout.save()
        rows = {d["name"]: d for d in self.client.get(f"/api/documents/?project={self.drone.id}").json()}
        self.assertEqual(rows["Layout"]["source"], "generated")
        self.assertEqual(rows["Layout"]["outputs"], ["plate", "holes"])
        self.assertEqual(rows["Layout"]["failing_checks"], 1)
        self.assertEqual(rows["Frame holes"]["source"], "drawn")

    def test_the_chat_is_kept_without_moving_updated_at(self):
        self.layout.refresh_from_db()
        at = self.layout.updated_at
        r = self.put(f"/api/sketches/{self.layout.id}/chat", {"chat": [{"role": "user", "text": "hello"}]})
        self.assertEqual(r.status_code, 200)
        self.layout.refresh_from_db()
        self.assertEqual(self.layout.data["chat"], [{"role": "user", "text": "hello"}])
        self.assertEqual(self.layout.updated_at, at)

    def test_slider_ranges_are_kept_and_checked(self):
        self.assertEqual(self.set_w(100, min=50, max=150, step=1).status_code, 200)
        self.drone.refresh_from_db()
        self.assertEqual(self.drone.parameters[1], {"name": "w", "value": 100, "unit": "mm", "description": "",
                                                    "min": 50, "max": 150, "step": 1})
        self.assertEqual(self.set_w(100, min=150, max=50).status_code, 400)
        self.assertEqual(self.set_w(100, step=0).status_code, 400)


class AccessTests(GeneratedWorld):
    def setUp(self):
        super().setUp()
        other = Organisation.objects.create(name="Other", slug="other")
        stranger = User.objects.create_user(username="x", email="x@example.com", password="pw", organisation=other)
        self.stranger = Client()
        self.stranger.force_login(stranger)

    def as_stranger(self, method, url, body):
        import json

        return getattr(self.stranger, method)(url, content_type="application/json", data=json.dumps(body))

    def test_a_stranger_cant_run_save_or_chat(self):
        base = f"/api/sketches/{self.layout.id}"
        self.assertEqual(self.as_stranger("post", f"{base}/run", {}).status_code, 403)
        self.assertEqual(self.as_stranger("put", f"{base}/code", {"code": "x"}).status_code, 403)
        self.assertEqual(self.as_stranger("put", f"{base}/chat", {"chat": []}).status_code, 403)
        self.layout.refresh_from_db()
        self.assertEqual(self.layout.data["code"], LAYOUT)

    def test_a_stranger_cant_create_one_in_the_project_or_convert_a_sketch(self):
        self.assertEqual(self.as_stranger("post", "/api/sketches/create",
                                          {"project_id": str(self.drone.id)}).status_code, 403)
        self.assertEqual(self.as_stranger("post", "/api/sketches/create",
                                          {"from_document": str(self.holes.id)}).status_code, 403)

    def test_signed_out_is_refused(self):
        r = Client().post(f"/api/sketches/{self.layout.id}/run", content_type="application/json", data="{}")
        self.assertIn(r.status_code, (401, 403))

    def test_drawn_sketches_have_no_code_to_run(self):
        r = self.post(f"/api/sketches/{self.holes.id}/run", {})
        self.assertEqual(r.status_code, 400)
