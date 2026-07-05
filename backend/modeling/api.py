from django.http import JsonResponse
from ninja import Router

from projects.access import require_auth

from .agent import plan_operations
from .builder import BuildError, build
from .resolver import ResolverError, resolve_reference
from .schemas import (
    BuildRequest,
    BuildResponse,
    ChatRequest,
    ChatResponse,
    EdgeOut,
    FaceOut,
    MeshOut,
    MetricsOut,
    ResolveRequest,
    ResolveResponse,
)

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
        faces=[FaceOut(**f) for f in result.faces],
        edges=[EdgeOut(**e) for e in result.edges],
        warnings=result.warnings,
    )


@router.post("/resolve", response=ResolveResponse)
def resolve_model(request, payload: ResolveRequest):
    """Resolve a natural-language reference ('the joint', 'the back face') to a
    formal selector, grounded in the inventory of an already-built result.

    The AI layer's plug-in point: it maps intent onto the selection subsystem.
    """
    err = require_auth(request)
    if err:
        return err
    faces = [f.dict() for f in payload.faces]
    edges = [e.dict() for e in payload.edges]
    try:
        result = resolve_reference(payload.reference, faces, edges)
    except ResolverError as exc:
        return JsonResponse({"message": str(exc)}, status=422)
    return ResolveResponse(**result)


@router.post("/chat", response=ChatResponse)
def chat_edit(request, payload: ChatRequest):
    """Turn a natural-language instruction into feature-tree operations to append.

    The chat agent (modeling/agent.py) reads the current tree + sketches + built
    inventory and proposes features in the same shape the manual UI produces.
    """
    err = require_auth(request)
    if err:
        return err
    try:
        result = plan_operations(
            payload.instruction,
            [s.dict() for s in payload.sketches],
            [f.dict() for f in payload.features],
            [f.dict() for f in payload.faces],
            [e.dict() for e in payload.edges],
        )
    except ResolverError as exc:
        return JsonResponse({"message": str(exc)}, status=422)
    return ChatResponse(**result)
