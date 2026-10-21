from uuid import UUID

from django.db.models import Count, Sum
from django.http import JsonResponse
from ninja import Router

from documents.api import document_or_error
from projects.access import require_auth

from .assistant import AssistantError, edit_script
from .models import AiEdit
from documents.context import ContextFileError, ai_blocks
from .engine import EngineError, run_script
from . import hole_presets
from .llm_models import list_models
from .paramedit import (ParamError, add_edge_op, add_extrude, add_holes, add_mirror_body, add_plane, add_shell,
                        delete_step, edit_args, mirror_steps, op_at, rename_plane, set_params, steps, suppress,
                        unlink)
from .schemas import (
    AddEdgeOpRequest,
    AddExtrudeRequest,
    AddExtrudeResponse,
    AddHolesRequest,
    AddMirrorBodyRequest,
    AddOpResponse,
    AddPlaneRequest,
    AddPlaneResponse,
    AddShellRequest,
    RenamePlaneRequest,
    CodeResponse,
    EditArgsRequest,
    EditArgsResponse,
    OpAtRequest,
    OpAtResponse,
    EditRequest,
    EditResponse,
    ExportRequest,
    ExportResponse,
    MeshOut,
    MirrorStepsRequest,
    MirrorStepsResponse,
    ModelsResponse,
    RunEdge,
    RunFace,
    RunMetrics,
    RunRequest,
    RunResponse,
    SensitivityRequest,
    SensitivityResponse,
    SetParamsRequest,
    SetParamsResponse,
    StepLineRequest,
    StepsRequest,
    StepsResponse,
    UsageResponse,
    UsageTotals,
)
from .sensitivity import sensitivity

router = Router()


def _check_document(request, document_id: str):
    """The request's document (whose uploaded files a script may import) must be
    one the user can edit. None if fine (or no document given), else an error."""
    err = require_auth(request)
    if err or not document_id:
        return err
    try:
        UUID(document_id)
    except ValueError:
        return JsonResponse({"message": "unknown document"}, status=404)
    return document_or_error(request, document_id)[1]


@router.post("/run", response=RunResponse)
def run_model(request, payload: RunRequest):
    """Execute a build123d script and return its artifacts (mesh + STEP).

    The model is the script — build123d does the CAD, we return the results.
    """
    err = _check_document(request, payload.document_id)
    if err:
        return err
    try:
        r = run_script(payload.code, document_id=payload.document_id,
                       sketches=payload.sketches)
    except EngineError as exc:
        body = {"message": str(exc), "params": exc.params}
        if exc.fix:
            body["fix"] = exc.fix
        return JsonResponse(body, status=422)
    return RunResponse(
        mesh=MeshOut(**r["mesh"]),
        faces=[RunFace(**f) for f in r.get("faces", [])],
        edges=[RunEdge(**e) for e in r.get("edges", [])],
        params=r.get("params", {}),
        metrics=RunMetrics(**r["metrics"]),
        warning=r.get("warning"),
        fix=r.get("fix"),
        auto_round=r.get("auto_round"),
        organic=r.get("organic"),
        sketches=r.get("sketches") or {},
        face_refs=r.get("face_refs") or [],
        edge_refs=r.get("edge_refs") or [],
        planes=r.get("planes") or {},
        kept=r.get("kept") or [],
    )


@router.post("/export", response=ExportResponse)
def export_model(request, payload: ExportRequest):
    """Export the built model as STL, STEP, or a flat DXF outline, on demand."""
    err = _check_document(request, payload.document_id)
    if err:
        return err
    fmt = payload.format.lower()
    if fmt not in ("stl", "step", "stl-parts", "dxf", "dxf-views"):
        return JsonResponse({"message": f"unknown format {payload.format!r}"}, status=422)
    try:
        r = run_script(payload.code, export=[fmt], document_id=payload.document_id,
                       sketches=payload.sketches)
    except EngineError as exc:
        return JsonResponse({"message": str(exc)}, status=422)
    return ExportResponse(format=fmt, data=r.get("exports", {}).get(fmt, ""))


@router.post("/set_params", response=SetParamsResponse)
def set_params_endpoint(request, payload: SetParamsRequest):
    """Change values in the script's params dict (preserving formatting), and
    return the updated script — the source of truth stays the script."""
    err = require_auth(request)
    if err:
        return err
    try:
        code = set_params(payload.code, payload.params)
    except (ParamError, SyntaxError) as exc:
        return JsonResponse({"message": str(exc)}, status=422)
    return SetParamsResponse(code=code)


@router.post("/add_extrude", response=AddExtrudeResponse)
def add_extrude_endpoint(request, payload: AddExtrudeRequest):
    """Append an extrude (cut, join, or the first body) of a sketch to the
    script, with its depth as a new parameter (or rewrite the extrude line on
    `line`), and return the updated script."""
    err = require_auth(request)
    if err:
        return err
    try:
        code, param = add_extrude(payload.code, payload.sketch, payload.op, payload.depth,
                                  payload.through, payload.flip, payload.datum, payload.both, payload.line)
    except (ParamError, SyntaxError) as exc:
        return JsonResponse({"message": str(exc)}, status=422)
    return AddExtrudeResponse(code=code, param=param)


@router.post("/add_shell", response=AddOpResponse)
def add_shell_endpoint(request, payload: AddShellRequest):
    """Append a shell() line (or rewrite the one on `line`), its thickness a
    P key, and return the updated script."""
    err = require_auth(request)
    if err:
        return err
    try:
        code, param = add_shell(payload.code, payload.remove, payload.thickness,
                                payload.inside, payload.line)
    except (ParamError, SyntaxError) as exc:
        return JsonResponse({"message": str(exc)}, status=422)
    return AddOpResponse(code=code, param=param)


@router.post("/add_holes", response=AddOpResponse)
def add_holes_endpoint(request, payload: AddHolesRequest):
    """Append a holes() line (or rewrite the one on `line`), its depth and
    changed sizes P keys, and return the updated script."""
    err = require_auth(request)
    if err:
        return err
    try:
        code, param = add_holes(payload.code, payload.at, payload.kind, payload.size, payload.depth,
                                payload.fit, payload.standoff, payload.sizes, payload.line)
    except (ParamError, SyntaxError, KeyError, TypeError, ValueError) as exc:
        return JsonResponse({"message": str(exc)}, status=422)
    return AddOpResponse(code=code, param=param)


@router.post("/add_edge_op", response=AddOpResponse)
def add_edge_op_endpoint(request, payload: AddEdgeOpRequest):
    """Append a fillet()/chamfer() line on edges (or rewrite the one on
    `line`), its size a P key, and return the updated script."""
    err = require_auth(request)
    if err:
        return err
    try:
        code, param = add_edge_op(payload.code, payload.op, payload.edges, payload.size, payload.line)
    except (ParamError, SyntaxError, KeyError, TypeError, ValueError) as exc:
        return JsonResponse({"message": str(exc)}, status=422)
    return AddOpResponse(code=code, param=param)


@router.post("/add_plane", response=AddPlaneResponse)
def add_plane_endpoint(request, payload: AddPlaneRequest):
    """Append a construction plane line (or rewrite the one on `line`; a new
    name renames every PLANES["old"]), and return the updated script."""
    err = require_auth(request)
    if err:
        return err
    try:
        code, renamed = add_plane(payload.code, payload.op, payload.name, base=payload.base,
                                  distance=payload.distance, edge=payload.edge, angle=payload.angle,
                                  from_face=payload.from_face, line=payload.line)
    except (ParamError, SyntaxError, KeyError, TypeError, ValueError) as exc:
        return JsonResponse({"message": str(exc)}, status=422)
    return AddPlaneResponse(code=code, renamed=renamed)


@router.post("/rename_plane", response=CodeResponse)
def rename_plane_endpoint(request, payload: RenamePlaneRequest):
    """Rename a construction plane: every PLANES["old"] of the script."""
    err = require_auth(request)
    if err:
        return err
    try:
        return CodeResponse(code=rename_plane(payload.code, payload.old, payload.new))
    except (ParamError, SyntaxError) as exc:
        return JsonResponse({"message": str(exc)}, status=422)


@router.get("/hole_presets")
def hole_presets_endpoint(request):
    """Every hole size the Hole dialog offers (modeling/hole_presets.py)."""
    err = require_auth(request)
    if err:
        return err
    return hole_presets.table()


@router.post("/op_at", response=OpAtResponse)
def op_at_endpoint(request, payload: OpAtRequest):
    """The operation line at `line`, read back for its dialog."""
    err = require_auth(request)
    if err:
        return err
    try:
        return OpAtResponse(**op_at(payload.code, payload.line, payload.datum))
    except (ParamError, SyntaxError, KeyError, TypeError, ValueError) as exc:
        return JsonResponse({"message": str(exc)}, status=422)


@router.post("/edit_args", response=EditArgsResponse)
def edit_args_endpoint(request, payload: EditArgsRequest):
    """Rewrite an auto_round()/truss_windows() line with its dialog's values,
    keeping every argument the dialog doesn't know."""
    err = require_auth(request)
    if err:
        return err
    try:
        code, params = edit_args(payload.code, payload.line, payload.op, payload.values, payload.keep,
                                 payload.make_param)
    except (ParamError, SyntaxError, KeyError, TypeError, ValueError) as exc:
        return JsonResponse({"message": str(exc)}, status=422)
    return EditArgsResponse(code=code, params=params)


@router.post("/steps", response=StepsResponse)
def steps_endpoint(request, payload: StepsRequest):
    """The steps list: the script's operations in order, summed up."""
    err = require_auth(request)
    if err:
        return err
    return StepsResponse(steps=steps(payload.code, payload.datum, payload.points))


@router.post("/suppress_step", response=CodeResponse)
def suppress_step_endpoint(request, payload: StepLineRequest):
    """Switch the step on `line` off (commented out behind "# off: ") or back on."""
    err = require_auth(request)
    if err:
        return err
    try:
        return CodeResponse(code=suppress(payload.code, payload.line, payload.off, payload.copies == "with"))
    except (ParamError, SyntaxError) as exc:
        return JsonResponse({"message": str(exc)}, status=422)


@router.post("/delete_step", response=CodeResponse)
def delete_step_endpoint(request, payload: StepLineRequest):
    """Delete the step on `line`, and the P keys only it used (its mirrored
    copies too, with copies='delete'; else they stay, unlinked)."""
    err = require_auth(request)
    if err:
        return err
    try:
        return CodeResponse(code=delete_step(payload.code, payload.line, payload.copies))
    except (ParamError, SyntaxError) as exc:
        return JsonResponse({"message": str(exc)}, status=422)


@router.post("/add_mirror_body", response=CodeResponse)
def add_mirror_body_endpoint(request, payload: AddMirrorBodyRequest):
    """Append `part = mirror_body(part, PLANE, join=...)` (or rewrite the one on `line`)."""
    err = require_auth(request)
    if err:
        return err
    try:
        return CodeResponse(code=add_mirror_body(payload.code, payload.plane, payload.join, payload.line,
                                                    gap=payload.gap))
    except (ParamError, SyntaxError, KeyError, TypeError, ValueError) as exc:
        return JsonResponse({"message": str(exc)}, status=422)


@router.post("/mirror_steps", response=MirrorStepsResponse)
def mirror_steps_endpoint(request, payload: MirrorStepsRequest):
    """A mirrored copy of each chosen step, linked to it, after the last of them."""
    err = require_auth(request)
    if err:
        return err
    try:
        code, made, skipped = mirror_steps(payload.code, payload.lines, payload.plane)
    except (ParamError, SyntaxError, KeyError, TypeError, ValueError) as exc:
        return JsonResponse({"message": str(exc)}, status=422)
    return MirrorStepsResponse(code=code, made=made, skipped=skipped)


@router.post("/unlink_step", response=CodeResponse)
def unlink_step_endpoint(request, payload: StepLineRequest):
    """The mirrored copy on `line` without its link: a step of its own."""
    err = require_auth(request)
    if err:
        return err
    try:
        return CodeResponse(code=unlink(payload.code, payload.line))
    except (ParamError, SyntaxError) as exc:
        return JsonResponse({"message": str(exc)}, status=422)


@router.post("/sensitivity", response=SensitivityResponse)
def sensitivity_endpoint(request, payload: SensitivityRequest):
    """Which parameters control which faces (by perturbation). Lets the UI light
    up the parameters relevant to a selected face."""
    err = _check_document(request, payload.document_id)
    if err:
        return err
    try:
        m = sensitivity(payload.code, document_id=payload.document_id, sketches=payload.sketches)
    except EngineError as exc:
        return JsonResponse({"message": str(exc)}, status=422)
    return SensitivityResponse(params=m)


@router.post("/edit", response=EditResponse)
def edit_model(request, payload: EditRequest):
    """Edit the build123d script from a natural-language instruction (with the
    current selection as the target). Returns a script already validated to build.
    """
    err = _check_document(request, payload.document_id)
    if err:
        return err
    history = [{"role": t.role, "text": t.text} for t in payload.history]
    sent = context_files_for(payload.document_id, payload.skip_context)
    try:
        prepared = ai_blocks(sent)
    except ContextFileError as exc:
        return JsonResponse({"message": str(exc)}, status=exc.status)
    try:
        r = edit_script(payload.code, payload.instruction, payload.context, history,
                        payload.model or None, production=payload.production,
                        build_error=payload.build_error, document_id=payload.document_id,
                        files=prepared.blocks, file_listing=prepared.listing)
    except AssistantError as exc:
        # a failed edit can still have been billed (a script that didn't build,
        # then a retry): log that spend and report it with the error
        if exc.usage:
            _log_ai_edit(request, payload, exc.usage)
        return JsonResponse({"message": str(exc), **(exc.usage or {})}, status=422)
    usage = _log_ai_edit(request, payload, r)
    return EditResponse(
        kind=r.get("kind", "edit"),
        code=r.get("code", ""), note=r.get("note"), question=r.get("question", ""),
        cost_usd=r.get("cost_usd", 0.0), context_files=[str(cf.id) for cf in sent], **usage,
    )


def context_files_for(document_id: str, skip: list[str]) -> list:
    """The context files sent with an edit of `document_id`: the project's and
    then the part's files that are in context, minus those skipped for this
    message. Project files go first: they change least, so they head the
    cached prefix."""
    from django.core.exceptions import ValidationError
    from documents.models import ContextFile, Document

    if not document_id:
        return []
    try:
        doc = Document.objects.filter(id=document_id).only("id", "project_id").first()
    except (ValidationError, ValueError):
        return []
    if not doc:
        return []
    files = list(ContextFile.objects.filter(project_id=doc.project_id, in_context=True)) \
        if doc.project_id else []
    files += list(ContextFile.objects.filter(document=doc, in_context=True))
    skip = set(skip)
    return [cf for cf in files if str(cf.id) not in skip]


def _log_ai_edit(request, payload, r: dict) -> dict:
    """Record one AI edit's spend; returns its token counts."""
    usage = {k: r.get(k, 0) for k in ("tokens_in", "tokens_out", "cache_read_tokens",
                                      "cache_write_tokens")}
    AiEdit.objects.create(
        user=request.user, document_id=payload.document_id,
        instruction=payload.instruction[:500], cost_usd=r.get("cost_usd", 0.0), **usage,
    )
    return usage


@router.get("/models", response=ModelsResponse)
def models(request, refresh: bool = False):
    """Which Claude models the AI edit can use — discovered from the Models API
    (cached an hour) so the picker never goes stale. `refresh` asks the API
    again now (at most once a minute)."""
    err = require_auth(request)
    if err:
        return err
    return ModelsResponse(**list_models(force=refresh))


@router.get("/usage", response=UsageResponse)
def usage(request, document: str = ""):
    """AI spend for this document and this user all-time (from the edit log)."""
    err = require_auth(request)
    if err:
        return err

    def totals(qs) -> UsageTotals:
        a = qs.aggregate(edits=Count("id"), tin=Sum("tokens_in"), tout=Sum("tokens_out"),
                         cread=Sum("cache_read_tokens"), cost=Sum("cost_usd"))
        return UsageTotals(edits=a["edits"] or 0, tokens_in=a["tin"] or 0,
                           tokens_out=a["tout"] or 0, cache_read_tokens=a["cread"] or 0,
                           cost_usd=round(a["cost"] or 0.0, 4))

    mine = AiEdit.objects.filter(user=request.user)
    return UsageResponse(document=totals(mine.filter(document_id=document)), all_time=totals(mine))
