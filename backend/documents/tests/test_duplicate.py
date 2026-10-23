from django.test import Client, TestCase

from accounts.models import Organisation, User, UserEvent
from cam.models import CamJob
from documents.api import copy_name
from documents.models import ContextFile, Document, DocumentAsset, DocumentVersion
from projects.models import Project


def part_data(name="Bracket"):
    return {
        "id": "doc_abc123", "name": name, "kind": "part",
        "activeSketchId": "sk_1",
        "sketches": [{"id": "sk_1", "name": "Sketch 1", "visible": True, "entities": []}],
        "modelCode": 'part = import_step(ASSETS["abc"])\n',
        "parameters": [{"name": "thickness", "value": 2}],
        "printBed": {"face": 3},
    }


def context_file(**owner):
    return ContextFile.objects.create(
        filename="sheet.pdf", title="Datasheet", note="pins", content_type="application/pdf",
        size=4, sha256="f" * 64, data=b"%PDF", page_count=2, page_tokens=[10, 20],
        in_context=True, pages=[2], **owner)


class DuplicateDocumentTests(TestCase):
    def setUp(self):
        self.client = Client()
        self.org = Organisation.objects.create(name="Org", slug="org")
        self.user = User.objects.create_user(username="u", email="u@example.com", password="pw", organisation=self.org)
        self.project = Project.objects.create(name="P", organisation=self.org, created_by=self.user)
        self.src = Document.objects.create(name="Bracket", data=part_data(), history={"undo": [1]},
                                           project=self.project, created_by=self.user)
        DocumentVersion.objects.create(document=self.src, data=self.src.data, label="old")
        DocumentAsset.objects.create(document=self.src, sha256="abc", filename="board.step", size=3, data=b"stp")
        context_file(document=self.src)
        context_file(project=self.project)
        CamJob.objects.create(document=self.src, name="Plate", config={"setup": {"stock": 2}},
                              gcode="G0 X0", errors=["warn"])
        self.client.force_login(self.user)

    def duplicate(self, doc=None):
        return self.client.post(f"/api/documents/{(doc or self.src).id}/duplicate")

    def test_copies_the_model_into_the_same_project(self):
        resp = self.duplicate()
        self.assertEqual(resp.status_code, 201)
        body = resp.json()
        self.assertNotEqual(body["id"], str(self.src.id))
        self.assertEqual(body["name"], "Copy of Bracket")
        copy = Document.objects.get(id=body["id"])
        self.assertEqual(copy.project, self.project)
        self.assertEqual(copy.created_by, self.user)
        self.assertEqual(copy.data["name"], "Copy of Bracket")   # autosave keeps the new name
        self.assertEqual({**copy.data, "name": "Bracket"}, self.src.data)
        self.assertEqual(copy.history, {})

    def test_starts_a_fresh_version_history(self):
        copy = Document.objects.get(id=self.duplicate().json()["id"])
        self.assertEqual([v.label for v in copy.versions.all()], ["copied from Bracket"])
        self.assertEqual(self.src.versions.count(), 1)

    def test_copies_step_assets_context_files_and_cam_jobs(self):
        copy = Document.objects.get(id=self.duplicate().json()["id"])
        [asset] = copy.assets.all()
        self.assertEqual((asset.sha256, asset.filename, bytes(asset.data)), ("abc", "board.step", b"stp"))
        [f] = copy.context_files.all()
        self.assertEqual((f.title, f.note, f.pages, f.page_tokens, bytes(f.data)), ("Datasheet", "pins", [2], [10, 20], b"%PDF"))
        self.assertEqual(ContextFile.objects.filter(project=self.project).count(), 1)   # project files stay shared
        [job] = copy.cam_jobs.all()
        self.assertEqual((job.name, job.config, job.gcode, job.errors), ("Plate", {"setup": {"stock": 2}}, "", []))
        self.assertEqual(self.src.cam_jobs.get().gcode, "G0 X0")

    def test_names_count_up_when_the_copy_name_is_taken(self):
        self.assertEqual(self.duplicate().json()["name"], "Copy of Bracket")
        self.assertEqual(self.duplicate().json()["name"], "Copy of Bracket (2)")
        self.assertEqual(self.duplicate().json()["name"], "Copy of Bracket (3)")
        self.assertEqual(copy_name("x" * 255, set()), "Copy of " + "x" * 247)

    def test_records_a_created_event(self):
        body = self.duplicate().json()
        ev = UserEvent.objects.get(kind=UserEvent.DOCUMENT_CREATED)
        self.assertEqual(ev.document_id, body["id"])
        self.assertEqual(ev.detail, {"duplicated_from": str(self.src.id)})

    def test_another_organisation_cannot_duplicate(self):
        other_org = Organisation.objects.create(name="Other", slug="other")
        outsider = User.objects.create_user(username="o", email="o@example.com", password="pw", organisation=other_org)
        self.client.force_login(outsider)
        self.assertEqual(self.duplicate().status_code, 403)
        self.assertEqual(Document.objects.count(), 1)

    def test_needs_a_login(self):
        self.client.logout()
        self.assertEqual(self.duplicate().status_code, 401)

    def test_missing_document_is_404(self):
        self.assertEqual(self.client.post("/api/documents/00000000-0000-0000-0000-000000000000/duplicate").status_code, 404)
