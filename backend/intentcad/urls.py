from django.urls import path
from ninja import NinjaAPI

from accounts.api import router as auth_router
from cam.api import router as cam_router
from documents.api import router as documents_router
from parts.api import router as parts_router
from projects.api import router as projects_router

api = NinjaAPI(title="IntentCAD API", version="0.1.0")
api.add_router("/auth", auth_router)
api.add_router("/projects", projects_router)
api.add_router("/documents", documents_router)
api.add_router("/parts", parts_router)
api.add_router("/cam", cam_router)

urlpatterns = [
    path("api/", api.urls),
]
