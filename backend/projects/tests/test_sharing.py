import json

from django.test import Client, TestCase

from accounts.models import Organisation, User
from projects.models import Project, ProjectShare


class ProjectSharingAPITests(TestCase):
    def setUp(self):
        self.client = Client()
        self.org = Organisation.objects.create(name="Org A", slug="org-a")
        self.other_org = Organisation.objects.create(name="Org B", slug="org-b")
        self.user = User.objects.create_user(
            username="paul", email="paul@example.com", password="pass123",
            organisation=self.org,
        )
        self.other_user = User.objects.create_user(
            username="tony", email="tony@example.com", password="pass123",
            organisation=self.other_org,
        )
        self.project = Project.objects.create(
            name="My Project", organisation=self.org, created_by=self.user,
        )
        self.client.force_login(self.user)

    def test_share_by_email(self):
        resp = self.client.post(
            f"/api/projects/{self.project.id}/shares",
            data=json.dumps({"email": "tony@example.com"}),
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 201)
        data = resp.json()
        self.assertEqual(data["email"], "tony@example.com")
        self.assertEqual(data["username"], "tony")
        self.assertTrue(ProjectShare.objects.filter(project=self.project, user=self.other_user).exists())

    def test_share_nonexistent_email(self):
        resp = self.client.post(
            f"/api/projects/{self.project.id}/shares",
            data=json.dumps({"email": "nobody@example.com"}),
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 404)

    def test_share_duplicate(self):
        ProjectShare.objects.create(project=self.project, user=self.other_user)
        resp = self.client.post(
            f"/api/projects/{self.project.id}/shares",
            data=json.dumps({"email": "tony@example.com"}),
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 409)

    def test_list_shares(self):
        ProjectShare.objects.create(project=self.project, user=self.other_user)
        resp = self.client.get(f"/api/projects/{self.project.id}/shares")
        self.assertEqual(resp.status_code, 200)
        shares = resp.json()
        self.assertEqual(len(shares), 1)
        self.assertEqual(shares[0]["email"], "tony@example.com")

    def test_remove_share(self):
        share = ProjectShare.objects.create(project=self.project, user=self.other_user)
        resp = self.client.delete(f"/api/projects/{self.project.id}/shares/{share.id}")
        self.assertEqual(resp.status_code, 204)
        self.assertFalse(ProjectShare.objects.filter(id=share.id).exists())

    def test_shared_user_can_see_project(self):
        """User from another org can see a project shared with them."""
        ProjectShare.objects.create(project=self.project, user=self.other_user)
        self.client.force_login(self.other_user)
        resp = self.client.get(f"/api/projects/{self.project.id}")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["name"], "My Project")

    def test_shared_user_sees_project_in_list(self):
        """Shared project appears in the other user's project list."""
        ProjectShare.objects.create(project=self.project, user=self.other_user)
        self.client.force_login(self.other_user)
        resp = self.client.get("/api/projects/")
        self.assertEqual(resp.status_code, 200)
        names = [p["name"] for p in resp.json()]
        self.assertIn("My Project", names)

    def test_unshared_user_cannot_see_project(self):
        """User from another org cannot see a project NOT shared with them."""
        self.client.force_login(self.other_user)
        resp = self.client.get(f"/api/projects/{self.project.id}")
        self.assertEqual(resp.status_code, 403)

    def test_shared_user_sees_documents(self):
        """Documents in a shared project are visible to the shared user."""
        from documents.models import Document
        doc = Document.objects.create(
            name="Shared Doc", project=self.project, created_by=self.user,
            data={"id": "d1", "name": "T", "activeSketchId": "s1",
                  "sketches": [{"id": "s1", "name": "S", "visible": True, "entities": []}]},
        )
        ProjectShare.objects.create(project=self.project, user=self.other_user)
        self.client.force_login(self.other_user)
        # Can list documents
        resp = self.client.get("/api/documents/")
        self.assertEqual(resp.status_code, 200)
        ids = [d["id"] for d in resp.json()]
        self.assertIn(str(doc.id), ids)
        # Can get individual document
        resp = self.client.get(f"/api/documents/{doc.id}")
        self.assertEqual(resp.status_code, 200)
