"""The example project new organisations get: a superuser marks one project,
and each new organisation gets its own copy of it."""
import copy

from django.db import transaction

from documents.copying import copy_context_file, copy_document_extras
from documents.models import Document, DocumentVersion

from .models import Project


def examples_project():
    return Project.objects.filter(is_examples=True).first()


def set_examples_project(project):
    """Mark `project` (or none) as the examples; only one is marked."""
    with transaction.atomic():
        Project.objects.filter(is_examples=True).exclude(pk=getattr(project, "pk", None)).update(is_examples=False)
        if project is not None and not project.is_examples:
            project.is_examples = True
            project.save(update_fields=["is_examples"])


def copy_examples(org, user):
    """Copy the examples project into `org`: a project of the same name, made by
    `user`, with every part and sketch (the model, its STEP files, its context
    files, its CAM jobs without G-code), the project's context files, and one
    starting version per part. Returns (project, None), or (None, why not)."""
    src = examples_project()
    if src is None:
        return None, "No project is chosen as the examples"
    if Project.objects.filter(organisation=org, name=src.name).exists():
        return None, f'{org.name} already has a project called "{src.name}"'
    with transaction.atomic():
        project = Project.objects.create(name=src.name, description=src.description,
                                         brief=src.brief, brief_updated_at=src.brief_updated_at,
                                         organisation=org, created_by=user)
        for f in src.context_files.all():
            copy_context_file(f, user, project=project)
        for d in src.documents.order_by("created_at"):
            data = copy.deepcopy(d.data)
            doc = Document.objects.create(name=d.name, data=data, description=d.description,
                                          project=project, created_by=user)
            code = data.get("modelCode") if isinstance(data, dict) else None
            if isinstance(code, str) and code.strip():
                DocumentVersion.objects.create(document=doc, data=data, label="example", created_by=user)
            copy_document_extras(d, doc, user)
    return project, None
