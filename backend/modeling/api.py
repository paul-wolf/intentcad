from uuid import UUID

from django.db.models import Count, Sum
from django.http import JsonResponse
from ninja import Router

from documents.api import document_or_error
from projects.access import require_auth

from .assistant import AssistantError, edit_script
from .models import AiEdit
from .engine import EngineError, run_script
from . import hole_presets
from .llm_models import list_models
from .paramedit import ParamError, add_edge_op, add_extrude, add_holes, add_shell, op_at, set_params
from .schemas import (
    AddEdgeOpRequest,
    AddExtrudeRequest,
    AddExtrudeResponse,
    AddHolesRequest,
    AddOpResponse,
    AddShellRequest,
    OpAtRequest,
    OpAtResponse,
    EditRequest,
    EditResponse,
    ExportRequest,
    ExportResponse,
    MeshOut,
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
    script, with its depth as a new parameter, and return the updated script."""
    err = require_auth(request)
    if err:
        return err
    try:
        code, param = add_extrude(payload.code, payload.sketch, payload.op, payload.depth,
                                  payload.through, payload.flip, payload.datum, payload.both)
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


@router.get("/hole_presets")
def hole_presets_endpoint(request):
    """Every hole size the Hole dialog offers (modeling/hole_presets.py)."""
    err = require_auth(request)
    if err:
        return err
    return hole_presets.table()


@router.post("/op_at", response=OpAtResponse)
def op_at_endpoint(request, payload: OpAtRequest):
    """The shell()/holes()/fillet()/chamfer() line at `line`, read back for its dialog."""
    err = require_auth(request)
    if err:
        return err
    try:
        return OpAtResponse(**op_at(payload.code, payload.line))
    except (ParamError, SyntaxError, KeyError) as exc:
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
    try:
        r = edit_script(payload.code, payload.instruction, payload.context, history,
                        payload.model or None, production=payload.production,
                        build_error=payload.build_error, document_id=payload.document_id)
    except AssistantError as exc:
        return JsonResponse({"message": str(exc)}, status=422)
    AiEdit.objects.create(
        user=request.user, document_id=payload.document_id,
        instruction=payload.instruction[:500],
        tokens_in=r.get("tokens_in", 0), tokens_out=r.get("tokens_out", 0),
        cost_usd=r.get("cost_usd", 0.0),
    )
    return EditResponse(
        kind=r.get("kind", "edit"),
        code=r.get("code", ""), note=r.get("note"), question=r.get("question", ""),
        tokens_in=r.get("tokens_in", 0), tokens_out=r.get("tokens_out", 0),
        cost_usd=r.get("cost_usd", 0.0),
    )


@router.get("/models", response=ModelsResponse)
def models(request):
    """Which Claude models the AI edit can use — discovered from the Models API
    (cached an hour) so the picker never goes stale."""
    err = require_auth(request)
    if err:
        return err
    return ModelsResponse(**list_models())


@router.get("/usage", response=UsageResponse)
def usage(request, document: str = ""):
    """AI spend for this document and this user all-time (from the edit log)."""
    err = require_auth(request)
    if err:
        return err

    def totals(qs) -> UsageTotals:
        a = qs.aggregate(edits=Count("id"), tin=Sum("tokens_in"),
                         tout=Sum("tokens_out"), cost=Sum("cost_usd"))
        return UsageTotals(edits=a["edits"] or 0, tokens_in=a["tin"] or 0,
                           tokens_out=a["tout"] or 0, cost_usd=round(a["cost"] or 0.0, 4))

    mine = AiEdit.objects.filter(user=request.user)
    return UsageResponse(document=totals(mine.filter(document_id=document)), all_time=totals(mine))
