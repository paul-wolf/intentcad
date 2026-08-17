# TODO / Backlog

Deferred work and known gaps. The full 3D-modeling roadmap (operation catalog,
feasibility, phased plan) lives in the feasibility artifact, not here.

## Sketch editor

### Endpoint snapping should create a coincident *constraint*, not just position
Snapping places a point but never binds it, so the solver drifts it away.

- `snap/snap.ts` snaps a line endpoint to nearby endpoints / rectangle corners
  within `SNAP_RADIUS` (12px) — but only positionally. No `coincident`
  constraint is added, so a later solve (e.g. an `equal` constraint) slides the
  un-pinned vertex off the target.
- Fix: when a line/polyline endpoint snaps onto another entity's real point,
  auto-add a `coincident` constraint so it's held.
- Related: rectangle corners are *derived* (center/width/height), not
  constrainable points — a line endpoint can't bind to one even with the above.
  Either expose rectangle corners as constrainable anchors, or steer profiles
  toward polylines.
- Repro: draw a rectangle; draw a polyline snapping its vertices to the corners;
  add an equal-length constraint → the snapped vertices drift off the corners.

### Make "close path" obvious / auto-close a ringed profile
A polyline drawn back to its start often isn't flagged `closed`. The 3D builder
now tolerates this (auto-closes multi-vertex profiles), but the editor should
either auto-close a clearly-ringed profile or make the `W` (close path) key
discoverable.

## AI layer / chat agent

### An op that references geometry a *sibling* op creates can't see it
When one chat instruction both creates geometry and then references it, the agent
plans every op before any of them runs — so a later op is choosing against
geometry that doesn't exist yet.

- Repro: "extrude sketch 2 at 20° to form a socket and trim any excess on the
  back of the plate" — the agent must pick the trim face before the socket
  exists, so it reasons from the plate + the wording alone. Prompt heuristics
  (tag→axis meaning, plate orientation) plus a no-op-trim warning make the common
  cases right and catch misses, but it's still a guess.
- Robust fixes (either/both):
  - **"Extrude up to face" bound on the extrude itself** (OnShape-style), so the
    excess is never created — no separate trim needed.
  - **Apply chat ops one at a time**, rebuilding between them, so a later op sees
    the geometry the earlier one produced (its real faces/edges, not a guess).

## 3D / modeling — deferred infra

- **Drop the orphaned `parts_part` table + its recorded migration.** The `parts`
  Django app was removed; a cleanup migration should drop the leftover table for
  prod. (Dev sqlite is harmless.)
- **Remove the dead Dexie `parts` store** in `frontend/src/api/db.ts` (needs a
  Dexie version bump; left declared to avoid a schema-migration risk).
- **Slim CadQuery's deploy footprint.** `cadquery` drags in vtk / trame /
  matplotlib / numba (~150MB) unused by a headless builder. Evaluate
  `build123d` or a minimal `cadquery-ocp`-only install before shipping, and
  update the Dockerfile for the new dependency.
