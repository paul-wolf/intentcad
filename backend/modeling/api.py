from django.http import JsonResponse
from ninja import Router

from projects.access import require_auth

from .builder import BuildError, build
from .schemas import BuildRequest, BuildResponse, MeshOut, MetricsOut

router = Router()


@router.post("/", response=BuildResponse)
def build_model(request, payload: BuildRequest):
    """Build a solid from a self-contained feature tree; return mesh + STEP.

    Stateless: nothing is persisted. The referenced sketches are supplied inline
    in the request body (see modeling/schemas.py).
    """
    err = require_auth(request)
    if err:
        return err
    try:
        result = build(payload)
    except BuildError as exc:
        return JsonResponse({"message": str(exc)}, status=422)

    return BuildResponse(
        mesh=MeshOut(
            positions=result.positions,
            normals=result.normals,
            triangle_count=result.triangle_count,
        ),
        step=result.step,
        metrics=MetricsOut(**result.metrics),
        warnings=result.warnings,
    )
