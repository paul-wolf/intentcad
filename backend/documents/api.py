from uuid import UUID

from django.http import JsonResponse
from django.shortcuts import get_object_or_404
from ninja import Router

from projects.access import can_access_project, require_auth
from projects.models import Project

from .models import Document
from .schemas import DocumentCreateIn, DocumentListOut, DocumentOut, DocumentUpdateIn
from .validators import validate_document_data

router = Router()


def _user_org_filter(user):
    """Return a queryset filter dict for org-scoped access."""
    if user.is_superuser:
        return {}
    return {"project__organisation_id": user.organisation_id}


@router.get("/", response=list[DocumentListOut])
def list_documents(request, project: UUID | None = None):
    err = require_auth(request)
    if err:
        return err
    qs = Document.objects.filter(**_user_org_filter(request.user))
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
    if payload.name is not None:
        doc.name = payload.name
    if payload.data is not None:
        errors = validate_document_data(payload.data)
        if errors:
            return JsonResponse({"errors": errors}, status=422)
        doc.data = payload.data
    if payload.history is not None:
        doc.history = payload.history
    doc.save()
    return doc


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
