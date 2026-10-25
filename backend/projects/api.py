import re
from uuid import UUID

from django.db import connection, transaction
from django.db.models import Count
from django.http import JsonResponse
from django.shortcuts import get_object_or_404
from django.utils import timezone
from ninja import Router

from accounts.models import User

from .access import get_accessible_projects, require_auth, require_project_access
from .models import Project, ProjectBriefVersion, ProjectShare
from .schemas import (
    BriefIn,
    BriefVersionOut,
    ParametersIn,
    ProjectCreateIn,
    ProjectListOut,
    ProjectOut,
    ProjectUpdateIn,
    ShareIn,
    ShareOut,
)

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


@router.put("/{project_id}/brief", response=ProjectOut)
def save_brief(request, project_id: UUID, payload: BriefIn):
    """Save the project's brief; each changed text is kept as a version."""
    err = require_auth(request)
    if err:
        return err
    project = get_object_or_404(Project, id=project_id)
    err = require_project_access(request, project)
    if err:
        return err
    if payload.text == project.brief:
        return project
    label = payload.label.strip()
    limit = ProjectBriefVersion._meta.get_field("label").max_length
    if len(label) > limit:
        label = label[:limit - 1].rstrip() + "…"
    project.brief = payload.text
    project.brief_updated_at = timezone.now()
    project.save(update_fields=["brief", "brief_updated_at", "updated_at"])
    ProjectBriefVersion.objects.create(project=project, text=payload.text, label=label, created_by=request.user)
    return project


PARAM_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def check_parameters(params: list[dict]) -> str | None:
    """Why a project's parameter list can't be saved, or None."""
    seen = set()
    for p in params:
        name = p.get("name", "")
        if not PARAM_NAME.match(name):
            return (f"{name!r} isn't a usable parameter name: use letters, digits and _, "
                    "not starting with a digit (e.g. arm_od)")
        if name in seen:
            return f"There are two parameters called {name!r}"
        seen.add(name)
        if isinstance(p.get("value"), str) and not p["value"].strip():
            return f"{name!r} has no value"
    return None


@router.put("/{project_id}/parameters", response={200: ProjectOut, 400: dict})
def save_parameters(request, project_id: UUID, payload: ParametersIn):
    """Replace the project's parameters (PP["name"] in every part's script, by
    name in its sketches' dimensions). `renames` ({old: new}) are rewritten
    where they are used. A name a project sketch has as its own parameter
    can't be added: the sketch's dimensions would mean one or the other."""
    from modeling.project_params import own_clashes, rename

    err = require_auth(request)
    if err:
        return err
    project = get_object_or_404(Project, id=project_id)
    err = require_project_access(request, project)
    if err:
        return err
    params = [{"name": p.name.strip(), "value": p.value, "unit": p.unit.strip(),
               "description": p.description.strip()} for p in payload.parameters]
    why = check_parameters(params)
    if why:
        return 400, {"message": why}
    names = {p["name"] for p in params}
    renames = {o.strip(): n.strip() for o, n in payload.renames.items() if n.strip() in names}
    had = {p.get("name") for p in project.parameters or [] if isinstance(p, dict)}
    clash = own_clashes(project, names - (had - set(renames)))
    if clash:
        n, doc = clash[0]
        return 400, {"message": f"The sketch {doc!r} has its own parameter called {n!r}: "
                                "rename one of them, or use Move to project on the sketch's one"}
    with transaction.atomic():
        project.parameters = params
        project.save(update_fields=["parameters", "updated_at"])
        rename(project, renames)
    return project


@router.get("/{project_id}/parameters/uses", response=dict)
def parameter_uses(request, project_id: UUID):
    """Which of the project's sketches and parts use each parameter, and any
    sketch that can't be solved with its value (the project page's Used by)."""
    from modeling.project_params import uses

    err = require_auth(request)
    if err:
        return err
    project = get_object_or_404(Project, id=project_id)
    err = require_project_access(request, project)
    if err:
        return err
    return uses(project)


@router.get("/{project_id}/brief/versions", response=list[BriefVersionOut])
def brief_versions(request, project_id: UUID):
    """The brief's saved texts, newest first."""
    err = require_auth(request)
    if err:
        return err
    project = get_object_or_404(Project, id=project_id)
    err = require_project_access(request, project)
    if err:
        return err
    return project.brief_versions.select_related("created_by")[:100]


@router.delete("/{project_id}", response={204: None})
def delete_project(request, project_id: UUID):
    err = require_auth(request)
    if err:
        return err
    project = get_object_or_404(Project, id=project_id)
    err = require_project_access(request, project)
    if err:
        return err
    # `parts_part` is a legacy orphan table (pre-pivot parts) that still FK-
    # references projects with no cascade and is not managed by any model, so
    # project.delete() can't clean it up. Remove its rows for this project first.
    if connection.vendor == "postgresql":
        with connection.cursor() as cur:
            cur.execute("SELECT to_regclass('parts_part')")
            if cur.fetchone()[0] is not None:
                cur.execute("DELETE FROM parts_part WHERE project_id = %s", [str(project_id)])
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
