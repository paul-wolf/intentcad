"""Copying a document's belongings: used by Duplicate and by the example
projects new organisations get."""
import copy

from .models import ContextFile, DocumentAsset

CONTEXT_FIELDS = ["filename", "title", "note", "content_type", "size", "sha256", "data", "page_count",
                  "width", "height", "page_tokens", "in_context", "pages"]


def copy_context_file(f, user, **owner):
    """A copy of a context file, owned by `project=` or `document=`."""
    return ContextFile.objects.create(created_by=user, **owner, **{k: getattr(f, k) for k in CONTEXT_FIELDS})


def copy_document_extras(src, doc, user):
    """Give `doc` copies of the STEP files `src`'s script imports, its own
    context files and its CAM jobs (settings only; the G-code is generated again)."""
    from cam.models import CamJob

    for a in src.assets.all():
        DocumentAsset.objects.create(
            document=doc, sha256=a.sha256, filename=a.filename, content_type=a.content_type,
            size=a.size, data=a.data, created_by=user)
    for f in src.context_files.all():
        copy_context_file(f, user, document=doc)
    for j in src.cam_jobs.order_by("created_at"):
        CamJob.objects.create(document=doc, name=j.name, profile=j.profile,
                              config=copy.deepcopy(j.config), gcode="", errors=[])
