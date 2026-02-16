from django.http import JsonResponse

from .models import Project


def can_access_project(user, project):
    """Check if user can access a project (same org or superuser)."""
    if user.is_superuser:
        return True
    return project.organisation_id == user.organisation_id


def get_accessible_projects(user):
    """Return queryset of projects the user can access."""
    if user.is_superuser:
        return Project.objects.all()
    return Project.objects.filter(organisation_id=user.organisation_id)


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
