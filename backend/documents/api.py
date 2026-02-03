import json
from uuid import UUID
from django.http import JsonResponse
from django.shortcuts import get_object_or_404
from ninja import Router

from .models import Document
from .schemas import DocumentCreateIn, DocumentUpdateIn, DocumentOut, DocumentListOut
from .validators import validate_document_data

router = Router()


@router.get("/", response=list[DocumentListOut])
def list_documents(request):
    return Document.objects.all()


@router.post("/", response={201: DocumentOut})
def create_document(request, payload: DocumentCreateIn):
    errors = validate_document_data(payload.data)
    if errors:
        return JsonResponse({"errors": errors}, status=422)
    doc = Document.objects.create(name=payload.name, data=payload.data)
    return 201, doc


@router.get("/{doc_id}", response=DocumentOut)
def get_document(request, doc_id: UUID):
    return get_object_or_404(Document, id=doc_id)


@router.put("/{doc_id}", response=DocumentOut)
def update_document(request, doc_id: UUID, payload: DocumentUpdateIn):
    doc = get_object_or_404(Document, id=doc_id)
    if payload.name is not None:
        doc.name = payload.name
    if payload.data is not None:
        errors = validate_document_data(payload.data)
        if errors:
            return JsonResponse({"errors": errors}, status=422)
        doc.data = payload.data
    doc.save()
    print(json.dumps(doc.data, indent=2))
    return doc


@router.delete("/{doc_id}", response={204: None})
def delete_document(request, doc_id: UUID):
    doc = get_object_or_404(Document, id=doc_id)
    doc.delete()
    return 204, None
