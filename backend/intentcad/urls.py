from django.conf import settings
from django.http import FileResponse
from django.urls import path, re_path
from ninja import NinjaAPI

from accounts.api import router as auth_router
from cam.api import router as cam_router
from documents.api import router as documents_router
from documents.context_api import router as context_router
from modeling.api import router as modeling_router
from projects.api import router as projects_router

api = NinjaAPI(title="IntentCAD API", version="0.1.0")
api.add_router("/auth", auth_router)
api.add_router("/projects", projects_router)
api.add_router("/documents", documents_router)
api.add_router("/context", context_router)
api.add_router("/build", modeling_router)
api.add_router("/cam", cam_router)


def spa_index(request):
    index = settings.WHITENOISE_ROOT / "index.html"
    if index.exists():
        return FileResponse(open(index, "rb"), content_type="text/html")
    from django.http import HttpResponse
    return HttpResponse("Frontend not built", status=404)


urlpatterns = [
    path("api/", api.urls),
    re_path(r"^(?!api/|static/).*$", spa_index),
]
