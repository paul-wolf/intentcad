"""A script's version: a short fingerprint of a part's saved script
(data.modelCode) or a generated sketch's (data.code). An AI edit carries the
version it started from, and its save is refused if the saved script isn't
that version any more (it was changed in another tab or browser meanwhile)."""
import hashlib


def code_version(code) -> str:
    """The version of a script (any text; None and "" are the same)."""
    return hashlib.sha256((code if isinstance(code, str) else "").encode()).hexdigest()[:16]


def saved_code_version(doc, key: str = "modelCode") -> str:
    """The version of `doc`'s saved script (data[key])."""
    data = doc.data if isinstance(doc.data, dict) else {}
    return code_version(data.get(key))
