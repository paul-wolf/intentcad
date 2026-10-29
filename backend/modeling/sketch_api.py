"""Generated sketch endpoints (/api/sketches): make one, try its code with other
parameter values, save its code, keep its chat. See modeling/generated_sketch.py."""
from __future__ import annotations

import re

from typing import Any
from uuid import UUID

from django.db import transaction
from django.http import JsonResponse
from django.shortcuts import get_object_or_404
from ninja import Router, Schema

from documents.api import document_or_error
from documents.models import Document
from documents.versions import saved_code_version
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
    # (an AI edit) the version of the saved code it started from (the ask's
    # base_version): nothing is saved if the saved code isn't that any more
    expect_version: str | None = None
    # (an AI edit applied over unsaved code in the editor) that code: kept as
    # a revert point too, so applying never loses it
    replaced: str | None = None


class ChatIn(Schema):
    chat: list[dict[str, Any]]


class Turn(Schema):
    role: str           # 'user' | 'assistant'
    text: str


class AskIn(Schema):
    instruction: str
    history: list[Turn] = []
    model: str = ""
    skip_context: list[str] = []     # context files not to send with this message
    mentions: list[str] = []         # ids of the parts @-mentioned
    code: str | None = None          # (generated) the editor's unsaved code, to edit instead of the saved code


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


DEFAULT_NAME = re.compile(r"^(Sketch|Untitled)( \(?\d+\)?)?$")


def _free_name(project, name: str) -> str:
    """`name`, or "name (2)", … if the project has one already."""
    taken = set(Document.objects.filter(project=project).values_list("name", flat=True))
    base, n = name, 2
    while name in taken:
        name, n = f"{base} ({n})", n + 1
    return name


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
            # a sketch still called what New sketch called it takes the name the AI gave
            if payload.name.strip() and DEFAULT_NAME.match(src.name):
                src.name = _free_name(src.project, payload.name.strip())
                src.data = {**(src.data or {}), "name": src.name}
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
    name = _free_name(project, payload.name.strip() or "Generated sketch")
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
    if payload.expect_version is not None and saved_code_version(doc, "code") != payload.expect_version:
        # changed in another tab or browser since the AI started: the editor holds the edit
        return {"saved": False, "changed": True, "broken": []}
    trial = gs.run(doc, code=payload.code)
    broken = gs.broken_outputs(doc, trial)
    if broken and not payload.confirm:
        return {"saved": False, "broken": broken, "result": trial}
    r = gs.save_code(doc, payload.code, payload.label, request.user, result=trial, replaced=payload.replaced)
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


@router.post("/{doc_id}/ask")
def ask(request, doc_id: UUID, payload: AskIn):
    """One turn of a sketch's chat (modeling/sketch_chat.py), drawn or
    generated. Saves nothing: the editor saves an edit as a revert point
    (PUT /code) and makes a proposed generated sketch (POST /create)."""
    from documents.context import ContextFileError, ai_blocks

    from .api import context_files_for, log_ai_call, sees_spend
    from .assistant import AssistantError
    from .sketch_chat import sketch_chat

    doc, err = document_or_error(request, doc_id)
    if err:
        return err
    generated = gs.is_generated(doc)
    base_version = saved_code_version(doc, "code")
    if generated and payload.code is not None:   # edit the editor's code (not saved, and not saved by this)
        doc.data = {**shared_defs._data(doc), "code": payload.code}
    base_code = shared_defs._data(doc).get("code") or ""
    sent = context_files_for(str(doc.id), payload.skip_context)
    try:
        prepared = ai_blocks(sent)
    except ContextFileError as exc:
        return JsonResponse({"message": str(exc)}, status=exc.status)
    try:
        r = sketch_chat(doc, payload.instruction, [{"role": t.role, "text": t.text} for t in payload.history], payload.model or None,
                        files=prepared.blocks, file_listing=prepared.listing, mentions=payload.mentions)
    except AssistantError as exc:
        if exc.usage:
            log_ai_call(request, "sketch chat", str(doc.id), payload.instruction, exc.usage, failed=True)
        spend = (exc.usage or {}) if sees_spend(request.user) else {}
        return JsonResponse({"message": str(exc), **spend}, status=422)
    usage = log_ai_call(request, "sketch chat", str(doc.id), payload.instruction, r)
    spend = {"cost_usd": r.get("cost_usd", 0.0), **usage} if sees_spend(request.user) else {}
    keep = ("kind", "code", "note", "result", "broken", "parameter_proposals", "sentence", "name",
            "empty", "question", "answer")
    # an edit says what it was made from: the code it edited, and the saved code's version then
    base = {"base_code": base_code, "base_version": base_version} if generated and r.get("kind") == "edit" else {}
    return {**{k: r[k] for k in keep if k in r}, **base, "context_files": [str(cf.id) for cf in sent], **spend}
