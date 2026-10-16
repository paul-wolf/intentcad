"""Uploaded STEP files (DocumentAsset) and scripts that import them by hash."""

import hashlib
import json
from unittest import mock

from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import Client, TestCase

from accounts.models import Organisation, User
from documents.models import Document, DocumentAsset
from modeling.engine import run_script
from projects.models import Project

_STEP: bytes | None = None


def box_step() -> bytes:
    """A small STEP file, made by exporting a build123d box (off-center, so
    placing it on the build plate has something to do)."""
    global _STEP
    if _STEP is None:
        r = run_script("part = Pos(50, 20, 7) * Box(30, 20, 10)", export=["step"])
        _STEP = r["exports"]["step"].encode()
    return _STEP


class AssetAPITests(TestCase):
    def setUp(self):
        self.client = Client()
        self.org = Organisation.objects.create(name="Org", slug="org")
        self.user = User.objects.create_user(username="u", email="u@example.com", password="pw", organisation=self.org)
        self.project = Project.objects.create(name="P", organisation=self.org, created_by=self.user)
        self.doc = Document.objects.create(name="D", data={}, project=self.project, created_by=self.user)
        self.client.force_login(self.user)
        self.url = f"/api/documents/{self.doc.id}/assets"

    def upload(self, data: bytes, name: str = "bracket.step", client=None):
        f = SimpleUploadedFile(name, data, content_type="application/step")
        return (client or self.client).post(self.url, {"file": f})

    def test_upload_stores_the_file_and_reports_it_placed_on_the_plate(self):
        data = box_step()
        resp = self.upload(data)
        self.assertEqual(resp.status_code, 201, resp.content)
        body = resp.json()
        self.assertEqual(body["sha256"], hashlib.sha256(data).hexdigest())
        self.assertEqual(body["filename"], "bracket.step")
        self.assertEqual(body["size"], len(data))
        self.assertEqual(body["face_count"], 6)
        lo, hi = body["bbox"]["min"], body["bbox"]["max"]
        for got, want in zip(lo + hi, [-15, -10, 0, 15, 10, 10]):   # centered in XY, on Z=0
            self.assertAlmostEqual(got, want, places=4)
        asset = DocumentAsset.objects.get(document=self.doc)
        self.assertEqual(bytes(asset.data), data)
        self.assertEqual(asset.created_by, self.user)

    def test_same_bytes_return_the_stored_asset(self):
        self.assertEqual(self.upload(box_step()).status_code, 201)
        resp = self.upload(box_step(), name="again.stp")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["filename"], "bracket.step")   # the first upload's
        self.assertEqual(DocumentAsset.objects.filter(document=self.doc).count(), 1)

    def test_stl_is_refused_as_not_supported_yet(self):
        resp = self.upload(b"solid x\nendsolid x\n", name="part.STL")
        self.assertEqual(resp.status_code, 415)
        self.assertIn("STL import isn't supported yet", resp.json()["message"])
        self.assertFalse(DocumentAsset.objects.exists())

    def test_other_types_are_refused(self):
        resp = self.upload(box_step(), name="part.obj")
        self.assertEqual(resp.status_code, 415)
        self.assertIn(".step/.stp", resp.json()["message"])

    def test_a_step_name_without_step_content_is_refused(self):
        resp = self.upload(b"hello", name="fake.step")
        self.assertEqual(resp.status_code, 415)
        self.assertIn("not a STEP file", resp.json()["message"])

    def test_a_step_the_engine_cannot_read_is_refused_with_its_error(self):
        resp = self.upload(b"ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n")
        self.assertEqual(resp.status_code, 422)
        self.assertIn("Couldn't import bracket.step", resp.json()["message"])
        self.assertFalse(DocumentAsset.objects.exists())

    def test_size_limit(self):
        with mock.patch("documents.api.MAX_ASSET_BYTES", 1000):
            resp = self.upload(box_step())
        self.assertEqual(resp.status_code, 413)
        self.assertIn("limit", resp.json()["message"])

    def test_filename_is_made_safe_for_a_script_comment(self):
        resp = self.upload(box_step(), name="evil\nimport os.step")
        self.assertEqual(resp.status_code, 201)
        self.assertNotIn("\n", resp.json()["filename"])

    def test_list_is_metadata_only(self):
        self.upload(box_step())
        resp = self.client.get(self.url)
        self.assertEqual(resp.status_code, 200)
        [row] = resp.json()
        self.assertEqual(set(row), {"sha256", "filename", "content_type", "size", "created_at"})

    def test_other_users_are_denied(self):
        other_org = Organisation.objects.create(name="Other", slug="other")
        other = User.objects.create_user(username="o", email="o@example.com", password="pw", organisation=other_org)
        c = Client()
        c.force_login(other)
        self.assertEqual(self.upload(box_step(), client=c).status_code, 403)
        self.assertEqual(c.get(self.url).status_code, 403)
        self.assertFalse(DocumentAsset.objects.exists())

    def test_login_required(self):
        self.assertEqual(Client().get(self.url).status_code, 401)


class AssetBuildTests(TestCase):
    """/build/* resolve ASSETS["<sha256>"] against the request's document."""

    def setUp(self):
        self.org = Organisation.objects.create(name="Org", slug="org")
        self.user = User.objects.create_user(username="u", email="u@example.com", password="pw", organisation=self.org)
        project = Project.objects.create(name="P", organisation=self.org, created_by=self.user)
        self.doc = Document.objects.create(name="D", data={}, project=project, created_by=self.user)
        data = box_step()
        self.sha = hashlib.sha256(data).hexdigest()
        DocumentAsset.objects.create(document=self.doc, sha256=self.sha, filename="b.step",
                                     size=len(data), data=data, created_by=self.user)
        self.client = Client()
        self.client.force_login(self.user)
        self.code = f'P = dict(h=4)\npart = import_step(ASSETS["{self.sha}"]) - Pos(50, 20, 0) * Cylinder(P["h"], 100)'

    def post(self, path, body, client=None):
        return (client or self.client).post(f"/api/build/{path}", json.dumps(body),
                                            content_type="application/json")

    def test_run_builds_the_imported_file(self):
        resp = self.post("run", {"code": self.code, "document_id": str(self.doc.id)})
        self.assertEqual(resp.status_code, 200, resp.content)
        self.assertGreater(len(resp.json()["faces"]), 6)   # the box, now with a hole

    def test_export_and_sensitivity_resolve_it_too(self):
        resp = self.post("export", {"code": self.code, "format": "step", "document_id": str(self.doc.id)})
        self.assertEqual(resp.status_code, 200, resp.content)
        self.assertTrue(resp.json()["data"].startswith("ISO-10303-21;"))
        resp = self.post("sensitivity", {"code": self.code, "document_id": str(self.doc.id)})
        self.assertEqual(resp.status_code, 200, resp.content)
        self.assertTrue(resp.json()["params"]["h"]["faces"])   # the hole moves with h

    def test_a_hash_the_document_lacks_is_an_error_naming_it(self):
        missing = "ab" * 32
        resp = self.post("run", {"code": f'part = import_step(ASSETS["{missing}"])',
                                 "document_id": str(self.doc.id)})
        self.assertEqual(resp.status_code, 422)
        self.assertIn(missing, resp.json()["message"])

    def test_another_documents_file_does_not_resolve(self):
        other = Document.objects.create(name="E", data={}, project=self.doc.project)
        resp = self.post("run", {"code": self.code, "document_id": str(other.id)})
        self.assertEqual(resp.status_code, 422)
        self.assertIn(self.sha, resp.json()["message"])

    def test_without_a_document_it_is_an_error(self):
        resp = self.post("run", {"code": self.code})
        self.assertEqual(resp.status_code, 422)
        self.assertIn("no document", resp.json()["message"])

    def test_other_users_cannot_build_against_the_document(self):
        other_org = Organisation.objects.create(name="Other", slug="other")
        other = User.objects.create_user(username="o", email="o@example.com", password="pw", organisation=other_org)
        c = Client()
        c.force_login(other)
        for path, extra in (("run", {}), ("export", {"format": "step"}), ("sensitivity", {}),
                            ("edit", {"instruction": "x"})):
            resp = self.post(path, {"code": self.code, "document_id": str(self.doc.id), **extra}, client=c)
            self.assertEqual(resp.status_code, 403, path)

    def test_a_malformed_document_id_is_not_found(self):
        resp = self.post("run", {"code": "part = Box(1, 1, 1)", "document_id": "doc_123"})
        self.assertEqual(resp.status_code, 404)
