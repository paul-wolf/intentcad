from django.db.models import Count, Sum
from django.http import JsonResponse
from ninja import Router

from projects.access import require_auth

from .assistant import AssistantError, edit_script
from .models import AiEdit
from .engine import EngineError, run_script
from .paramedit import ParamError, set_params
from .schemas import (
    EditRequest,
    EditResponse,
    ExportRequest,
    ExportResponse,
    MeshOut,
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


@router.post("/run", response=RunResponse)
def run_model(request, payload: RunRequest):
    """Execute a build123d script and return its artifacts (mesh + STEP).

    The model is the script — build123d does the CAD, we return the results.
    """
    err = require_auth(request)
    if err:
        return err
    try:
        r = run_script(payload.code)
    except EngineError as exc:
        return JsonResponse({"message": str(exc)}, status=422)
    return RunResponse(
        mesh=MeshOut(**r["mesh"]),
        faces=[RunFace(**f) for f in r.get("faces", [])],
        edges=[RunEdge(**e) for e in r.get("edges", [])],
        params=r.get("params", {}),
        metrics=RunMetrics(**r["metrics"]),
        warning=r.get("warning"),
    )


@router.post("/export", response=ExportResponse)
def export_model(request, payload: ExportRequest):
    """Export the built model as STL, STEP, or a flat DXF outline, on demand."""
    err = require_auth(request)
    if err:
        return err
    fmt = payload.format.lower()
    if fmt not in ("stl", "step", "stl-parts", "dxf"):
        return JsonResponse({"message": f"unknown format {payload.format!r}"}, status=422)
    try:
        r = run_script(payload.code, export=[fmt])
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


@router.post("/sensitivity", response=SensitivityResponse)
def sensitivity_endpoint(request, payload: SensitivityRequest):
    """Which parameters control which faces (by perturbation). Lets the UI light
    up the parameters relevant to a selected face."""
    err = require_auth(request)
    if err:
        return err
    try:
        m = sensitivity(payload.code)
    except EngineError as exc:
        return JsonResponse({"message": str(exc)}, status=422)
    return SensitivityResponse(params=m)


@router.post("/edit", response=EditResponse)
def edit_model(request, payload: EditRequest):
    """Edit the build123d script from a natural-language instruction (with the
    current selection as the target). Returns a script already validated to build.
    """
    err = require_auth(request)
    if err:
        return err
    history = [{"role": t.role, "text": t.text} for t in payload.history]
    try:
        r = edit_script(payload.code, payload.instruction, payload.context, history,
                        payload.model or None, production=payload.production)
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
