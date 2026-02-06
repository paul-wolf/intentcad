from uuid import UUID

from django.http import JsonResponse
from django.shortcuts import get_object_or_404
from ninja import Router

from .models import Part
from .schemas import PartCreateIn, PartListOut, PartOut, PartUpdateIn
from .validators import validate_part_data

router = Router()


@router.get("/", response=list[PartListOut])
def list_parts(request):
    return Part.objects.all()


@router.post("/", response={201: PartOut})
def create_part(request, payload: PartCreateIn):
    errors = validate_part_data(payload.data)
    if errors:
        return JsonResponse({"errors": errors}, status=422)
    part = Part.objects.create(name=payload.name, data=payload.data)
    return 201, part


@router.get("/{part_id}", response=PartOut)
def get_part(request, part_id: UUID):
    return get_object_or_404(Part, id=part_id)


@router.put("/{part_id}", response=PartOut)
def update_part(request, part_id: UUID, payload: PartUpdateIn):
    part = get_object_or_404(Part, id=part_id)
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
    part = get_object_or_404(Part, id=part_id)
    part.delete()
    return 204, None
