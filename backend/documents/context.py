"""Context files: reading uploads, page thumbnails, and the content blocks the
AI gets for them.

A context file is a PDF or an image. On upload it is checked by its bytes (not
its name), HEIC photos are converted to JPEG, and each page gets an estimated
token cost. For the AI, PDFs are sent as document blocks holding only the
chosen pages, and images are downscaled; both carry cache_control so repeated
chat turns with the same files are read from the prompt cache.
"""

from __future__ import annotations

import base64
import hashlib
import io
import math
import threading
from dataclasses import dataclass, field

MAX_BYTES = 25 * 1024 * 1024

# Anthropic input limits (platform.claude.com docs, "PDF support" and "Vision",
# checked October 2026): a request is at most 32 MB; at most 100 PDF pages per
# request (600 with a 1M context window — we stay at the lower one); at most 100
# images per request, each at most 8000 px and 10 MB; encrypted PDFs are refused.
MAX_REQUEST_BYTES = 32 * 1024 * 1024
REQUEST_HEADROOM = 1024 * 1024          # the prompt, tools and JSON around the files
MAX_PDF_PAGES = 100
MAX_IMAGES = 100
MAX_IMAGE_BYTES = 10 * 1024 * 1024      # base64

AI_IMAGE_EDGE = 1600      # long edge of an image sent to the AI (the original is kept)
IMAGE_TOKEN_CAP = 4784    # the most one image costs (high-resolution tier)
PAGE_IMAGE_TOKENS = 1568  # each PDF page is also sent as an image
THUMB_WIDTHS = (160, 320, 800, 1600)

KINDS = {
    "application/pdf": ".pdf",
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
}


class ContextFileError(ValueError):
    """An upload or a request the AI can't take, with a message for the user."""

    def __init__(self, message: str, status: int = 422):
        super().__init__(message)
        self.status = status


@dataclass
class Ingested:
    filename: str
    content_type: str
    data: bytes
    sha256: str
    page_count: int | None = None
    width: int | None = None
    height: int | None = None
    page_tokens: list[int] = field(default_factory=list)


def sniff(data: bytes) -> str:
    """The file's type from its first bytes: a content type, "image/heic", or ""."""
    if data[:5] == b"%PDF-":
        return "application/pdf"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    if data[4:8] == b"ftyp" and data[8:12] in (b"heic", b"heix", b"hevc", b"heim",
                                               b"heis", b"mif1", b"msf1", b"avif"):
        return "image/heic"
    return ""


def _with_ext(filename: str, ext: str) -> str:
    stem = filename.rsplit(".", 1)[0] if "." in filename else filename
    return (stem or "photo") + ext


def image_tokens(w: int, h: int) -> int:
    """Input tokens for an image of w × h px, as sent (after our downscale)."""
    s = min(1.0, AI_IMAGE_EDGE / max(w, h, 1))
    w, h = max(1, round(w * s)), max(1, round(h * s))
    return min(IMAGE_TOKEN_CAP, math.ceil(w / 28) * math.ceil(h / 28))


def _open_image(data: bytes):
    from PIL import Image, ImageOps
    try:
        img = Image.open(io.BytesIO(data))
        img.load()
    except Exception as exc:    # PIL raises many types, incl. DecompressionBombError
        raise ContextFileError(f"the image can't be read ({exc})") from exc
    return ImageOps.exif_transpose(img)   # phone photos: apply the rotation flag


def _heic_to_jpeg(data: bytes) -> bytes:
    try:
        import pillow_heif
    except ImportError as exc:  # pragma: no cover
        raise ContextFileError("HEIC photos aren't supported here: share the photo as JPEG "
                               "(on an iPhone: Settings › Camera › Formats › Most Compatible, "
                               "or share it via Mail/Files, which converts it).", 415) from exc
    pillow_heif.register_heif_opener()
    img = _open_image(data).convert("RGB")
    out = io.BytesIO()
    img.save(out, "JPEG", quality=92)   # no EXIF: drops the photo's location too
    return out.getvalue()


def _read_pdf(data: bytes):
    """A pypdf reader, decrypting a PDF that only has an owner password (the
    usual 'no copying' datasheet). Returns (reader, bytes the AI can take)."""
    from pypdf import PdfReader, PdfWriter
    from pypdf.errors import PdfReadError
    try:
        reader = PdfReader(io.BytesIO(data))
        if reader.is_encrypted:
            if not reader.decrypt(""):
                raise ContextFileError("the PDF is password-protected; save an unprotected copy "
                                       "(print it to PDF) and upload that.", 415)
            w = PdfWriter(clone_from=reader)
            buf = io.BytesIO()
            w.write(buf)
            data = buf.getvalue()
            reader = PdfReader(io.BytesIO(data))
        len(reader.pages)
    except ContextFileError:
        raise
    except (PdfReadError, Exception) as exc:
        raise ContextFileError(f"the PDF can't be read ({exc})") from exc
    return reader, data


def _page_text_tokens(page) -> int:
    try:
        text = page.extract_text() or ""
    except Exception:
        text = ""
    # ~3 characters per token across scripts (Cyrillic runs denser than English)
    return math.ceil(len(text.strip()) / 3)


def ingest(data: bytes, filename: str) -> Ingested:
    """Check an upload and read what the cards need. Raises ContextFileError
    with a message for the user (status 413 too big, 415 wrong type)."""
    if len(data) > MAX_BYTES:
        raise ContextFileError(f"{filename} is {len(data) / 1e6:.1f} MB; the limit is "
                               f"{MAX_BYTES // (1024 * 1024)} MB.", 413)
    kind = sniff(data)
    if kind == "image/heic":
        data = _heic_to_jpeg(data)
        filename, kind = _with_ext(filename, ".jpg"), "image/jpeg"
    if not kind:
        raise ContextFileError(f"{filename} isn't a PDF, PNG, JPEG or WebP file. iPhone photos "
                               "(HEIC) are converted; for anything else, export a PDF or JPEG.",
                               415)
    out = Ingested(filename=filename, content_type=kind, data=data,
                   sha256=hashlib.sha256(data).hexdigest())
    try:
        if kind == "application/pdf":
            reader, data = _read_pdf(data)
            out.data, out.sha256 = data, hashlib.sha256(data).hexdigest()
            out.page_count = len(reader.pages)
            if not out.page_count:
                raise ContextFileError(f"{filename} has no pages.")
            out.page_tokens = [_page_text_tokens(p) + PAGE_IMAGE_TOKENS for p in reader.pages]
        else:
            img = _open_image(data)
            out.width, out.height = img.size
            out.page_tokens = [image_tokens(*img.size)]
    except ContextFileError as exc:
        msg = str(exc)
        raise ContextFileError(msg if msg.startswith(filename) else f"{filename}: {msg}",
                               exc.status) from exc
    return out


# pdfium isn't thread-safe and the server is threaded
_pdfium = threading.Lock()


def render_page(cf, page: int, width: int) -> bytes:
    """Page `page` (1-based) of a context file as a JPEG `width` px wide."""
    from PIL import Image
    if cf.is_pdf:
        import pypdfium2 as pdfium
        with _pdfium:
            pdf = pdfium.PdfDocument(bytes(cf.data))
            try:
                pg = pdf[page - 1]
                scale = width / max(pg.get_width(), 1)
                img = pg.render(scale=scale).to_pil()
            finally:
                pdf.close()
    else:
        img = _open_image(bytes(cf.data))
        if img.width > width:
            img = img.resize((width, max(1, round(img.height * width / img.width))),
                             Image.LANCZOS)
    if img.mode not in ("RGB", "L"):
        bg = Image.new("RGB", img.size, "white")
        img = img.convert("RGBA")
        bg.paste(img, mask=img.split()[3])
        img = bg
    out = io.BytesIO()
    img.save(out, "JPEG", quality=85)
    return out.getvalue()


def thumbnail(cf, page: int = 1, width: int = 320) -> bytes:
    """A cached render of one page, at the nearest standard width at or above
    `width` (so the cache stays small)."""
    from .models import ContextThumbnail
    width = next((w for w in THUMB_WIDTHS if w >= width), THUMB_WIDTHS[-1])
    hit = ContextThumbnail.objects.filter(file=cf, page=page, width=width).first()
    if hit:
        return bytes(hit.data)
    data = render_page(cf, page, width)
    ContextThumbnail.objects.get_or_create(file=cf, page=page, width=width,
                                           defaults={"data": data})
    return data


def pdf_with_pages(data: bytes, pages: list[int]) -> bytes:
    """A PDF holding only `pages` (1-based) of `data`, in that order."""
    from pypdf import PdfReader, PdfWriter
    reader = PdfReader(io.BytesIO(data))
    w = PdfWriter()
    for p in pages:
        w.add_page(reader.pages[p - 1])
    buf = io.BytesIO()
    w.write(buf)
    return buf.getvalue()


def ai_image(data: bytes) -> tuple[str, bytes]:
    """(media type, bytes) of an image as sent to the AI: upright, long edge at
    most AI_IMAGE_EDGE. Drawings (PNG) stay PNG unless that's too big."""
    from PIL import Image
    img = _open_image(data)
    if max(img.size) > AI_IMAGE_EDGE:
        s = AI_IMAGE_EDGE / max(img.size)
        img = img.resize((max(1, round(img.width * s)), max(1, round(img.height * s))),
                         Image.LANCZOS)
    if sniff(data) == "image/png":
        out = io.BytesIO()
        img.save(out, "PNG", optimize=True)
        if out.tell() * 4 / 3 < MAX_IMAGE_BYTES / 2:
            return "image/png", out.getvalue()
    if img.mode != "RGB":
        img = img.convert("RGB")
    out = io.BytesIO()
    img.save(out, "JPEG", quality=88)
    return "image/jpeg", out.getvalue()


def page_ranges(pages: list[int]) -> str:
    """[1, 2, 3, 6] -> "1–3, 6"."""
    out, i = [], 0
    while i < len(pages):
        j = i
        while j + 1 < len(pages) and pages[j + 1] == pages[j] + 1:
            j += 1
        out.append(str(pages[i]) if i == j else f"{pages[i]}–{pages[j]}")
        i = j + 1
    return ", ".join(out)


def estimated_tokens(cf) -> int:
    """Estimated input tokens for the pages of `cf` currently included."""
    pt = cf.page_tokens or []
    return sum(pt[p - 1] for p in cf.included_pages() if p - 1 < len(pt))


@dataclass
class Prepared:
    blocks: list[dict]      # content blocks, files first, in order
    listing: list[str]      # one line per file for the text prompt


def ai_blocks(files) -> Prepared:
    """The content blocks for `files` (ContextFile rows), within the API's
    limits — or ContextFileError saying which limit and what to change.

    cache_control goes on the file blocks (the last four: the API allows four
    breakpoints), so a later turn with the same files reads them from the
    cache; turning off the last file still reuses the earlier ones."""
    blocks, listing = [], []
    pdf_pages = images = total = 0
    for cf in files:
        if cf.is_pdf:
            pages = cf.included_pages()
            if not pages:
                continue
            raw = bytes(cf.data)
            if len(pages) != cf.page_count:
                raw = pdf_with_pages(raw, pages)
            pdf_pages += len(pages)
            media, kind = "application/pdf", "document"
            if len(pages) == cf.page_count:
                where = f"all {cf.page_count} page{'s' if cf.page_count != 1 else ''}"
            else:
                where = (f"pages {page_ranges(pages)} of {cf.page_count} (the attached PDF holds "
                         f"only these; cite the original numbers: its page 1 is p.{pages[0]})")
        else:
            media, raw = ai_image(bytes(cf.data))
            images += 1
            kind, where = "image", "photo/image"
            if len(raw) * 4 / 3 > MAX_IMAGE_BYTES:
                raise ContextFileError(f"{cf.title} is too large for the AI even downscaled.")
        b64 = base64.standard_b64encode(raw).decode("ascii")
        total += len(b64)
        blocks.append({"type": kind, "source": {"type": "base64", "media_type": media, "data": b64}})
        note = f" — note: {cf.note}" if cf.note else ""
        name = cf.title if cf.title == cf.filename else f"{cf.title} ({cf.filename})"
        listing.append(f"{len(listing) + 1}. {name}: {where}{note}")
    if pdf_pages > MAX_PDF_PAGES:
        raise ContextFileError(
            f"The context files have {pdf_pages} PDF pages included; the AI takes at most "
            f"{MAX_PDF_PAGES} per message. Open a PDF in the Context pane and exclude the pages "
            "it doesn't need, or turn a file off.")
    if images > MAX_IMAGES:
        raise ContextFileError(f"{images} images are included; the AI takes at most "
                               f"{MAX_IMAGES} per message. Turn some off in the Context pane.")
    if total > MAX_REQUEST_BYTES - REQUEST_HEADROOM:
        raise ContextFileError(
            f"The included context files come to {total / 1e6:.1f} MB as sent; one message can "
            f"carry about {(MAX_REQUEST_BYTES - REQUEST_HEADROOM) / 1e6:.0f} MB. Exclude pages "
            "or turn a file off in the Context pane.")
    for b in blocks[-4:]:
        b["cache_control"] = {"type": "ephemeral"}
    return Prepared(blocks=blocks, listing=listing)
