import json

from django.test import Client, TestCase

from accounts.models import Organisation, User
from documents.models import Document
from projects.models import Project


class CamProfileAPITests(TestCase):
    def setUp(self):
        self.client = Client()
        self.org = Organisation.objects.create(name="Test Org", slug="test-org")
        self.user = User.objects.create_user(
            username="testuser",
            email="test@example.com",
            password="testpass123",
            organisation=self.org,
        )
        self.project = Project.objects.create(
            name="Test Project", organisation=self.org, created_by=self.user,
        )
        self.doc = Document.objects.create(name="Part", project=self.project, created_by=self.user)
        self.client.force_login(self.user)

    def _create(self, document_id, name="Router"):
        return self.client.post(
            "/api/cam/profiles/",
            data=json.dumps({
                "name": name,
                "config": {"tool": {"diameter": 3.175, "type": "flat"}},
                "document_id": str(document_id),
            }),
            content_type="application/json",
        )

    def test_new_profile_is_in_the_documents_project_and_listed(self):
        resp = self._create(self.doc.id)
        self.assertEqual(resp.status_code, 201)
        resp = self.client.get("/api/cam/profiles/")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual([p["name"] for p in resp.json()], ["Router"])

    def test_refuses_a_document_in_another_organisations_project(self):
        other_org = Organisation.objects.create(name="Other", slug="other")
        other_user = User.objects.create_user(
            username="other", email="other@example.com", password="testpass123", organisation=other_org,
        )
        other_project = Project.objects.create(name="Theirs", organisation=other_org, created_by=other_user)
        other_doc = Document.objects.create(name="Their part", project=other_project, created_by=other_user)
        resp = self._create(other_doc.id)
        self.assertEqual(resp.status_code, 403)
        self.assertEqual(self.client.get("/api/cam/profiles/").json(), [])

    def test_refuses_a_document_without_a_project(self):
        loose = Document.objects.create(name="Loose", created_by=self.user)
        resp = self._create(loose.id)
        self.assertEqual(resp.status_code, 400)
