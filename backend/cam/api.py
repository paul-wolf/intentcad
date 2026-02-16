from uuid import UUID

from django.http import HttpResponse, JsonResponse
from django.shortcuts import get_object_or_404
from ninja import Router

from documents.models import Document

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


# ── Profiles ──


@router.get("/profiles/", response=list[CamProfileListOut])
def list_profiles(request):
    if not request.user.is_authenticated:
        return JsonResponse({"message": "Authentication required"}, status=401)
    return CamProfile.objects.filter(user=request.user)


@router.post("/profiles/", response={201: CamProfileOut})
def create_profile(request, payload: CamProfileCreateIn):
    if not request.user.is_authenticated:
        return JsonResponse({"message": "Authentication required"}, status=401)
    errors = validate_cam_profile_config(payload.config)
    if errors:
        return JsonResponse({"errors": errors}, status=422)
    profile = CamProfile.objects.create(name=payload.name, config=payload.config, user=request.user)
    return 201, profile


@router.get("/profiles/{profile_id}", response=CamProfileOut)
def get_profile(request, profile_id: UUID):
    if not request.user.is_authenticated:
        return JsonResponse({"message": "Authentication required"}, status=401)
    return get_object_or_404(CamProfile, id=profile_id, user=request.user)


@router.put("/profiles/{profile_id}", response=CamProfileOut)
def update_profile(request, profile_id: UUID, payload: CamProfileUpdateIn):
    if not request.user.is_authenticated:
        return JsonResponse({"message": "Authentication required"}, status=401)
    profile = get_object_or_404(CamProfile, id=profile_id, user=request.user)
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
    if not request.user.is_authenticated:
        return JsonResponse({"message": "Authentication required"}, status=401)
    profile = get_object_or_404(CamProfile, id=profile_id, user=request.user)
    profile.delete()
    return 204, None


# ── Jobs ──


@router.get("/jobs/", response=list[CamJobListOut])
def list_jobs(request, document: UUID | None = None):
    if not request.user.is_authenticated:
        return JsonResponse({"message": "Authentication required"}, status=401)
    qs = CamJob.objects.filter(document__user=request.user)
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
    if not request.user.is_authenticated:
        return JsonResponse({"message": "Authentication required"}, status=401)
    doc = get_object_or_404(Document, id=payload.document_id, user=request.user)
    if payload.config:
        errors = validate_cam_job_config(payload.config)
        if errors:
            return JsonResponse({"errors": errors}, status=422)
    profile = None
    if payload.profile_id:
        profile = get_object_or_404(CamProfile, id=payload.profile_id, user=request.user)
    job = CamJob.objects.create(
        document=doc,
        name=payload.name,
        profile=profile,
        config=payload.config,
    )
    return 201, job


@router.get("/jobs/{job_id}", response=CamJobOut)
def get_job(request, job_id: UUID):
    if not request.user.is_authenticated:
        return JsonResponse({"message": "Authentication required"}, status=401)
    return get_object_or_404(CamJob, id=job_id, document__user=request.user)


@router.put("/jobs/{job_id}", response=CamJobOut)
def update_job(request, job_id: UUID, payload: CamJobUpdateIn):
    if not request.user.is_authenticated:
        return JsonResponse({"message": "Authentication required"}, status=401)
    job = get_object_or_404(CamJob, id=job_id, document__user=request.user)
    if payload.name is not None:
        job.name = payload.name
    if payload.profile_id is not None:
        profile = get_object_or_404(CamProfile, id=payload.profile_id, user=request.user)
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
    if not request.user.is_authenticated:
        return JsonResponse({"message": "Authentication required"}, status=401)
    job = get_object_or_404(CamJob, id=job_id, document__user=request.user)
    job.delete()
    return 204, None


@router.post("/jobs/{job_id}/generate", response=CamJobOut)
def generate_job(request, job_id: UUID):
    """Store G-code and errors posted from the frontend after client-side generation."""
    import json

    if not request.user.is_authenticated:
        return JsonResponse({"message": "Authentication required"}, status=401)
    body = json.loads(request.body)
    job = get_object_or_404(CamJob, id=job_id, document__user=request.user)
    job.gcode = body.get("gcode", "")
    job.errors = body.get("errors", [])
    job.save()
    return job


@router.get("/jobs/{job_id}/download")
def download_job(request, job_id: UUID):
    if not request.user.is_authenticated:
        return JsonResponse({"message": "Authentication required"}, status=401)
    job = get_object_or_404(CamJob, id=job_id, document__user=request.user)
    if not job.gcode:
        return JsonResponse({"error": "No G-code generated yet"}, status=404)
    response = HttpResponse(job.gcode, content_type="text/plain")
    filename = f"{job.name.replace(' ', '_')}.nc"
    response["Content-Disposition"] = f'attachment; filename="{filename}"'
    return response


# ── AI Advisor ──


@router.post("/advisor/suggest", response=AdvisorOut)
def suggest_plan(request, payload: AdvisorRequestIn):
    if not request.user.is_authenticated:
        return JsonResponse({"message": "Authentication required"}, status=401)
    from .advisor import suggest_cutting_plan

    result = suggest_cutting_plan(
        payload.document_data,
        payload.profile_config,
        payload.material,
    )
    return result
