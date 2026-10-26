"""Generated sketch endpoints (/api/sketches): make one, try its code with other
parameter values, save its code, keep its chat. See modeling/generated_sketch.py."""
from __future__ import annotations

from typing import Any
from uuid import UUID

from django.db import transaction
from django.http import JsonResponse
from django.shortcuts import get_object_or_404
from ninja import Router, Schema

from documents.api import document_or_error
from documents.models import Document
from projects.access import require_auth, require_project_access
from projects.models import Project

from . import generated_sketch as gs
from . import shared_defs

router = Router()


class CreateIn(Schema):
    project_id: UUID | None = None
    name: str = "Generated sketch"
    code: str = ""
    # an empty drawn sketch becomes generated in place; any other gets a new document
    from_document: UUID | None = None


class RunIn(Schema):
    code: str | None = None             # unsaved code (else the saved code)
    pp: dict[str, float | str] = {}     # parameter values to try instead of the project's


class CodeIn(Schema):
    code: str
    label: str = ""          # what the change was ("AI: added wall holes", "edited in Code")
    confirm: bool = False    # save even though outputs parts use would go


class ChatIn(Schema):
    chat: list[dict[str, Any]]


def _generated(request, doc_id):
    doc, err = document_or_error(request, doc_id)
    if err:
        return None, err
    if not gs.is_generated(doc):
        return None, JsonResponse({"message": "It isn't a generated sketch"}, status=400)
    return doc, None


def _out(doc, result: dict | None = None, **extra) -> dict:
    return {"id": str(doc.id), "name": doc.name, "data": doc.data,
            "updated_at": doc.updated_at.isoformat(), **({"result": result} if result is not None else {}),
            **extra}


@router.post("/create")
def create(request, payload: CreateIn):
    """A new generated sketch (run once), or an empty drawn one made generated."""
    err = require_auth(request)
    if err:
        return err
    code = payload.code if payload.code.strip() else gs.STARTER
    if payload.from_document:
        src, err = document_or_error(request, payload.from_document)
        if err:
            return err
        if gs.is_empty_drawn(src):
            gs.convert_in_place(src, code)
            return _out(src, created=False)
        project = src.project
    else:
        project = None
        if payload.project_id:
            project = get_object_or_404(Project, id=payload.project_id)
            err = require_project_access(request, project)
            if err:
                return err
    name = payload.name.strip() or "Generated sketch"
    taken = set(Document.objects.filter(project=project).values_list("name", flat=True))
    base, n = name, 2
    while name in taken:
        name, n = f"{base} ({n})", n + 1
    with transaction.atomic():
        doc = Document.objects.create(name=name, data=gs.new_data(name, code), project=project,
                                      created_by=request.user)
    gs.apply(doc, gs.run(doc))
    doc.save()
    return _out(doc, created=True)


@router.post("/{doc_id}/run")
def trial_run(request, doc_id: UUID, payload: RunIn):
    """Run the code with other values (or unsaved code), saving nothing: the
    sliders' preview and the Code view's Run. `broken` names outputs parts use
    that this run no longer makes."""
    doc, err = _generated(request, doc_id)
    if err:
        return err
    r = gs.run(doc, payload.pp, payload.code)
    return {"result": r, "broken": gs.broken_outputs(doc, r)}


@router.put("/{doc_id}/code")
def save_code(request, doc_id: UUID, payload: CodeIn):
    """Save the code (the old code is kept as a revert point) and run it. If
    the run drops outputs that parts use, nothing is saved unless `confirm`:
    the reply says which ({saved: false, broken: [{name, parts}]})."""
    doc, err = _generated(request, doc_id)
    if err:
        return err
    trial = gs.run(doc, code=payload.code)
    broken = gs.broken_outputs(doc, trial)
    if broken and not payload.confirm:
        return {"saved": False, "broken": broken, "result": trial}
    r = gs.save_code(doc, payload.code, payload.label, request.user, result=trial)
    return _out(doc, r, saved=True, broken=broken)


@router.put("/{doc_id}/chat")
def save_chat(request, doc_id: UUID, payload: ChatIn):
    """Keep the sketch's chat (data.chat). Doesn't move updated_at."""
    doc, err = _generated(request, doc_id)
    if err:
        return err
    data = dict(shared_defs._data(doc))
    data["chat"] = payload.chat[-200:]
    Document.objects.filter(id=doc.id).update(data=data)
    return {"ok": True}
