import time
from uuid import UUID

from django.db.models import Q
from django.http import JsonResponse
from django.shortcuts import get_object_or_404
from django.utils.dateparse import parse_datetime
from ninja import Router

from projects.access import can_access_project, require_auth
from projects.models import Project, ProjectShare

from .models import Document, DocumentVersion
from .schemas import (
    DocumentCreateIn,
    DocumentListOut,
    DocumentOut,
    DocumentUpdateIn,
    VersionListOut,
    VersionOut,
)
from .validators import validate_document_data

router = Router()


def _snapshot(doc, user, data, label=""):
    """Append an immutable version snapshot when the model script changes — so
    every distinct version (including the current one) is preserved forever."""
    code = data.get("modelCode") if isinstance(data, dict) else None
    if not (isinstance(code, str) and code.strip()):
        return
    last = doc.versions.first()   # most recent (ordering = -created_at)
    if last and isinstance(last.data, dict) and last.data.get("modelCode") == code:
        return                     # unchanged — don't duplicate
    DocumentVersion.objects.create(document=doc, data=data, label=label or "", created_by=user)


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
    if payload.data is not None:
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
