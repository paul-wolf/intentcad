from uuid import UUID

from django.http import HttpResponse, JsonResponse
from django.shortcuts import get_object_or_404
from ninja import Router

from documents.models import Document
from projects.access import can_access_project, require_auth

from .models import CamJob, CamProfile
from .schemas import (
    AdvisorOut,
    AdvisorRequestIn,
    CamJobCreateIn,
    CamJobListOut,
    CamJobOut,
    CamJobUpdateIn,
    CamProfileCreateIn,
    CamProfileListOut,
    CamProfileOut,
    CamProfileUpdateIn,
)
from .validators import validate_cam_job_config, validate_cam_profile_config

router = Router()


def _user_org_filter(user):
    """Return a queryset filter dict for org-scoped access."""
    if user.is_superuser:
        return {}
    return {"project__organisation_id": user.organisation_id}


# ── Profiles ──


@router.get("/profiles/", response=list[CamProfileListOut])
def list_profiles(request):
    err = require_auth(request)
    if err:
        return err
    return CamProfile.objects.filter(**_user_org_filter(request.user))


@router.post("/profiles/", response={201: CamProfileOut})
def create_profile(request, payload: CamProfileCreateIn):
    err = require_auth(request)
    if err:
        return err
    errors = validate_cam_profile_config(payload.config)
    if errors:
        return JsonResponse({"errors": errors}, status=422)
    profile = CamProfile.objects.create(
        name=payload.name,
        config=payload.config,
        created_by=request.user,
    )
    return 201, profile


@router.get("/profiles/{profile_id}", response=CamProfileOut)
def get_profile(request, profile_id: UUID):
    err = require_auth(request)
    if err:
        return err
    profile = get_object_or_404(CamProfile, id=profile_id)
    if profile.project and not can_access_project(request.user, profile.project):
        return JsonResponse({"message": "Access denied"}, status=403)
    return profile


@router.put("/profiles/{profile_id}", response=CamProfileOut)
def update_profile(request, profile_id: UUID, payload: CamProfileUpdateIn):
    err = require_auth(request)
    if err:
        return err
    profile = get_object_or_404(CamProfile, id=profile_id)
    if profile.project and not can_access_project(request.user, profile.project):
        return JsonResponse({"message": "Access denied"}, status=403)
    if payload.name is not None:
        profile.name = payload.name
    if payload.config is not None:
        errors = validate_cam_profile_config(payload.config)
        if errors:
            return JsonResponse({"errors": errors}, status=422)
        profile.config = payload.config
    profile.save()
    return profile


@router.delete("/profiles/{profile_id}", response={204: None})
def delete_profile(request, profile_id: UUID):
    err = require_auth(request)
    if err:
        return err
    profile = get_object_or_404(CamProfile, id=profile_id)
    if profile.project and not can_access_project(request.user, profile.project):
        return JsonResponse({"message": "Access denied"}, status=403)
    profile.delete()
    return 204, None


# ── Jobs ──


def _job_org_filter(user):
    """Return a queryset filter dict for org-scoped job access."""
    if user.is_superuser:
        return {}
    return {"document__project__organisation_id": user.organisation_id}


@router.get("/jobs/", response=list[CamJobListOut])
def list_jobs(request, document: UUID | None = None):
    err = require_auth(request)
    if err:
        return err
    qs = CamJob.objects.filter(**_job_org_filter(request.user))
    if document:
        qs = qs.filter(document_id=document)
    jobs = []
    for job in qs:
        jobs.append(
            CamJobListOut(
                id=job.id,
                name=job.name,
                document_id=job.document_id,
                updated_at=job.updated_at,
                has_gcode=bool(job.gcode),
                error_count=len(job.errors) if isinstance(job.errors, list) else 0,
            )
        )
    return jobs


@router.post("/jobs/", response={201: CamJobOut})
def create_job(request, payload: CamJobCreateIn):
    err = require_auth(request)
    if err:
        return err
    doc = get_object_or_404(Document, id=payload.document_id)
    if doc.project and not can_access_project(request.user, doc.project):
        return JsonResponse({"message": "Access denied"}, status=403)
    if payload.config:
        errors = validate_cam_job_config(payload.config)
        if errors:
            return JsonResponse({"errors": errors}, status=422)
    profile = None
    if payload.profile_id:
        profile = get_object_or_404(CamProfile, id=payload.profile_id)
    job = CamJob.objects.create(
        document=doc,
        name=payload.name,
        profile=profile,
        config=payload.config,
    )
    return 201, job


@router.get("/jobs/{job_id}", response=CamJobOut)
def get_job(request, job_id: UUID):
    err = require_auth(request)
    if err:
        return err
    job = get_object_or_404(CamJob, id=job_id)
    if job.document.project and not can_access_project(request.user, job.document.project):
        return JsonResponse({"message": "Access denied"}, status=403)
    return job


@router.put("/jobs/{job_id}", response=CamJobOut)
def update_job(request, job_id: UUID, payload: CamJobUpdateIn):
    err = require_auth(request)
    if err:
        return err
    job = get_object_or_404(CamJob, id=job_id)
    if job.document.project and not can_access_project(request.user, job.document.project):
        return JsonResponse({"message": "Access denied"}, status=403)
    if payload.name is not None:
        job.name = payload.name
    if payload.profile_id is not None:
        profile = get_object_or_404(CamProfile, id=payload.profile_id)
        job.profile = profile
    if payload.config is not None:
        errors = validate_cam_job_config(payload.config)
        if errors:
            return JsonResponse({"errors": errors}, status=422)
        job.config = payload.config
    job.save()
    return job


@router.delete("/jobs/{job_id}", response={204: None})
def delete_job(request, job_id: UUID):
    err = require_auth(request)
    if err:
        return err
    job = get_object_or_404(CamJob, id=job_id)
    if job.document.project and not can_access_project(request.user, job.document.project):
        return JsonResponse({"message": "Access denied"}, status=403)
    job.delete()
    return 204, None


@router.post("/jobs/{job_id}/generate", response=CamJobOut)
def generate_job(request, job_id: UUID):
    """Store G-code and errors posted from the frontend after client-side generation."""
    import json

    err = require_auth(request)
    if err:
        return err
    body = json.loads(request.body)
    job = get_object_or_404(CamJob, id=job_id)
    if job.document.project and not can_access_project(request.user, job.document.project):
        return JsonResponse({"message": "Access denied"}, status=403)
    job.gcode = body.get("gcode", "")
    job.errors = body.get("errors", [])
    job.save()
    return job


@router.get("/jobs/{job_id}/download")
def download_job(request, job_id: UUID):
    err = require_auth(request)
    if err:
        return err
    job = get_object_or_404(CamJob, id=job_id)
    if job.document.project and not can_access_project(request.user, job.document.project):
        return JsonResponse({"message": "Access denied"}, status=403)
    if not job.gcode:
        return JsonResponse({"error": "No G-code generated yet"}, status=404)
    response = HttpResponse(job.gcode, content_type="text/plain")
    filename = f"{job.name.replace(' ', '_')}.nc"
    response["Content-Disposition"] = f'attachment; filename="{filename}"'
    return response


# ── AI Advisor ──


@router.post("/advisor/suggest", response=AdvisorOut)
def suggest_plan(request, payload: AdvisorRequestIn):
    err = require_auth(request)
    if err:
        return err
    from .advisor import suggest_cutting_plan

    result = suggest_cutting_plan(
        payload.document_data,
        payload.profile_config,
        payload.material,
    )
    return result
