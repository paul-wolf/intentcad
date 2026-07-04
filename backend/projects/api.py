from uuid import UUID

from django.db.models import Count
from django.http import JsonResponse
from django.shortcuts import get_object_or_404
from ninja import Router

from accounts.models import User

from .access import get_accessible_projects, require_auth, require_project_access
from .models import Project, ProjectShare
from .schemas import ProjectCreateIn, ProjectListOut, ProjectOut, ProjectUpdateIn, ShareIn, ShareOut

router = Router()


@router.get("/", response=list[ProjectListOut])
def list_projects(request):
    err = require_auth(request)
    if err:
        return err
    qs = get_accessible_projects(request.user).annotate(
        document_count=Count("documents", distinct=True),
    )
    return [
        ProjectListOut(
            id=p.id,
            name=p.name,
            description=p.description,
            updated_at=p.updated_at,
            document_count=p.document_count,
        )
        for p in qs
    ]


@router.post("/", response={201: ProjectOut})
def create_project(request, payload: ProjectCreateIn):
    err = require_auth(request)
    if err:
        return err
    # Determine organisation: explicit param (superuser), else user's own org
    org = None
    if payload.organisation_id and request.user.is_superuser:
        from accounts.models import Organisation
        org = get_object_or_404(Organisation, id=payload.organisation_id)
    else:
        org = request.user.organisation
    if not org:
        return JsonResponse({"message": "User must belong to an organisation"}, status=400)
    project = Project.objects.create(
        name=payload.name,
        description=payload.description,
        organisation=org,
        created_by=request.user,
    )
    return 201, project


@router.get("/{project_id}", response=ProjectOut)
def get_project(request, project_id: UUID):
    err = require_auth(request)
    if err:
        return err
    project = get_object_or_404(Project, id=project_id)
    err = require_project_access(request, project)
    if err:
        return err
    return project


@router.patch("/{project_id}", response=ProjectOut)
def update_project(request, project_id: UUID, payload: ProjectUpdateIn):
    err = require_auth(request)
    if err:
        return err
    project = get_object_or_404(Project, id=project_id)
    err = require_project_access(request, project)
    if err:
        return err
    if payload.name is not None:
        project.name = payload.name
    if payload.description is not None:
        project.description = payload.description
    project.save()
    return project


@router.delete("/{project_id}", response={204: None})
def delete_project(request, project_id: UUID):
    err = require_auth(request)
    if err:
        return err
    project = get_object_or_404(Project, id=project_id)
    err = require_project_access(request, project)
    if err:
        return err
    project.delete()
    return 204, None


@router.get("/{project_id}/shares", response=list[ShareOut])
def list_shares(request, project_id: UUID):
    err = require_auth(request)
    if err:
        return err
    project = get_object_or_404(Project, id=project_id)
    err = require_project_access(request, project)
    if err:
        return err
    shares = ProjectShare.objects.filter(project=project).select_related("user")
    return [
        ShareOut(
            id=s.id,
            email=s.user.email,
            username=s.user.username,
            shared_at=s.created_at,
        )
        for s in shares
    ]


@router.post("/{project_id}/shares", response={201: ShareOut, 404: dict, 409: dict})
def add_share(request, project_id: UUID, payload: ShareIn):
    err = require_auth(request)
    if err:
        return err
    project = get_object_or_404(Project, id=project_id)
    err = require_project_access(request, project)
    if err:
        return err
    target = User.objects.filter(email=payload.email).first()
    if not target:
        return 404, {"message": f"No user found with email {payload.email}"}
    if ProjectShare.objects.filter(project=project, user=target).exists():
        return 409, {"message": "Already shared with this user"}
    share = ProjectShare.objects.create(project=project, user=target)
    return 201, ShareOut(
        id=share.id,
        email=target.email,
        username=target.username,
        shared_at=share.created_at,
    )


@router.delete("/{project_id}/shares/{share_id}", response={204: None})
def remove_share(request, project_id: UUID, share_id: UUID):
    err = require_auth(request)
    if err:
        return err
    project = get_object_or_404(Project, id=project_id)
    err = require_project_access(request, project)
    if err:
        return err
    share = get_object_or_404(ProjectShare, id=share_id, project=project)
    share.delete()
    return 204, None
