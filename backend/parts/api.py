from uuid import UUID

from django.db.models import Q
from django.http import JsonResponse
from django.shortcuts import get_object_or_404
from ninja import Router

from projects.access import can_access_project, require_auth
from projects.models import Project, ProjectShare

from .models import Part
from .schemas import PartCreateIn, PartListOut, PartOut, PartUpdateIn
from .validators import validate_part_data

router = Router()


def _user_accessible_filter(user):
    """Return a Q filter for parts the user can access (org + shared projects)."""
    if user.is_superuser:
        return Q()
    shared_project_ids = ProjectShare.objects.filter(user=user).values_list("project_id", flat=True)
    return Q(project__organisation_id=user.organisation_id) | Q(project_id__in=shared_project_ids)


@router.get("/", response=list[PartListOut])
def list_parts(request, project: UUID | None = None):
    err = require_auth(request)
    if err:
        return err
    qs = Part.objects.filter(_user_accessible_filter(request.user))
    if project:
        qs = qs.filter(project_id=project)
    return qs


@router.post("/", response={201: PartOut})
def create_part(request, payload: PartCreateIn):
    err = require_auth(request)
    if err:
        return err
    errors = validate_part_data(payload.data)
    if errors:
        return JsonResponse({"errors": errors}, status=422)
    project = None
    if payload.project_id:
        project = get_object_or_404(Project, id=payload.project_id)
        if not can_access_project(request.user, project):
            return JsonResponse({"message": "Access denied"}, status=403)
    part = Part.objects.create(
        name=payload.name,
        data=payload.data,
        project=project,
        created_by=request.user,
    )
    return 201, part


@router.get("/{part_id}", response=PartOut)
def get_part(request, part_id: UUID):
    err = require_auth(request)
    if err:
        return err
    part = get_object_or_404(Part, id=part_id)
    if part.project and not can_access_project(request.user, part.project):
        return JsonResponse({"message": "Access denied"}, status=403)
    return part


@router.put("/{part_id}", response=PartOut)
def update_part(request, part_id: UUID, payload: PartUpdateIn):
    err = require_auth(request)
    if err:
        return err
    part = get_object_or_404(Part, id=part_id)
    if part.project and not can_access_project(request.user, part.project):
        return JsonResponse({"message": "Access denied"}, status=403)
    if payload.name is not None:
        part.name = payload.name
    if payload.data is not None:
        errors = validate_part_data(payload.data)
        if errors:
            return JsonResponse({"errors": errors}, status=422)
        part.data = payload.data
    if payload.history is not None:
        part.history = payload.history
    part.save()
    return part


@router.delete("/{part_id}", response={204: None})
def delete_part(request, part_id: UUID):
    err = require_auth(request)
    if err:
        return err
    part = get_object_or_404(Part, id=part_id)
    if part.project and not can_access_project(request.user, part.project):
        return JsonResponse({"message": "Access denied"}, status=403)
    part.delete()
    return 204, None
