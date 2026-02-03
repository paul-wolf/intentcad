# IntentCAD v0.1 — Parametric Sketcher (Iteration 1)

A CAD sketching tool with basic capabilities to draw 2D sketches exportable as DXF. Easy to use, follows best sketch tool conventions.

TODO:

* Selection mode, intersect or surround
* Command click de/select individual entities
A
* Name sketches
* AI chat
* AI file ingest
* Hover vertices

* Selection priority
* Dragging circle center point
* Dragging rect center point
*
* Constraints, equals, midpoint, tangent
* Cut line segment
* Named parameters
* Parameter sidebar
* Point entity

* two corner rectangle
* Fillet


**Full feature vision** (across all iterations):

* Geometry: Point, Line, Circle, Rectangle, Spline, Polygon
* Sketch constraints: coincident, equal, midpoint, tangent, H/V, parallel/perp
* Mirror & circular pattern
* Fillet
* Named parameters
* Legible dimensions
* DXF export (LINE/ARC/LWPOLYLINE)

**AI-driven design** is an essential part of the concept:

* Generate from description ("Plate 120x80 with 30.5 bolt circle..." -> full sketch)
* Constraint suggestions (symmetry, equals, midpoints)
* Repair assistant (rebind after edits)
* Annotation intelligence (choose dimensions to display)
* Design reasoning (explain intent, best practices)
* All outputs validated by the solver

---

**Goal (Iteration 1):** a minimal 2D sketch app for CNC-style plate/profile drafting that supports:

* Simple **document management** (create/list/rename/delete)
* A **2D drawing space** with **grid** + **snap-to-grid** (mm), fixed viewport (no pan/zoom)
* A **selection model** (click select, drag-rectangle select, ESC clear, click-empty clear)
* **Selected elements render differently**
* **Delete selected entities** with the Delete key
* **Save/reopen** documents and continue editing
* **Draw straight line segments only** (no arcs, no constraints, no DXF yet)
* **Multiple sketches** per document with active sketch concept

It is critical to validate that we produce a comfortable, ergonomic, usable sketch experience. Drawing and selecting must be user-friendly and aesthetically pleasing.

### Tech stack

* Frontend: **React + Vite + TypeScript**
* Rendering: **Canvas 2D** with architecture ready for **WebGL** later
* Backend: **Django + django-ninja**
* DB: **PostgreSQL**
* Testing: Django unit tests

---

## 1) Non-goals (Iteration 1)

* Constraints / solver / WASM
* AI features
* DXF export
* Circles / arcs
* Undo / redo
* Pan / zoom
* Multi-user collaboration / auth
* Assemblies or 3D
* Sketch locked / order / role fields (deferred)

---

## 2) ID Format

All objects use **type-prefixed IDs**: `<2-char prefix>_<10-char base62 random>`.

10 alphanumeric characters (base-62) gives ~59 bits of entropy — collision is effectively impossible within a document.

| Prefix | Type           | Example            |
|--------|----------------|--------------------|
| `ln`   | line           | `ln_a8Kf3m92Xq`   |
| `cr`   | circle (later) | `cr_pL2nR8v4Yw`   |
| `ar`   | arc (later)    | `ar_bN5tQ7wJ1e`   |
| `pt`   | point (later)  | `pt_cR9yH4xK2d`   |
| `pl`   | polyline       | `pl_fW3mD6vS8a`   |
| `sk`   | sketch         | `sk_dM7xQ1bT3e`   |
| `pm`   | parameter      | `pm_wN4jF6cH9s`   |
| `ct`   | constraint     | `ct_rV5gB2kL8m`   |
| `ft`   | feature        | `ft_hY1pE8nA4f`   |
| `an`   | annotation     | `an_kT6qG3jC7w`   |
| `dm`   | dimension      | `dm_uX2sL9rF5b`   |

**Iteration 1 generates only `ln_*` and `sk_*` IDs.**

Why this format:
* Type prefix lets AI reason about entity kind without a lookup
* Short enough for efficient token use in prompts
* Human-scannable during debugging
* Large symbol space avoids collision

---

## 3) Document Format

### 3.1 Core philosophy

**Belongs in the document file:**
* Geometry entities
* Constraints (later)
* Parameters
* Features (mirror/pattern/fillet)
* Annotation intent
* Units & grid

**Does NOT belong in the document file:**
* Viewport zoom/pan
* Current selection
* Active sketch (UI state, managed by the editor)
* Tool state
* Temporary previews

The file represents **design intent**, not session state.

### 3.2 Document JSON (v0.2 — multi-sketch)

All documents are stored as a single **versioned JSON** blob. Backend stores it as `JSONB`.

```json
{
  "format_version": "0.2",
  "settings": {
    "units": "mm",
    "grid": {
      "visible": true,
      "spacing_mm": 1,
      "snap_mm": 1
    }
  },
  "parameters": [],
  "sketches": [
    {
      "id": "sk_dM7xQ1bT3e",
      "name": "Outline",
      "visible": true,
      "entities": [
        {
          "id": "ln_a8Kf3m92Xq",
          "type": "line",
          "a": { "x": 0, "y": 0 },
          "b": { "x": 120, "y": 0 }
        }
      ],
      "constraints": [],
      "annotations": []
    },
    {
      "id": "sk_pL2nR8v4Yw",
      "name": "Holes",
      "visible": true,
      "entities": [],
      "constraints": [],
      "annotations": []
    }
  ]
}
```

Notes:
* `active_sketch_id` is **not** stored in the document — it is editor UI state
* `constraints` and `annotations` arrays are reserved but empty in iteration 1
* `parameters` array is reserved but empty in iteration 1
* Inactive sketch opacity is computed by the renderer (active = 1.0, inactive = 0.35), not stored in the file

### 3.3 Coordinates

* **World space** is in **millimeters**
* Entities store coordinates in world space

### 3.4 Versioning & migration

```json
"format_version": "0.2"
```

Migration roadmap:
* v0.2 — multi-sketch, lines only (current)
* v0.3 — add circles/arcs
* v0.4 — constraints
* v0.5 — features

Backend migrates on load.

---

## 4) Sketches

### 4.1 Relationship model

* A **Document** contains multiple **Sketches**
* Each Sketch owns its own entities (lines only in v1), and later constraints/annotations
* All sketches share the same 2D world coordinate system (mm)
* Exactly one sketch is **active** at a time (managed as editor UI state)

### 4.2 Active sketch

* New geometry is created into the active sketch
* Only entities in the active sketch are selectable/editable
* ESC clears selection in the active sketch
* Delete key removes selected entities from the active sketch

### 4.3 Non-active sketches

* Can be visible/hidden (toggle in a sketch list panel)
* Are **not** selectable or editable
* Hidden sketches do not render and do not participate in snap

### 4.4 Rendering order

1. Render all visible non-active sketches (faint/ghosted, opacity ~0.35)
2. Render active sketch last (full opacity)

This makes it obvious which sketch is being edited.

### 4.5 Snapping across sketches

Snap to **grid + visible sketches** (but still not selectable). This feels immediately CAD-like without adding selection complexity.

---

## 5) Backend (Django + django-ninja + Postgres)

### 5.1 Model

**Document**

* `id` (UUID, PK)
* `name` (text)
* `data` (JSONB) — stores the v0.2 document JSON
* `created_at`, `updated_at`

### 5.2 API endpoints

Base path: `/api/v1`

| Method   | Path               | Description                         |
|----------|--------------------|------------------------------------|
| `GET`    | `/documents/`      | List documents                     |
| `POST`   | `/documents/`      | Create document                    |
| `GET`    | `/documents/:id/`  | Fetch document                     |
| `PUT`    | `/documents/:id/`  | Replace document (including `data`)|
| `PATCH`  | `/documents/:id/`  | Partial update (e.g., rename)      |
| `DELETE` | `/documents/:id/`  | Delete document                    |

#### Request/response shapes

**Create**
```json
POST /api/v1/documents/
{
  "name": "Motor Mount Plate",
  "data": { "...v0.2 doc json..." }
}
```

**List**
```json
GET /api/v1/documents/
[
  { "id": "...", "name": "...", "updated_at": "...", "created_at": "..." }
]
```

**Get**
```json
GET /api/v1/documents/:id/
{
  "id": "...",
  "name": "...",
  "data": { "...v0.2 doc json..." },
  "created_at": "...",
  "updated_at": "..."
}
```

### 5.3 Validation

Backend must validate on create/update:

* `format_version === "0.2"`
* `sketches` is an array; each sketch has `id`, `name`, `visible`, `entities`
* Entities only include supported types (`line` in v1)
* Entity IDs match pattern `ln_[A-Za-z0-9]{10}`
* Sketch IDs match pattern `sk_[A-Za-z0-9]{10}`
* Coordinates (`a.x`, `a.y`, `b.x`, `b.y`) are numbers
* Grid values (`spacing_mm`, `snap_mm`) are positive numbers

Return `400` with clear errors on validation failure.

---

## 6) Frontend Architecture

### 6.1 Pages

* **DocumentListPage** — list, create, rename, delete documents
* **EditorPage** — canvas editor + toolbar + sketch list panel

### 6.2 State ownership

**Document JSON** is the source of truth for entities, sketches, and grid.

**Editor UI state** is separate:
* `activeSketchId: string`
* `activeTool: "select" | "line"`
* `selectedEntityIds: Set<string>`
* Tool-in-progress state (e.g., line start point)

### 6.3 Rendering

Iteration 1 uses **Canvas 2D**. Keep an abstraction that can later swap to WebGL:

```
render(grid, sketches, activeSketchId, selection, toolOverlay)
```

Render pipeline order:
1. Clear background
2. Draw grid
3. Draw non-active visible sketches (ghosted)
4. Draw active sketch entities (unselected, normal style)
5. Draw active sketch entities (selected, highlight style)
6. Draw tool overlays (selection rect, preview line)

### 6.4 Hit testing

Hit test uses **screen-space tolerance** (px), not world-space, to feel consistent regardless of zoom level (when zoom is added later).

* `HIT_TOL_PX = 8` (suggested)
* For line hit testing:
  * Transform segment endpoints to screen coordinates
  * Compute point-to-segment distance in px
  * If <= tolerance -> hit
* Hit testing only operates on the **active sketch**
* Detect whether click is near an endpoint (store in UI state) for future endpoint dragging

---

## 7) Interaction Spec (Iteration 1)

### 7.1 Select tool

* **Click on line** -> select it (single selection)
* **Click empty canvas** -> clear selection
* **ESC** -> clear selection
* **Drag rectangle on empty space** -> box select
  * On mouse-up: select all lines in the active sketch that **intersect** the rectangle
* **Delete / Backspace** with selection -> remove selected entities from active sketch

Selection rendering: selected lines draw with heavier stroke and/or different color.

### 7.2 Line tool

* **Click #1** -> start point (snapped)
* **Mouse move** -> show preview line to snapped cursor position
* **Click #2** -> end point (snapped) -> commit a new line entity to active sketch
* **ESC while drawing** -> cancel current line in progress

### 7.3 Grid + snap

* Grid uses `grid.spacing_mm` for visible grid lines
* Snapping uses `grid.snap_mm`:
  * `snap(x) = round(x / snap_mm) * snap_mm`
* Snap applies to line start/end clicks
* Snap candidates include grid intersections + endpoints of entities in visible sketches

### 7.4 Viewport

Iteration 1 uses a **fixed viewport** (no pan/zoom). World coordinates map 1:1 to screen pixels at a fixed scale (e.g., 1mm = some fixed number of pixels). Pan/zoom will be added in a later iteration.

---

## 8) Persistence

* **Save on every change** with debounce (500-1000ms)
* Save sends `PUT /api/v1/documents/:id/` with the full document JSON
* Reopen a document and continue editing with correct rendering and selection behavior

---

## 9) Running Locally

### 9.1 Prerequisites

* Node.js (LTS)
* Python 3.12+
* PostgreSQL 14+
* (Optional) Docker + docker-compose

### 9.2 Backend

1. Create `.env` in `backend/` with DB settings
2. `pip install -r requirements.txt`
3. `python manage.py migrate`
4. `python manage.py runserver`

### 9.3 Frontend

1. `cd frontend`
2. `npm install`
3. `npm run dev`

Frontend expects backend at `http://localhost:8000/api/v1`.
Use Vite proxy in `vite.config.ts` to avoid CORS in dev.

---

## 10) Milestones (Iteration 1)

### M1 — Canvas + grid
* [ ] Render empty canvas with grid
* [ ] Show mouse position in mm (optional)

### M2 — Line tool
* [ ] Click-start / click-end line creation into active sketch
* [ ] Preview line while moving
* [ ] Snap-to-grid

### M3 — Selection model
* [ ] Click select line (active sketch only)
* [ ] Clear selection on ESC / click empty
* [ ] Selected rendering (highlight style)
* [ ] Delete selected entities with Delete key

### M4 — Box select
* [ ] Marquee rectangle
* [ ] Select intersecting lines on mouse-up (active sketch only)

### M5 — Multi-sketch support
* [ ] Sketch list panel (create, rename, toggle visibility, set active)
* [ ] Render non-active visible sketches as ghosted underlay
* [ ] Drawing/selection restricted to active sketch

### M6 — Document CRUD + persistence
* [ ] List / create / rename / delete documents
* [ ] Save document data (debounced)
* [ ] Open existing document and continue editing

---

## 11) Forward Compatibility (Design Notes)

These guide iteration 1 decisions to support future iterations:

* Every entity has a stable typed ID (required for constraints + AI references)
* Document JSON is versioned (`format_version`) with migration path
* Clear split between document model and editor UI state
* Selection references entity IDs (not array indexes)
* Hit-testing and snapping are independent modules (reusable later)
* Constraints remain strictly **per-sketch** (clean solver boundary)
* AI can reference elements unambiguously by ID or by sketch name + entity name
* "Snap-on-release constraint solve" later only needs to solve the active sketch

---

## 12) Future Schema Elements (Reserved, Not Implemented)

### Parameters
```json
"parameters": [
  {
    "id": "pm_wN4jF6cH9s",
    "name": "plate_width",
    "value": 120,
    "units": "mm",
    "description": "Overall width"
  }
]
```

### Constraints (per-sketch)
```json
"constraints": [
  { "id": "ct_rV5gB2kL8m", "type": "equal", "refs": ["ln_a8Kf3m92Xq", "ln_pL2nR8v4Yw"] },
  { "id": "ct_hY1pE8nA4f", "type": "coincident", "refs": ["ln_a8Kf3m92Xq:a", "ln_bN5tQ7wJ1e:b"] }
]
```

Reference notation: `<entity_id>` for whole entity, `<entity_id>:a` / `<entity_id>:b` for endpoints.

### Features
```json
"features": [
  { "id": "ft_hY1pE8nA4f", "type": "mirror", "source_entities": ["ln_a8Kf3m92Xq"], "axis": "ln_pL2nR8v4Yw" }
]
```

### Annotations
```json
"annotations": [
  { "id": "an_kT6qG3jC7w", "type": "dimension_linear", "refs": ["ln_a8Kf3m92Xq", "ln_pL2nR8v4Yw"], "parameter": "pm_wN4jF6cH9s", "placement": "auto" }
]
```

### Future entity types
```
"type": "circle"    // center + r
"type": "arc"       // center + r + angles
"type": "point"     // construction points
"type": "polyline"  // for DXF import
```

### DXF mapping (later)
* line -> DXF LINE
* circle -> DXF CIRCLE
* arc -> DXF ARC

---

## 13) Definition of Done (Iteration 1)

A user can:

1. Create a document with multiple sketches
2. Switch the active sketch; toggle sketch visibility
3. Draw several straight lines snapped to grid into the active sketch
4. Select lines by click or box selection and see selection styling
5. Delete selected entities with the Delete key
6. Clear selection with ESC or click empty space
7. Save and reload the document and continue editing

---

## 14) License & Openness

Project intends to be open source.

* Document format and schema must be published and stable
* DXF export (later) must be deterministic for a given document JSON
