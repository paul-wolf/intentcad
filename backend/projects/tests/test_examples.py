from django.test import Client, TestCase

from accounts.models import Organisation, User
from cam.models import CamJob
from documents.models import ContextFile, Document, DocumentAsset
from projects.models import Project


def context_file(**owner):
    return ContextFile.objects.create(
        filename="sheet.pdf", title="Datasheet", note="pins", content_type="application/pdf",
        size=4, sha256="f" * 64, data=b"%PDF", page_count=2, page_tokens=[10, 20],
        in_context=True, pages=[2], **owner)


class ExamplesTests(TestCase):
    def setUp(self):
        self.client = Client()
        self.intent = Organisation.objects.create(name="Intent", slug="intent")
        self.admin = User.objects.create_superuser(username="a", email="a@example.com", password="pw",
                                                   organisation=self.intent)
        self.src = Project.objects.create(name="Guide examples", description="Samples",
                                          organisation=self.intent, created_by=self.admin)
        context_file(project=self.src)
        part = Document.objects.create(name="Bracket", project=self.src, data={
            "name": "Bracket", "type": "part", "modelCode": "part = box(1, 1, 1)\n", "sketches": []})
        DocumentAsset.objects.create(document=part, sha256="abc", filename="board.step", size=3, data=b"stp")
        context_file(document=part)
        sketch = Document.objects.create(name="Tray", project=self.src,
                                         data={"name": "Tray", "type": "sketch", "sketches": []})
        CamJob.objects.create(document=sketch, name="Cut", config={"setup": {"stock": 2}}, gcode="G0", errors=["w"])
        self.client.force_login(self.admin)

    def choose(self, project_id):
        return self.client.put("/api/auth/manage/examples", {"project_id": project_id},
                               content_type="application/json")

    def create_org(self, slug="moom", **extra):
        return self.client.post("/api/auth/manage/organisations", {"name": slug.title(), "slug": slug, **extra},
                                content_type="application/json")

    def test_choose_the_examples_project(self):
        body = self.choose(str(self.src.id)).json()
        self.assertEqual(body["project"], {"id": str(self.src.id), "name": "Guide examples",
                                           "organisation": "Intent", "document_count": 2})
        self.assertEqual([c["id"] for c in body["choices"]], [str(self.src.id)])
        other = Project.objects.create(name="Other", organisation=self.intent)
        self.choose(str(other.id))
        self.assertEqual(list(Project.objects.filter(is_examples=True)), [other])   # only one is marked
        self.assertIsNone(self.choose(None).json()["project"])
        self.assertFalse(Project.objects.filter(is_examples=True).exists())

    def test_a_new_organisation_gets_a_copy(self):
        self.choose(str(self.src.id))
        resp = self.create_org()
        self.assertEqual(resp.status_code, 201)
        self.assertEqual(resp.json()["examples_note"], 'Added "Guide examples" to Moom: 1 part and 1 sketch')
        [copy] = Project.objects.filter(organisation__slug="moom")
        self.assertEqual((copy.name, copy.description, copy.created_by, copy.is_examples),
                         ("Guide examples", "Samples", self.admin, False))
        self.assertEqual(bytes(copy.context_files.get().data), b"%PDF")
        part, sketch = copy.documents.get(name="Bracket"), copy.documents.get(name="Tray")
        self.assertEqual(part.data["modelCode"], "part = box(1, 1, 1)\n")
        self.assertEqual([v.label for v in part.versions.all()], ["example"])
        self.assertEqual(part.assets.get().filename, "board.step")
        self.assertEqual(part.context_files.get().pages, [2])
        job = sketch.cam_jobs.get()
        self.assertEqual((job.config, job.gcode, job.errors), ({"setup": {"stock": 2}}, "", []))
        self.assertEqual(sketch.versions.count(), 0)
        self.assertEqual(self.src.documents.count(), 2)   # the source is untouched

    def test_skip_the_examples(self):
        self.choose(str(self.src.id))
        resp = self.create_org(add_examples=False)
        self.assertIsNone(resp.json()["examples_note"])
        self.assertFalse(Project.objects.filter(organisation__slug="moom").exists())

    def test_no_examples_project_chosen(self):
        resp = self.create_org()
        self.assertEqual(resp.status_code, 201)
        self.assertIsNone(resp.json()["examples_note"])
        self.assertFalse(Project.objects.filter(organisation__slug="moom").exists())

    def test_add_examples_to_an_existing_organisation(self):
        org = Organisation.objects.create(name="Default", slug="default")
        url = f"/api/auth/manage/organisations/{org.id}/examples"
        self.assertEqual(self.client.post(url).json()["message"], "No project is chosen as the examples")
        self.choose(str(self.src.id))
        resp = self.client.post(url)
        self.assertEqual(resp.status_code, 201)
        self.assertEqual(resp.json()["document_count"], 2)
        again = self.client.post(url)
        self.assertEqual(again.status_code, 400)
        self.assertEqual(again.json()["message"], 'Default already has a project called "Guide examples"')
        self.assertEqual(Project.objects.filter(organisation=org).count(), 1)

    def test_superusers_only(self):
        staff = User.objects.create_user(username="s", email="s@example.com", password="pw",
                                         organisation=self.intent, is_staff=True)
        self.client.force_login(staff)
        self.assertEqual(self.client.get("/api/auth/manage/examples").status_code, 403)
        self.assertEqual(self.choose(str(self.src.id)).status_code, 403)
        self.assertEqual(self.client.post(f"/api/auth/manage/organisations/{self.intent.id}/examples").status_code, 403)
        self.client.logout()
        self.assertEqual(self.client.get("/api/auth/manage/examples").status_code, 401)

    def test_unknown_project_is_404(self):
        self.assertEqual(self.choose("00000000-0000-0000-0000-000000000000").status_code, 404)
