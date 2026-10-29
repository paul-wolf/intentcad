import json

from django.test import Client, TestCase

from accounts.models import Organisation, User
from projects.models import Project


def _valid_doc_data():
    return {
        "id": "doc_abc123",
        "name": "Test",
        "activeSketchId": "sk_abc123",
        "sketches": [
            {
                "id": "sk_abc123",
                "name": "Sketch 1",
                "visible": True,
                "entities": [],
            }
        ],
    }


class DocumentAPITests(TestCase):
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
        self.client.force_login(self.user)

    def test_create_and_get(self):
        resp = self.client.post(
            "/api/documents/",
            data=json.dumps({"name": "Test Doc", "data": _valid_doc_data()}),
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 201)
        doc_id = resp.json()["id"]

        resp = self.client.get(f"/api/documents/{doc_id}")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["name"], "Test Doc")

    def test_list(self):
        self.client.post(
            "/api/documents/",
            data=json.dumps({"name": "Doc 1", "data": _valid_doc_data(), "project_id": str(self.project.id)}),
            content_type="application/json",
        )
        resp = self.client.get("/api/documents/")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(len(resp.json()), 1)

    def test_update(self):
        resp = self.client.post(
            "/api/documents/",
            data=json.dumps({"name": "Original", "data": _valid_doc_data()}),
            content_type="application/json",
        )
        doc_id = resp.json()["id"]

        resp = self.client.put(
            f"/api/documents/{doc_id}",
            data=json.dumps({"name": "Updated"}),
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["name"], "Updated")

    def test_move_to_another_project(self):
        other = Project.objects.create(name="Other", organisation=self.org, created_by=self.user)
        resp = self.client.post(
            "/api/documents/",
            data=json.dumps({"name": "Doc", "data": _valid_doc_data(), "project_id": str(self.project.id)}),
            content_type="application/json",
        )
        doc_id = resp.json()["id"]

        resp = self.client.put(
            f"/api/documents/{doc_id}",
            data=json.dumps({"project_id": str(other.id)}),
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["project_id"], str(other.id))

    def test_saving_new_code_creates_immutable_versions(self):
        from documents.models import DocumentVersion
        d = dict(_valid_doc_data(), modelCode="part = Box(1,1,1)")
        resp = self.client.post("/api/documents/",
                                data=json.dumps({"name": "P", "data": d}), content_type="application/json")
        doc_id = resp.json()["id"]
        self.assertEqual(DocumentVersion.objects.filter(document_id=doc_id).count(), 1)  # created
        # a save with new code → a new version
        d2 = dict(d, modelCode="part = Box(2,2,2)")
        self.client.put(f"/api/documents/{doc_id}",
                        data=json.dumps({"data": d2}), content_type="application/json")
        self.assertEqual(DocumentVersion.objects.filter(document_id=doc_id).count(), 2)
        # a save with the SAME code → no duplicate version
        self.client.put(f"/api/documents/{doc_id}",
                        data=json.dumps({"data": d2}), content_type="application/json")
        self.assertEqual(DocumentVersion.objects.filter(document_id=doc_id).count(), 2)

    def test_long_version_label_is_clipped_to_the_column(self):
        # Postgres rejects a label over varchar(200) (sqlite doesn't check), so
        # a long AI summary used to 500 the save
        from documents.models import DocumentVersion
        d = dict(_valid_doc_data(), modelCode="part = Box(1,1,1)")
        doc_id = self.client.post("/api/documents/", data=json.dumps({"name": "P", "data": d}),
                                  content_type="application/json").json()["id"]
        resp = self.client.put(f"/api/documents/{doc_id}",
                               data=json.dumps({"data": dict(d, modelCode="part = Box(2,2,2)"),
                                                "version_label": "Added a hole. " * 30}),
                               content_type="application/json")
        self.assertEqual(resp.status_code, 200)
        label = DocumentVersion.objects.filter(document_id=doc_id).first().label
        self.assertEqual(len(label), 200)
        self.assertTrue(label.startswith("Added a hole. Added"))
        self.assertTrue(label.endswith("…"))

    def test_draft_save_does_not_create_a_version(self):
        from documents.models import DocumentVersion
        d = dict(_valid_doc_data(), modelCode="part = Box(1,1,1)")
        resp = self.client.post("/api/documents/",
                                data=json.dumps({"name": "P", "data": d}), content_type="application/json")
        doc_id = resp.json()["id"]
        self.assertEqual(DocumentVersion.objects.filter(document_id=doc_id).count(), 1)  # created
        # an in-progress draft (snapshot=False) persists but must NOT add a version
        self.client.put(f"/api/documents/{doc_id}",
                        data=json.dumps({"data": dict(d, modelCode="part = Box(2,2,2)"), "snapshot": False}),
                        content_type="application/json")
        self.assertEqual(DocumentVersion.objects.filter(document_id=doc_id).count(), 1)
        # the draft's code is still saved on the document
        self.assertEqual(self.client.get(f"/api/documents/{doc_id}").json()["data"]["modelCode"], "part = Box(2,2,2)")
        # a build-verified save (snapshot=True, the default) does add one
        self.client.put(f"/api/documents/{doc_id}",
                        data=json.dumps({"data": dict(d, modelCode="part = Box(3,3,3)")}),
                        content_type="application/json")
        self.assertEqual(DocumentVersion.objects.filter(document_id=doc_id).count(), 2)

    def test_stale_save_is_rejected(self):
        d = dict(_valid_doc_data(), modelCode="part = Box(1,1,1)")
        resp = self.client.post("/api/documents/",
                                data=json.dumps({"name": "P", "data": d}), content_type="application/json")
        doc_id = resp.json()["id"]
        # a client whose base is far in the past must not overwrite
        stale = self.client.put(
            f"/api/documents/{doc_id}",
            data=json.dumps({"data": dict(d, modelCode="part = Box(9,9,9)"),
                             "base_updated_at": "2020-01-01T00:00:00+00:00"}),
            content_type="application/json")
        self.assertEqual(stale.status_code, 409)

    def test_a_script_changed_elsewhere_is_never_overwritten(self):
        """code_base: the script version this client had. Two tabs open the
        part; one saves a new script, then the other saves."""
        d = dict(_valid_doc_data(), modelCode="part = Box(1,1,1)")
        doc_id = self.client.post("/api/documents/", data=json.dumps({"name": "P", "data": d}),
                                  content_type="application/json").json()["id"]
        put = lambda body: self.client.put(f"/api/documents/{doc_id}", data=json.dumps(body),
                                           content_type="application/json")
        base = self.client.get(f"/api/documents/{doc_id}").json()["code_version"]
        mine = put({"data": dict(d, modelCode="part = Box(2,2,2)"), "code_base": base})
        self.assertEqual(mine.status_code, 200)
        newer = mine.json()["code_version"]
        self.assertNotEqual(newer, base)
        # the other tab changes the script too: refused, the newer one stays
        theirs = put({"data": dict(d, modelCode="part = Box(9,9,9)"), "code_base": base})
        self.assertEqual(theirs.status_code, 409)
        self.assertTrue(theirs.json()["code_changed"])
        # the other tab saves its chat (its old script with it): the chat is saved, the newer script kept
        chat = put({"data": dict(d, modelCode="part = Box(1,1,1)", chat=[{"role": "user", "text": "hi", "at": 1}]),
                    "code_base": base})
        self.assertEqual(chat.status_code, 200)
        self.assertEqual(chat.json()["data"]["modelCode"], "part = Box(2,2,2)")
        self.assertEqual(chat.json()["data"]["chat"][0]["text"], "hi")
        self.assertEqual(chat.json()["code_version"], newer)
        # with the newer version as its base, it saves
        ok = put({"data": dict(d, modelCode="part = Box(3,3,3)"), "code_base": newer})
        self.assertEqual(ok.status_code, 200)
        self.assertEqual(ok.json()["data"]["modelCode"], "part = Box(3,3,3)")
        # a save without a base is as before (no check)
        self.assertEqual(put({"data": dict(d, modelCode="part = Box(4,4,4)")}).status_code, 200)

    def test_delete(self):
        resp = self.client.post(
            "/api/documents/",
            data=json.dumps({"name": "To Delete", "data": _valid_doc_data()}),
            content_type="application/json",
        )
        doc_id = resp.json()["id"]

        resp = self.client.delete(f"/api/documents/{doc_id}")
        self.assertEqual(resp.status_code, 204)

        resp = self.client.get(f"/api/documents/{doc_id}")
        self.assertEqual(resp.status_code, 404)

    def test_create_invalid_data(self):
        resp = self.client.post(
            "/api/documents/",
            data=json.dumps({"name": "Bad", "data": {"bad": True}}),
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 422)
