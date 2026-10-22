import hashlib
import re
import time
from uuid import UUID

from django.db.models import Q
from django.http import JsonResponse
from django.shortcuts import get_object_or_404
from django.utils.dateparse import parse_datetime
from ninja import File, Router
from ninja.files import UploadedFile

from accounts.events import record_event
from accounts.models import UserEvent
from projects.access import can_access_project, require_auth
from projects.models import Project, ProjectShare

from .models import Document, DocumentAsset, DocumentVersion
from .schemas import (
    AssetBBox,
    AssetListOut,
    AssetOut,
    DocumentCreateIn,
    DocumentListOut,
    DocumentOut,
    DocumentUpdateIn,
    VersionListOut,
    VersionOut,
)
from .validators import validate_document_data

router = Router()

MAX_ASSET_BYTES = 25 * 1024 * 1024

# How an uploaded STEP file enters a script: imported by hash, then placed on the
# build plate (centered in XY, resting on Z=0). The frontend seeds the same
# lines (ScriptViewer's importScript); the upload's trial build runs these.
IMPORT_SCRIPT = (
    'part = import_step(ASSETS["{sha}"])\n'
    "bb = part.bounding_box()\n"
    "part = Pos(-(bb.min.X + bb.max.X) / 2, -(bb.min.Y + bb.max.Y) / 2, -bb.min.Z) * part\n"
)


def document_or_error(request, doc_id):
    """The document, if the user may edit it: (doc, None), else (None, an
    error response). The access check every document endpoint makes."""
    err = require_auth(request)
    if err:
        return None, err
    doc = get_object_or_404(Document, id=doc_id)
    if doc.project and not can_access_project(request.user, doc.project):
        return None, JsonResponse({"message": "Access denied"}, status=403)
    return doc, None


def _snapshot(doc, user, data, label=""):
    """Append an immutable version snapshot when the model script changes — so
    every distinct version (including the current one) is preserved forever."""
    code = data.get("modelCode") if isinstance(data, dict) else None
    if not (isinstance(code, str) and code.strip()):
        return
    last = doc.versions.first()   # most recent (ordering = -created_at)
    if last and isinstance(last.data, dict) and last.data.get("modelCode") == code:
        return                     # unchanged — don't duplicate
    # labels are free text (an AI change summary, "imported <filename>") — clip
    # to the column, which Postgres enforces (sqlite silently doesn't)
    label = (label or "").strip()
    limit = DocumentVersion._meta.get_field("label").max_length
    if len(label) > limit:
        label = label[:limit - 1].rstrip() + "…"
    DocumentVersion.objects.create(document=doc, data=data, label=label, created_by=user)


def _user_accessible_filter(user):
    """Return a Q filter for documents the user can access (org + shared projects)."""
    if user.is_superuser:
        return Q()
    shared_project_ids = ProjectShare.objects.filter(user=user).values_list("project_id", flat=True)
    return Q(project__organisation_id=user.organisation_id) | Q(project_id__in=shared_project_ids)


@router.get("/", response=list[DocumentListOut])
def list_documents(request, project: UUID | None = None):
    err = require_auth(request)
    if err:
        return err
    qs = Document.objects.filter(_user_accessible_filter(request.user))
    if project:
        qs = qs.filter(project_id=project)
    return qs


@router.post("/", response={201: DocumentOut})
def create_document(request, payload: DocumentCreateIn):
    err = require_auth(request)
    if err:
        return err
    errors = validate_document_data(payload.data)
    if errors:
        return JsonResponse({"errors": errors}, status=422)
    project = None
    if payload.project_id:
        project = get_object_or_404(Project, id=payload.project_id)
        if not can_access_project(request.user, project):
            return JsonResponse({"message": "Access denied"}, status=403)
    doc = Document.objects.create(
        name=payload.name,
        data=payload.data,
        project=project,
        created_by=request.user,
    )
    _snapshot(doc, request.user, payload.data, "created")
    record_event(UserEvent.DOCUMENT_CREATED, request, document=doc)
    return 201, doc


@router.get("/{doc_id}", response=DocumentOut)
def get_document(request, doc_id: UUID):
    err = require_auth(request)
    if err:
        return err
    doc = get_object_or_404(Document, id=doc_id)
    if doc.project and not can_access_project(request.user, doc.project):
        return JsonResponse({"message": "Access denied"}, status=403)
    return doc


@router.put("/{doc_id}", response=DocumentOut)
def update_document(request, doc_id: UUID, payload: DocumentUpdateIn):
    err = require_auth(request)
    if err:
        return err
    doc = get_object_or_404(Document, id=doc_id)
    if doc.project and not can_access_project(request.user, doc.project):
        return JsonResponse({"message": "Access denied"}, status=403)

    # (1) Optimistic concurrency: never let a client holding a stale copy overwrite
    # a newer save (e.g. a second tab). base_updated_at is what the client last saw.
    if payload.base_updated_at:
        base = parse_datetime(payload.base_updated_at)
        # >3s newer means someone else saved since this client loaded (a real
        # cross-client conflict); a client's own rapid saves are far closer.
        if base and (doc.updated_at - base).total_seconds() > 3.0:
            return JsonResponse(
                {"message": "This document was changed elsewhere; reload to get the latest.",
                 "updated_at": doc.updated_at.isoformat()},
                status=409,
            )

    if payload.name is not None:
        doc.name = payload.name
    if payload.data is not None:
        new = payload.data
        # (2) Safety net: if this save replaces the model script, keep the version
        # it overwrites in the history — so an overwrite can never truly lose work.
        old = doc.data if isinstance(doc.data, dict) else {}
        old_code = old.get("modelCode")
        if isinstance(old_code, str) and old_code.strip() and old_code != new.get("modelCode"):
            hist = new.get("modelCodeHistory")
            hist = hist if isinstance(hist, list) else []
            if not (hist and isinstance(hist[-1], dict) and hist[-1].get("code") == old_code):
                hist = [*hist, {"code": old_code, "at": int(time.time() * 1000), "label": "overwritten"}][-60:]
                new = {**new, "modelCodeHistory": hist}
        errors = validate_document_data(new)
        if errors:
            return JsonResponse({"errors": errors}, status=422)
        doc.data = new
    if payload.history is not None:
        doc.history = payload.history
    if payload.project_id is not None:   # move to another project (must have access)
        target = get_object_or_404(Project, id=payload.project_id)
        if not can_access_project(request.user, target):
            return JsonResponse({"message": "Access denied"}, status=403)
        doc.project = target
    doc.save()
    # Record an immutable version only when asked (a build-verified snapshot).
    # In-progress hand edits between builds save with snapshot=False so they
    # persist for durability without cluttering history with unfinished states.
    if payload.data is not None and payload.snapshot:
        _snapshot(doc, request.user, doc.data, payload.version_label or "")
    return doc


@router.get("/{doc_id}/versions", response=list[VersionListOut])
def list_versions(request, doc_id: UUID):
    """Immutable version snapshots for a document, newest first."""
    err = require_auth(request)
    if err:
        return err
    doc = get_object_or_404(Document, id=doc_id)
    if doc.project and not can_access_project(request.user, doc.project):
        return JsonResponse({"message": "Access denied"}, status=403)
    return list(doc.versions.all())


@router.get("/{doc_id}/versions/{version_id}", response=VersionOut)
def get_version(request, doc_id: UUID, version_id: UUID):
    """The full data of one immutable version (for restoring)."""
    err = require_auth(request)
    if err:
        return err
    doc = get_object_or_404(Document, id=doc_id)
    if doc.project and not can_access_project(request.user, doc.project):
        return JsonResponse({"message": "Access denied"}, status=403)
    return get_object_or_404(DocumentVersion, id=version_id, document=doc)


@router.delete("/{doc_id}", response={204: None})
def delete_document(request, doc_id: UUID):
    err = require_auth(request)
    if err:
        return err
    doc = get_object_or_404(Document, id=doc_id)
    if doc.project and not can_access_project(request.user, doc.project):
        return JsonResponse({"message": "Access denied"}, status=403)
    doc.delete()
    return 204, None


def _clean_filename(name: str) -> str:
    """The upload's base name, safe to put in a script comment (one line)."""
    name = re.split(r"[\\/]", name or "")[-1]
    name = re.sub(r"[\x00-\x1f\x7f]", "", name).strip()
    return name[:255] or "upload.step"


@router.post("/{doc_id}/assets", response={200: AssetOut, 201: AssetOut})
def upload_asset(request, doc_id: UUID, file: UploadedFile = File(...)):
    """Upload a STEP file for the document's script to import (ASSETS["<sha256>"]).
    It is trial-built first, so a file the engine can't read is refused with the
    engine's error. Re-uploading the same bytes returns the stored asset."""
    from modeling.engine import EngineError, run_script

    doc, err = document_or_error(request, doc_id)
    if err:
        return err
    filename = _clean_filename(file.name)
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    if ext == "stl":
        return JsonResponse({"message": "STL import isn't supported yet — export the part "
                                        "as STEP (.step/.stp) and upload that."}, status=415)
    if ext not in ("step", "stp"):
        return JsonResponse({"message": "Only STEP files (.step/.stp) can be imported."}, status=415)
    if file.size > MAX_ASSET_BYTES:
        return JsonResponse({"message": f"{filename} is {file.size / 1e6:.1f} MB; the limit is "
                                        f"{MAX_ASSET_BYTES // (1024 * 1024)} MB."}, status=413)
    data = file.read()
    if not data.lstrip()[:13].upper().startswith(b"ISO-10303-21"):
        return JsonResponse({"message": f"{filename} is not a STEP file (no ISO-10303-21 header)."},
                            status=415)
    sha = hashlib.sha256(data).hexdigest()
    try:
        r = run_script(IMPORT_SCRIPT.format(sha=sha), assets={sha: data})
    except EngineError as exc:
        return JsonResponse({"message": f"Couldn't import {filename}: {exc}"}, status=422)
    if r.get("warning"):
        return JsonResponse({"message": f"Couldn't import {filename}: {r['warning']}"}, status=422)
    # the same bytes already uploaded to this document: return that one
    asset, created = DocumentAsset.objects.get_or_create(
        document=doc, sha256=sha,
        defaults={"filename": filename, "content_type": (file.content_type or "")[:100],
                  "size": len(data), "data": data, "created_by": request.user},
    )
    m = r["metrics"]
    out = AssetOut(sha256=sha, filename=asset.filename, size=asset.size,
                   bbox=AssetBBox(min=m["bbox_min"], max=m["bbox_max"]),
                   face_count=len(r.get("faces", [])))
    return (201 if created else 200), out


@router.get("/{doc_id}/assets", response=list[AssetListOut])
def list_assets(request, doc_id: UUID):
    """The document's uploaded files, oldest first (metadata only, no bytes)."""
    doc, err = document_or_error(request, doc_id)
    if err:
        return err
    return list(doc.assets.defer("data"))
