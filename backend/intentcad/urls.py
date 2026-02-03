from django.urls import path
from ninja import NinjaAPI
from documents.api import router as documents_router

api = NinjaAPI(title="IntentCAD API", version="0.1.0")
api.add_router("/documents", documents_router)

urlpatterns = [
    path("api/", api.urls),
]
