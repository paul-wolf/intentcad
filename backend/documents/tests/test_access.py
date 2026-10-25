"""Who may open a document, CAM profile or context file that is in no project:
only its creator, or a superuser (not every signed-in user)."""

import json

from django.test import Client, TestCase

from accounts.models import Organisation, User
from cam.models import CamJob, CamProfile
from documents.models import ContextFile, Document


class NoProjectAccessTests(TestCase):
    def setUp(self):
        org = Organisation.objects.create(name="Org", slug="org")
        self.owner = User.objects.create_user(username="a", email="a@example.com", password="pw",
                                              organisation=org)
        self.doc = Document.objects.create(name="Loose", data={}, created_by=self.owner)
        self.as_owner, self.as_other, self.as_admin = Client(), Client(), Client()
        self.as_owner.force_login(self.owner)
        # same organisation: the project check never applied, as there is no project
        self.as_other.force_login(User.objects.create_user(
            username="b", email="b@example.com", password="pw", organisation=org))
        self.as_admin.force_login(User.objects.create_superuser(
            username="root", email="root@example.com", password="pw"))

    def status(self, client, method, url, **data):
        kw = {"content_type": "application/json", "data": json.dumps(data)} if data else {}
        return getattr(client, method)(url, **kw).status_code

    def test_only_the_creator_and_a_superuser_open_a_document_in_no_project(self):
        url = f"/api/documents/{self.doc.id}"
        self.assertEqual(self.status(self.as_owner, "get", url), 200)
        self.assertEqual(self.status(self.as_admin, "get", url), 200)
        self.assertEqual(self.status(self.as_other, "get", url), 403)
        self.assertEqual(self.status(self.as_other, "put", url, name="Mine now"), 403)
        self.assertEqual(self.status(self.as_other, "get", f"{url}/versions"), 403)
        self.assertEqual(self.status(self.as_other, "delete", url), 403)
        self.assertTrue(Document.objects.filter(id=self.doc.id, name="Loose").exists())

    def test_nor_build_it_or_its_cam_jobs(self):
        r = self.as_other.post("/api/build/run", content_type="application/json", data=json.dumps(
            {"code": "part = Box(1, 1, 1)", "document_id": str(self.doc.id)}))
        self.assertEqual(r.status_code, 403)
        job = CamJob.objects.create(document=self.doc, name="Job")
        self.assertEqual(self.status(self.as_other, "get", f"/api/cam/jobs/{job.id}"), 403)
        self.assertEqual(self.status(self.as_owner, "get", f"/api/cam/jobs/{job.id}"), 200)

    def test_a_cam_profile_in_no_project_is_its_creators(self):
        profile = CamProfile.objects.create(name="Old", config={}, created_by=self.owner)
        url = f"/api/cam/profiles/{profile.id}"
        self.assertEqual(self.status(self.as_other, "get", url), 403)
        self.assertEqual(self.status(self.as_owner, "get", url), 200)

    def test_a_context_file_on_a_document_in_no_project_is_its_creators(self):
        cf = ContextFile.objects.create(document=self.doc, filename="sheet.pdf", title="Sheet",
                                        content_type="application/pdf", data=b"%PDF-1.4",
                                        size=8, sha256="0" * 64)
        self.assertEqual(self.status(self.as_other, "get", f"/api/context/{cf.id}"), 403)
        self.assertEqual(self.status(self.as_owner, "get", f"/api/context/{cf.id}"), 200)
