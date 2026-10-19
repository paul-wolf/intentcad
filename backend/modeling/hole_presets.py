"""Hole sizes for holes(): one table per hole kind, in mm, M2 to M5.

Edit the numbers here; holes() and the Hole dialog read them from this file
(the dialog gets them from /build/hole_presets). Each value says where it
comes from. Every diameter here is the nominal one: holes() adds
P["hole_comp"] (default 0) to all of them, for printers whose holes come out
small.
"""

SIZES = ["M2", "M2.5", "M3", "M4", "M5"]

# Clearance holes, ISO 273: "close" = fine series (H12), "normal" = medium
# series (H13). Taken from the Albany County Fasteners chart "Metric Series
# Clearance Holes (ISO 273)"
# (https://www.albanycountyfasteners.com/media/6b/b8/g0/1764944339/clearance-hole-chart.pdf),
# identical to Optimas' table (https://optimas.com/technical-resources/tapping-sizes/).
CLEARANCE = {
    #        close  normal
    "M2":   {"close": 2.2, "normal": 2.4},
    "M2.5": {"close": 2.7, "normal": 2.9},
    "M3":   {"close": 3.2, "normal": 3.4},
    "M4":   {"close": 4.3, "normal": 4.5},
    "M5":   {"close": 5.3, "normal": 5.5},
}

# Tapped / self-tapping holes: the tap drill, nominal minus the coarse pitch
# (ISO 2306 rule d - P; pitches 0.4, 0.45, 0.5, 0.7, 0.8 from Optimas, above).
# Tap it, or drive a machine screw straight into the plastic; there is no
# standard for the latter, so tune with hole_comp. Depth defaults to 3 x the
# nominal size (thread engagement).
TAPPED = {
    "M2":   {"d": 1.6,  "depth": 6.0},
    "M2.5": {"d": 2.05, "depth": 7.5},
    "M3":   {"d": 2.5,  "depth": 9.0},
    "M4":   {"d": 3.3,  "depth": 12.0},
    "M5":   {"d": 4.2,  "depth": 15.0},
}

# Heat-set inserts: CNC Kitchen's standard metric inserts, from CNC Kitchen's
# own "Dimensions & Design Guidelines" poster (2025-07), linked from
# https://cnckitchen.store/pages/insert-cad-models:
# https://cdn.shopify.com/s/files/1/0654/4821/4767/files/Poster_Dimensions-Guidlines.pdf
#   d     = the hole diameter (poster "D2")
#   depth = the poster's minimum blind-hole depth, "min. L+1mm"
#   wall  = the poster's minimum wall thickness "W" around the hole
#   insert_d / insert_l = the insert's outer diameter "D1" and length "L"
# (3DJake's listing of the same set says 5.6 / 6.4 for the M4 / M5 hole; the
# poster, which is newer and CNC Kitchen's own, says 5.7 / 6.5.)
INSERT = {
    "M2":   {"d": 3.2, "depth": 4.0,  "wall": 1.3, "insert_d": 3.6, "insert_l": 3.0},
    "M2.5": {"d": 4.0, "depth": 5.0,  "wall": 1.6, "insert_d": 4.6, "insert_l": 4.0},
    "M3":   {"d": 4.0, "depth": 6.7,  "wall": 1.6, "insert_d": 4.6, "insert_l": 5.7},
    "M4":   {"d": 5.7, "depth": 9.1,  "wall": 2.1, "insert_d": 6.3, "insert_l": 8.1},
    "M5":   {"d": 6.5, "depth": 10.5, "wall": 2.6, "insert_d": 7.1, "insert_l": 9.5},
}

# Counterbores for socket head cap screws (ISO 4762), normal clearance hole
# through the middle. M3-M5: Misumi's "Dimensions of Counterboring and Bolt
# Hole for the Hexagon Socket Head Cap Screws" (after JIS B 1176), D' and H''
# (https://id.misumi-ec.com/pdf/tech/mech/p2847.pdf).
# M2 and M2.5 are not in that table (no free source found): they follow its
# rule, head diameter + 1 and head height + 0.3, from ISO 4762's dk max / k max
# (3.8 / 2.0 and 4.5 / 2.5, https://fasten.it/norms/norm/din_en_iso_4762).
COUNTERBORE = {
    "M2":   {"d": 2.4, "cbore_d": 4.8, "cbore_depth": 2.3},
    "M2.5": {"d": 2.9, "cbore_d": 5.5, "cbore_depth": 2.8},
    "M3":   {"d": 3.4, "cbore_d": 6.5, "cbore_depth": 3.3},
    "M4":   {"d": 4.5, "cbore_d": 8.0, "cbore_depth": 4.4},
    "M5":   {"d": 5.5, "cbore_d": 9.5, "cbore_depth": 5.4},
}

# Countersinks for countersunk socket screws, ISO 10642:2020 (90°), normal
# clearance hole through the middle. csk_d = the head's theoretical maximum
# diameter dk, so the head sits flush
# (https://fasten.it/norms/norm/din_en_iso_10642; the 2020 edition adds M2 and
# M2.5 — DIN 7991, which it replaced, starts at M3).
COUNTERSINK = {
    "M2":   {"d": 2.4, "csk_d": 4.7,  "angle": 90},
    "M2.5": {"d": 2.9, "csk_d": 5.88, "angle": 90},
    "M3":   {"d": 3.4, "csk_d": 6.72, "angle": 90},
    "M4":   {"d": 4.5, "csk_d": 8.96, "angle": 90},
    "M5":   {"d": 5.5, "csk_d": 11.2, "angle": 90},
}

KINDS = ["clearance", "tapped", "insert", "counterbore", "countersink"]

# a standoff's base fillet and, for kinds without a wall in the table, the
# wall around its hole (the default outer diameter is the hole + 2 walls,
# rounded up to 0.5)
STANDOFF_FILLET = 1.0
STANDOFF_WALL = 2.0
STANDOFF_HEIGHT = 6.0


def preset(kind: str, size: str, fit: str = "normal") -> dict:
    """The table values for a hole: {"d", "depth" (None = through), and the
    kind's own: cbore_d, cbore_depth, csk_d, angle, wall...}."""
    if size not in SIZES:
        raise ValueError(f"unknown hole size {size!r} (one of {', '.join(SIZES)})")
    if kind == "clearance":
        if fit not in ("close", "normal"):
            raise ValueError(f"unknown clearance fit {fit!r} (close or normal)")
        out = {"d": CLEARANCE[size][fit], "depth": None}
    elif kind == "tapped":
        out = dict(TAPPED[size])
    elif kind == "insert":
        out = dict(INSERT[size])
    elif kind == "counterbore":
        out = {**COUNTERBORE[size], "depth": None}
    elif kind == "countersink":
        out = {**COUNTERSINK[size], "depth": None}
    else:
        raise ValueError(f"unknown hole kind {kind!r} (one of {', '.join(KINDS)})")
    wall = out.get("wall", STANDOFF_WALL)
    out["standoff_d"] = _up(max(out["d"], out.get("cbore_d", 0), out.get("csk_d", 0)) + 2 * wall)
    return out


def _up(x: float, step: float = 0.5) -> float:
    import math
    return math.ceil(x / step - 1e-9) * step


def table() -> dict:
    """Every preset, for the Hole dialog: {kind: {size: values}}."""
    out = {k: {s: preset(k, s) for s in SIZES} for k in KINDS}
    out["clearance_close"] = {s: preset("clearance", s, "close") for s in SIZES}
    return {"sizes": SIZES, "kinds": KINDS, "presets": out,
            "standoff": {"fillet": STANDOFF_FILLET, "height": STANDOFF_HEIGHT}}
