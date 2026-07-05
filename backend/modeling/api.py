from django.http import JsonResponse
from ninja import Router

from projects.access import require_auth

from .engine import EngineError, run_script
from .schemas import MeshOut, RunMetrics, RunRequest, RunResponse

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
        step=r["step"],
        metrics=RunMetrics(**r["metrics"]),
    )
