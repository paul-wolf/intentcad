from django.http import JsonResponse
from ninja import Router

from projects.access import require_auth

from .assistant import AssistantError, edit_script
from .engine import EngineError, run_script
from .schemas import (
    EditRequest,
    EditResponse,
    MeshOut,
    RunEdge,
    RunFace,
    RunMetrics,
    RunRequest,
    RunResponse,
)

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
        step=r["step"],
        metrics=RunMetrics(**r["metrics"]),
    )


@router.post("/edit", response=EditResponse)
def edit_model(request, payload: EditRequest):
    """Edit the build123d script from a natural-language instruction (with the
    current selection as the target). Returns a script already validated to build.
    """
    err = require_auth(request)
    if err:
        return err
    try:
        r = edit_script(payload.code, payload.instruction, payload.context)
    except AssistantError as exc:
        return JsonResponse({"message": str(exc)}, status=422)
    return EditResponse(code=r["code"], note=r.get("note"))
