"""Context files: reference PDFs and images on a project or a part (see
documents/context.py). Access is the project's: a part's files follow its
document, a project's files follow the project."""

from datetime import datetime
from uuid import UUID

from django.http import HttpResponse, JsonResponse
from django.shortcuts import get_object_or_404
from ninja import File, Form, Router, Schema
from ninja.files import UploadedFile

from projects.access import can_access_document, can_access_project, require_auth
from projects.models import Project

from .api import _clean_filename, document_or_error
from .context import ContextFileError, estimated_tokens, ingest, thumbnail
from .models import ContextFile

router = Router()


class ContextFileOut(Schema):
    id: UUID
    scope: str                    # "part" | "project"
    project_id: UUID | None = None
    document_id: UUID | None = None
    filename: str
    title: str
    note: str
    content_type: str
    size: int
    page_count: int | None = None
    width: int | None = None
    height: int | None = None
    in_context: bool
    pages: list[int] | None = None   # 1-based pages sent to the AI; null = all
    page_tokens: list[int]
    est_tokens: int               # for the pages currently included
    created_at: datetime

    @staticmethod
    def resolve_scope(obj) -> str:
        return "part" if obj.document_id else "project"

    @staticmethod
    def resolve_est_tokens(obj) -> int:
        return estimated_tokens(obj)


class ContextFilesOut(Schema):
    part: list[ContextFileOut] = []
    project: list[ContextFileOut] = []
    project_id: UUID | None = None


class ContextFilePatch(Schema):
    title: str | None = None
    note: str | None = None
    in_context: bool | None = None
    pages: list[int] | None = None
    all_pages: bool = False       # send every page again (pages=None can't say that)


def _denied():
    return JsonResponse({"message": "Access denied"}, status=403)


def _owner(request, project, document):
    """(project, document, None) for the owner named by the query, or an error."""
    err = require_auth(request)
    if err:
        return None, None, err
    if bool(project) == bool(document):
        return None, None, JsonResponse(
            {"message": "Give either project or document."}, status=400)
    if document:
        doc, err = document_or_error(request, document)
        return None, doc, err
    proj = get_object_or_404(Project, id=project)
    if not can_access_project(request.user, proj):
        return None, None, _denied()
    return proj, None, None


def file_or_error(request, file_id):
    """The context file, if the user may use it: (cf, None) or (None, error)."""
    err = require_auth(request)
    if err:
        return None, err
    cf = get_object_or_404(ContextFile.objects.select_related("project", "document__project"),
                           id=file_id)
    allowed = (can_access_project(request.user, cf.project) if cf.project
               else can_access_document(request.user, cf.document))
    if not allowed:
        return None, _denied()
    return cf, None


def _light(qs):
    return list(qs.defer("data"))


@router.get("/", response=ContextFilesOut)
def list_context_files(request, project: UUID | None = None, document: UUID | None = None):
    """A part's files and its project's files, or a project's files (no bytes)."""
    proj, doc, err = _owner(request, project, document)
    if err:
        return err
    if doc:
        proj = doc.project
        part = _light(ContextFile.objects.filter(document=doc))
    else:
        part = []
    shared = _light(ContextFile.objects.filter(project=proj)) if proj else []
    return {"part": part, "project": shared, "project_id": proj.id if proj else None}


@router.post("/", response={200: ContextFileOut, 201: ContextFileOut})
def upload_context_file(request, project: UUID | None = None, document: UUID | None = None,
                        file: UploadedFile = File(...), note: str = Form("")):
    """Add a PDF or an image to a project or a part. HEIC photos are stored as
    JPEG. The same bytes uploaded again to the same place return that file."""
    proj, doc, err = _owner(request, project, document)
    if err:
        return err
    filename = _clean_filename(file.name)
    if file.size > 25 * 1024 * 1024:
        return JsonResponse({"message": f"{filename} is {file.size / 1e6:.1f} MB; the limit is "
                                        "25 MB."}, status=413)
    try:
        got = ingest(file.read(), filename)
    except ContextFileError as exc:
        return JsonResponse({"message": str(exc)}, status=exc.status)
    same = ContextFile.objects.filter(project=proj, document=doc, sha256=got.sha256).first()
    if same:
        return 200, same
    cf = ContextFile.objects.create(
        project=proj, document=doc, filename=got.filename, title=got.filename,
        note=note.strip()[:500], content_type=got.content_type, size=len(got.data),
        sha256=got.sha256, data=got.data, page_count=got.page_count,
        width=got.width, height=got.height, page_tokens=got.page_tokens,
        created_by=request.user,
    )
    return 201, cf


@router.get("/{file_id}", response=ContextFileOut)
def get_context_file(request, file_id: UUID):
    cf, err = file_or_error(request, file_id)
    return err or cf


@router.get("/{file_id}/file")
def download_context_file(request, file_id: UUID):
    cf, err = file_or_error(request, file_id)
    if err:
        return err
    resp = HttpResponse(bytes(cf.data), content_type=cf.content_type)
    name = cf.filename.replace('"', "")
    resp["Content-Disposition"] = f'inline; filename="{name}"'
    resp["Cache-Control"] = "private, max-age=3600"
    return resp


@router.get("/{file_id}/thumbnail")
def context_thumbnail(request, file_id: UUID, page: int = 1, width: int = 320):
    """A JPEG of one page (a PDF page, or the image itself), cached per width."""
    cf, err = file_or_error(request, file_id)
    if err:
        return err
    if not 1 <= page <= (cf.page_count or 1):
        return JsonResponse({"message": f"{cf.title} has no page {page}."}, status=404)
    resp = HttpResponse(thumbnail(cf, page, max(16, width)), content_type="image/jpeg")
    resp["Cache-Control"] = "private, max-age=86400"
    return resp


@router.patch("/{file_id}", response=ContextFileOut)
def update_context_file(request, file_id: UUID, payload: ContextFilePatch):
    """Rename, annotate, include/exclude for the AI, or choose its pages."""
    cf, err = file_or_error(request, file_id)
    if err:
        return err
    if payload.title is not None:
        title = payload.title.strip()[:255]
        if not title:
            return JsonResponse({"message": "A title can't be empty."}, status=422)
        cf.title = title
    if payload.note is not None:
        cf.note = payload.note.strip()[:500]
    if payload.in_context is not None:
        cf.in_context = payload.in_context
    if payload.all_pages:
        cf.pages = None
    elif payload.pages is not None:
        if not cf.is_pdf:
            return JsonResponse({"message": "Only a PDF has pages to choose."}, status=422)
        n = cf.page_count or 0
        bad = [p for p in payload.pages if not 1 <= p <= n]
        if bad:
            return JsonResponse({"message": f"{cf.title} has pages 1–{n}; there's no page "
                                            f"{bad[0]}."}, status=422)
        pages = sorted(set(payload.pages))
        cf.pages = None if len(pages) == n else pages
    cf.save()
    return cf


@router.delete("/{file_id}", response={204: None})
def delete_context_file(request, file_id: UUID):
    cf, err = file_or_error(request, file_id)
    if err:
        return err
    cf.delete()
    return 204, None
