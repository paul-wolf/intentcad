"""Context files: reference PDFs and images on a project or a part, and the
content blocks the AI gets for them."""

import base64
import io
import json
from unittest import mock

from django.core.files.uploadedfile import SimpleUploadedFile
from django.db import IntegrityError, transaction
from django.test import Client, TestCase
from PIL import Image
from pypdf import PdfReader, PdfWriter

from accounts.models import Organisation, User
from documents import context
from documents.models import ContextFile, ContextThumbnail, Document
from modeling import llm_models
from projects.models import Project


def make_pdf(widths=(200, 300, 400, 500), password=None, owner_only=False) -> bytes:
    """A blank PDF with one page per width (so page order is checkable)."""
    w = PdfWriter()
    for width in widths:
        w.add_blank_page(width=width, height=600)
    if password is not None:
        w.encrypt(user_password="" if owner_only else password, owner_password=password)
    buf = io.BytesIO()
    w.write(buf)
    return buf.getvalue()


def make_image(w=3200, h=2400, fmt="PNG") -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (w, h), (200, 30, 30)).save(buf, fmt)
    return buf.getvalue()


def page_widths(pdf: bytes) -> list[int]:
    return [round(float(p.mediabox.width)) for p in PdfReader(io.BytesIO(pdf)).pages]


class ContextFileAPITests(TestCase):
    def setUp(self):
        self.client = Client()
        self.org = Organisation.objects.create(name="Org", slug="org")
        self.user = User.objects.create_user(username="u", email="u@example.com", password="pw",
                                             organisation=self.org)
        self.project = Project.objects.create(name="P", organisation=self.org, created_by=self.user)
        self.doc = Document.objects.create(name="Case", data={}, project=self.project,
                                           created_by=self.user)
        self.client.force_login(self.user)
        other_org = Organisation.objects.create(name="Other", slug="other")
        self.outsider = Client()
        self.outsider.force_login(User.objects.create_user(
            username="o", email="o@example.com", password="pw", organisation=other_org))

    def upload(self, data, name="datasheet.pdf", client=None, **owner):
        owner = owner or {"project": self.project.id}
        q = "&".join(f"{k}={v}" for k, v in owner.items())
        f = SimpleUploadedFile(name, data, content_type="application/octet-stream")
        return (client or self.client).post(f"/api/context/?{q}", {"file": f, "note": " rev B "})

    # storage and listing

    def test_upload_a_pdf_to_the_project(self):
        r = self.upload(make_pdf())
        self.assertEqual(r.status_code, 201, r.content)
        d = r.json()
        self.assertEqual(d["scope"], "project")
        self.assertEqual((d["title"], d["filename"], d["note"]), ("datasheet.pdf", "datasheet.pdf", "rev B"))
        self.assertEqual(d["content_type"], "application/pdf")
        self.assertEqual(d["page_count"], 4)
        self.assertTrue(d["in_context"])
        self.assertIsNone(d["pages"])
        self.assertEqual(len(d["page_tokens"]), 4)
        self.assertEqual(d["est_tokens"], sum(d["page_tokens"]))
        cf = ContextFile.objects.get(id=d["id"])
        self.assertEqual(len(cf.sha256), 64)
        self.assertEqual(cf.created_by, self.user)

    def test_upload_an_image_to_the_part(self):
        r = self.upload(make_image(), name="board.png", document=self.doc.id)
        self.assertEqual(r.status_code, 201, r.content)
        d = r.json()
        self.assertEqual((d["scope"], d["content_type"]), ("part", "image/png"))
        self.assertEqual((d["width"], d["height"]), (3200, 2400))
        self.assertIsNone(d["page_count"])
        # tokens as sent: downscaled to 1600 × 1200
        self.assertEqual(d["est_tokens"], context.image_tokens(3200, 2400))
        self.assertEqual(d["est_tokens"], 58 * 43)

    def test_the_same_bytes_again_return_the_stored_file(self):
        first = self.upload(make_pdf()).json()
        r = self.upload(make_pdf(), name="copy.pdf")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["id"], first["id"])
        self.assertEqual(ContextFile.objects.count(), 1)

    def test_a_part_lists_its_files_and_its_projects(self):
        self.upload(make_pdf())
        self.upload(make_image(), name="board.jpg", document=self.doc.id)
        other = Document.objects.create(name="Lid", data={}, project=self.project, created_by=self.user)
        self.upload(make_image(40, 40), name="lid.png", document=other.id)
        d = self.client.get(f"/api/context/?document={self.doc.id}").json()
        self.assertEqual([f["title"] for f in d["part"]], ["board.jpg"])
        self.assertEqual([f["title"] for f in d["project"]], ["datasheet.pdf"])
        self.assertEqual(d["project_id"], str(self.project.id))
        p = self.client.get(f"/api/context/?project={self.project.id}").json()
        self.assertEqual(([f["title"] for f in p["project"]], p["part"]), (["datasheet.pdf"], []))

    def test_owner_must_be_exactly_one(self):
        r = self.client.get(f"/api/context/?project={self.project.id}&document={self.doc.id}")
        self.assertEqual(r.status_code, 400)
        self.assertEqual(self.client.get("/api/context/").status_code, 400)
        with self.assertRaises(IntegrityError), transaction.atomic():
            ContextFile.objects.create(filename="x.pdf", title="x", content_type="application/pdf",
                                       size=1, sha256="0", data=b"x")
        with self.assertRaises(IntegrityError), transaction.atomic():
            ContextFile.objects.create(project=self.project, document=self.doc, filename="x.pdf",
                                       title="x", content_type="application/pdf", size=1,
                                       sha256="0", data=b"x")

    def test_download_returns_the_bytes(self):
        data = make_pdf()
        fid = self.upload(data).json()["id"]
        r = self.client.get(f"/api/context/{fid}/file")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r["Content-Type"], "application/pdf")
        self.assertIn('filename="datasheet.pdf"', r["Content-Disposition"])
        self.assertEqual(r.content, data)

    def test_thumbnails_render_pages_and_are_cached(self):
        fid = self.upload(make_pdf()).json()["id"]
        r = self.client.get(f"/api/context/{fid}/thumbnail?page=3&width=300")
        self.assertEqual((r.status_code, r["Content-Type"]), (200, "image/jpeg"))
        img = Image.open(io.BytesIO(r.content))
        self.assertEqual(img.width, 320)        # the standard width at or above 300
        self.assertEqual(img.height, round(320 * 600 / 400))   # page 3 is 400 × 600
        self.client.get(f"/api/context/{fid}/thumbnail?page=3&width=300")
        self.assertEqual(ContextThumbnail.objects.count(), 1)
        self.assertEqual(self.client.get(f"/api/context/{fid}/thumbnail?page=5").status_code, 404)

    def test_image_thumbnail_is_downscaled(self):
        fid = self.upload(make_image(), name="b.png", document=self.doc.id).json()["id"]
        r = self.client.get(f"/api/context/{fid}/thumbnail?width=160")
        self.assertEqual(Image.open(io.BytesIO(r.content)).size, (160, 120))

    def test_rename_annotate_toggle_and_choose_pages(self):
        fid = self.upload(make_pdf()).json()["id"]
        url = f"/api/context/{fid}"

        def patch(body):
            return self.client.patch(url, data=json.dumps(body), content_type="application/json")

        d = patch({"title": "Carrier datasheet", "note": "rev B", "in_context": False}).json()
        self.assertEqual((d["title"], d["note"], d["in_context"]), ("Carrier datasheet", "rev B", False))
        self.assertEqual(d["filename"], "datasheet.pdf")
        d = patch({"pages": [3, 1, 3]}).json()
        self.assertEqual(d["pages"], [1, 3])
        self.assertEqual(d["est_tokens"], d["page_tokens"][0] + d["page_tokens"][2])
        self.assertIsNone(patch({"pages": [1, 2, 3, 4]}).json()["pages"])   # all = None
        patch({"pages": [2]})
        self.assertIsNone(patch({"all_pages": True}).json()["pages"])
        self.assertEqual(patch({"pages": [5]}).status_code, 422)
        self.assertEqual(patch({"title": "  "}).status_code, 422)

    def test_delete(self):
        fid = self.upload(make_pdf()).json()["id"]
        self.client.get(f"/api/context/{fid}/thumbnail")
        self.assertEqual(self.client.delete(f"/api/context/{fid}").status_code, 204)
        self.assertFalse(ContextFile.objects.exists())
        self.assertFalse(ContextThumbnail.objects.exists())

    def test_files_go_with_their_owner(self):
        self.upload(make_pdf())
        self.upload(make_image(), name="b.png", document=self.doc.id)
        self.doc.delete()
        self.assertEqual(ContextFile.objects.count(), 1)
        self.project.delete()
        self.assertFalse(ContextFile.objects.exists())

    # access

    def test_needs_login(self):
        anon = Client()
        self.assertEqual(anon.get(f"/api/context/?project={self.project.id}").status_code, 401)
        self.assertEqual(self.upload(make_pdf(), client=anon).status_code, 401)

    def test_other_organisations_are_refused(self):
        fid = self.upload(make_pdf()).json()["id"]
        o = self.outsider
        self.assertEqual(o.get(f"/api/context/?project={self.project.id}").status_code, 403)
        self.assertEqual(o.get(f"/api/context/?document={self.doc.id}").status_code, 403)
        self.assertEqual(self.upload(make_pdf((10,)), client=o).status_code, 403)
        self.assertEqual(self.upload(make_pdf((10,)), client=o, document=self.doc.id).status_code, 403)
        self.assertEqual(o.get(f"/api/context/{fid}").status_code, 403)
        self.assertEqual(o.get(f"/api/context/{fid}/file").status_code, 403)
        self.assertEqual(o.get(f"/api/context/{fid}/thumbnail").status_code, 403)
        self.assertEqual(o.patch(f"/api/context/{fid}", data=json.dumps({"title": "x"}),
                                 content_type="application/json").status_code, 403)
        self.assertEqual(o.delete(f"/api/context/{fid}").status_code, 403)
        self.assertEqual(ContextFile.objects.get(id=fid).title, "datasheet.pdf")

    # type and size limits

    def test_other_types_are_refused_by_content_not_name(self):
        r = self.upload(b"just some text", name="notes.pdf")
        self.assertEqual(r.status_code, 415)
        self.assertIn("isn't a PDF, PNG, JPEG or WebP", r.json()["message"])
        r = self.upload(make_image(fmt="GIF"), name="anim.gif")
        self.assertEqual(r.status_code, 415)
        # a JPEG named .png is a JPEG
        r = self.upload(make_image(20, 20, "JPEG"), name="photo.png", document=self.doc.id)
        self.assertEqual(r.json()["content_type"], "image/jpeg")

    def test_webp_is_accepted(self):
        r = self.upload(make_image(64, 32, "WEBP"), name="b.webp", document=self.doc.id)
        self.assertEqual((r.status_code, r.json()["content_type"]), (201, "image/webp"))

    def test_too_large_is_refused(self):
        big = b"%PDF-" + b"0" * (25 * 1024 * 1024)
        r = self.upload(big, name="huge.pdf")
        self.assertEqual(r.status_code, 413)
        self.assertIn("the limit is 25 MB", r.json()["message"])

    def test_password_protected_pdf_is_refused(self):
        r = self.upload(make_pdf(password="secret"), name="locked.pdf")
        self.assertEqual(r.status_code, 415)
        self.assertIn("password-protected", r.json()["message"])

    def test_owner_password_pdf_is_stored_decrypted(self):
        r = self.upload(make_pdf(password="secret", owner_only=True), name="nocopy.pdf")
        self.assertEqual(r.status_code, 201, r.content)
        cf = ContextFile.objects.get(id=r.json()["id"])
        self.assertFalse(PdfReader(io.BytesIO(bytes(cf.data))).is_encrypted)
        self.assertEqual(cf.page_count, 4)

    def test_heic_photo_is_stored_as_jpeg(self):
        import pillow_heif
        pillow_heif.register_heif_opener()
        buf = io.BytesIO()
        try:
            Image.new("RGB", (64, 48), (10, 120, 200)).save(buf, "HEIF")
        except (KeyError, OSError, ValueError) as exc:
            self.skipTest(f"no HEIF encoder here: {exc}")
        r = self.upload(buf.getvalue(), name="IMG_0412.HEIC", document=self.doc.id)
        self.assertEqual(r.status_code, 201, r.content)
        d = r.json()
        self.assertEqual((d["filename"], d["content_type"]), ("IMG_0412.jpg", "image/jpeg"))
        self.assertEqual((d["width"], d["height"]), (64, 48))


class AIBlockTests(TestCase):
    """What the AI is sent for the context files."""

    def setUp(self):
        org = Organisation.objects.create(name="Org", slug="org")
        self.user = User.objects.create_user(username="u", email="u@example.com", password="pw",
                                             organisation=org)
        self.project = Project.objects.create(name="P", organisation=org, created_by=self.user)

    def add(self, data, name, **kw):
        got = context.ingest(data, name)
        return ContextFile.objects.create(
            project=self.project, filename=got.filename, title=kw.pop("title", got.filename),
            content_type=got.content_type, size=len(got.data), sha256=got.sha256, data=got.data,
            page_count=got.page_count, width=got.width, height=got.height,
            page_tokens=got.page_tokens, **kw)

    def test_page_selection_sends_only_those_pages(self):
        self.assertEqual(page_widths(context.pdf_with_pages(make_pdf(), [2, 4])), [300, 500])
        cf = self.add(make_pdf(), "sheet.pdf", pages=[2, 3])
        p = context.ai_blocks([cf])
        (b,) = p.blocks
        self.assertEqual(b["type"], "document")
        self.assertEqual(b["source"]["media_type"], "application/pdf")
        self.assertEqual(page_widths(base64.b64decode(b["source"]["data"])), [300, 400])
        self.assertIn("pages 2–3 of 4", p.listing[0])
        self.assertIn("its page 1 is p.2", p.listing[0])

    def test_all_pages_send_the_file_as_stored(self):
        cf = self.add(make_pdf(), "sheet.pdf", note="rev B")
        p = context.ai_blocks([cf])
        self.assertEqual(base64.b64decode(p.blocks[0]["source"]["data"]), bytes(cf.data))
        self.assertEqual(p.listing, ["1. sheet.pdf: all 4 pages — note: rev B"])

    def test_images_are_downscaled_for_the_ai_and_the_original_kept(self):
        cf = self.add(make_image(3200, 2400, "JPEG"), "IMG_0412.jpg", title="Board photo")
        (b,) = context.ai_blocks([cf]).blocks
        self.assertEqual((b["type"], b["source"]["media_type"]), ("image", "image/jpeg"))
        sent = Image.open(io.BytesIO(base64.b64decode(b["source"]["data"])))
        self.assertEqual(sent.size, (1600, 1200))
        self.assertEqual(Image.open(io.BytesIO(bytes(cf.data))).size, (3200, 2400))
        self.assertIn("Board photo (IMG_0412.jpg): photo/image", context.ai_blocks([cf]).listing[0])

    def test_cache_control_marks_the_file_blocks(self):
        files = [self.add(make_pdf((100 + i,)), f"f{i}.pdf") for i in range(6)]
        blocks = context.ai_blocks(files).blocks
        marked = [i for i, b in enumerate(blocks) if b.get("cache_control") == {"type": "ephemeral"}]
        self.assertEqual(marked, [2, 3, 4, 5])   # the API allows four breakpoints; the last is one

    def test_too_many_pages_are_refused_with_a_way_out(self):
        cf = self.add(make_pdf((100,) * 101), "long.pdf")
        with self.assertRaises(context.ContextFileError) as e:
            context.ai_blocks([cf])
        self.assertIn("at most 100", str(e.exception))
        self.assertIn("exclude the pages", str(e.exception))
        cf.pages = list(range(1, 51))
        self.assertEqual(len(context.ai_blocks([cf]).blocks), 1)

    def test_too_many_bytes_are_refused(self):
        cf = self.add(make_pdf(), "sheet.pdf")
        with mock.patch.object(context, "MAX_REQUEST_BYTES", 1024 * 1024 + 10):
            with self.assertRaises(context.ContextFileError) as e:
                context.ai_blocks([cf])
        self.assertIn("MB as sent", str(e.exception))

    def test_a_file_with_no_pages_chosen_is_not_sent(self):
        cf = self.add(make_pdf(), "sheet.pdf", pages=[])
        self.assertEqual(context.ai_blocks([cf]).blocks, [])


class EditSendsContextFilesTests(TestCase):
    """/build/edit sends the files in context, minus the ones skipped for the
    message, before the prompt text — and logs the cache tokens."""

    def setUp(self):
        llm_models._cache.update(at=9e12, value={
            "models": llm_models.select([
                {"id": "claude-opus-5", "display_name": "Claude Opus 5", "created_at": "2026-07-24"}]),
            "default": "claude-opus-5", "source": "live"})
        self.client = Client()
        org = Organisation.objects.create(name="Org", slug="org")
        self.user = User.objects.create_user(username="u", email="u@example.com", password="pw",
                                             organisation=org)
        self.project = Project.objects.create(name="P", organisation=org, created_by=self.user)
        self.doc = Document.objects.create(name="Case", data={}, project=self.project,
                                           created_by=self.user)
        self.client.force_login(self.user)

    def tearDown(self):
        llm_models._cache.update(at=0.0, value=None)

    def add(self, data, name, **owner):
        f = SimpleUploadedFile(name, data)
        owner = owner or {"project": self.project.id}
        q = "&".join(f"{k}={v}" for k, v in owner.items())
        return self.client.post(f"/api/context/?{q}", {"file": f}).json()["id"]

    def edit(self, **extra):
        seen = {}

        def fake(system, user, tools, model):
            seen.update(system=system, user=user)
            return {"kind": "edit", "code": "part = Box(2, 2, 2)", "note": "ok",
                    "usage": {"input": 1000, "output": 100, "cache_read": 0, "cache_write": 50_000}}

        with mock.patch("modeling.assistant._anthropic_call", fake):
            r = self.client.post("/api/build/edit", content_type="application/json", data=json.dumps({
                "code": "part = Box(1, 1, 1)", "instruction": "make a case for this board",
                "document_id": str(self.doc.id), **extra}))
        return r, seen

    def test_files_in_context_go_first_with_the_text_last(self):
        sheet = self.add(make_pdf(), "sheet.pdf")
        photo = self.add(make_image(800, 600, "JPEG"), "board.jpg", document=self.doc.id)
        off = self.add(make_pdf((10,)), "old.pdf")
        ContextFile.objects.filter(id=off).update(in_context=False)
        User.objects.filter(id=self.user.id).update(is_staff=True)   # the spend is shown to staff only
        r, seen = self.edit()
        self.assertEqual(r.status_code, 200, r.content)
        user = seen["user"]
        self.assertEqual([b["type"] for b in user], ["document", "image", "text"])
        self.assertTrue(all(b["cache_control"] == {"type": "ephemeral"} for b in user[:2]))
        self.assertNotIn("cache_control", user[2])
        text = user[2]["text"]
        self.assertIn("CONTEXT FILES (attached above, in this order):\n1. sheet.pdf: all 4 pages\n"
                      "2. board.jpg: photo/image", text)
        self.assertNotIn("old.pdf", text)
        self.assertIn("REFERENCE FILES AND WHERE DIMENSIONS COME FROM", seen["system"])
        d = r.json()
        self.assertEqual(d["context_files"], [sheet, photo])
        self.assertEqual((d["tokens_in"], d["cache_write_tokens"], d["cache_read_tokens"]),
                         (51_000, 50_000, 0))
        # Opus at $5/MTok: 1000 in + 50k written at 1.25× + 100 out at $25/MTok
        self.assertAlmostEqual(d["cost_usd"], 0.005 + 0.3125 + 0.0025, places=4)
        from modeling.models import AiEdit
        self.assertEqual(AiEdit.objects.get().cache_write_tokens, 50_000)

    def test_a_file_skipped_for_this_message_is_not_sent(self):
        sheet = self.add(make_pdf(), "sheet.pdf")
        r, seen = self.edit(skip_context=[sheet])
        self.assertIsInstance(seen["user"], str)    # no files: plain text as before
        self.assertNotIn("CONTEXT FILES", seen["user"])
        self.assertEqual(r.json()["context_files"], [])

    def test_a_limit_is_reported_before_calling_the_model(self):
        self.add(make_pdf((100,) * 101), "long.pdf")
        r, seen = self.edit()
        self.assertEqual(r.status_code, 422)
        self.assertIn("at most 100", r.json()["message"])
        self.assertEqual(seen, {})
