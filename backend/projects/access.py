from django.db.models import Q
from django.http import JsonResponse

from .models import Project, ProjectShare


def can_access_project(user, project):
    """Check if user can access a project (same org, superuser, or shared)."""
    if user.is_superuser:
        return True
    if project.organisation_id == user.organisation_id:
        return True
    return ProjectShare.objects.filter(project=project, user=user).exists()


def get_accessible_projects(user):
    """Return queryset of projects the user can access."""
    if user.is_superuser:
        return Project.objects.all()
    shared_ids = ProjectShare.objects.filter(user=user).values_list("project_id", flat=True)
    return Project.objects.filter(
        Q(organisation_id=user.organisation_id) | Q(id__in=shared_ids)
    ).distinct()


def require_auth(request):
    """Return error response if not authenticated, else None."""
    if not request.user.is_authenticated:
        return JsonResponse({"message": "Authentication required"}, status=401)
    return None


def require_project_access(request, project):
    """Return error response if user cannot access project, else None."""
    if not can_access_project(request.user, project):
        return JsonResponse({"message": "Access denied"}, status=403)
    return None
