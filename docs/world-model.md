# The World Model — what the AI agent reads and checks

The AI is not a natural-language → JSON translator. It is an **agent that reasons
and acts in an environment**. This doc specifies that environment: the *facts* it
perceives and the *checks* it can run. Everything here is grounded in the
leg-brace example (a split-clamp block + mounting plate + angled lower tube,
joined by fillet/press-pull blends).

Two design rules hold throughout:

1. **The feature tree is the only source of truth.** Everything else — geometry,
   inventory, dependency graph — is a *pure, cached function of the tree*. A
   rebuild recomputes it. Nothing mutable to corrupt.
2. **Every operation names its target.** Locality is not a mode; it is that each
   op acts on a stated scope (`body:…`, `face:…`, `edge:…`) and produces named
   results. Global ops are the dead end.

The agent's job each turn: read the world model → reason about the goal → propose
a candidate tree edit → **rebuild and measure** → observe → revise or compare →
present with rationale and flagged risks.

---

## 1. The feature tree (the program)

An ordered list of operations. Each op carries params **and** four things that
make agent reasoning possible: a `target` (scope), `produces` (named results),
`intent` (why it exists), and `requires` (invariants it must preserve).

```jsonc
{
  "part": "leg-brace",
  "params": { "leg_angle": 22, "leg_spin": 0, "bore_dia": 30, "min_wall": 3 },
  "features": [
    { "id": "block", "op": "extrude", "profile": "sketch:block",
      "plane": "plane:front", "distance": 60,
      "produces": ["body:block"],
      "intent": { "role": "clamp", "function": "holds the horizontal tube" } },

    { "id": "bore", "op": "cut", "target": "body:block",
      "profile": "sketch:bore_circle", "through": true,
      "produces": ["face:bore_wall"],
      "intent": { "role": "bore" },
      "requires": ["bore_dia >= 30", "concentric_with(interface:tube_axis)"] },

    { "id": "slot", "op": "cut", "target": "body:block",
      "profile": "sketch:slot", "through": true,
      "intent": { "role": "clamp_gap" } },

    { "id": "bolts", "op": "cut", "target": "body:block",
      "pattern": { "kind": "linear", "count": 2, "spacing": 26 },
      "profile": "sketch:bolt_hole",
      "intent": { "role": "fastener", "function": "pinch bolts" } },

    { "id": "plate", "op": "extrude", "profile": "sketch:plate",
      "plane": "plane:mid", "distance": 8,
      "produces": ["body:plate", "face:plate_bottom"],
      "intent": { "role": "mounting_plate" },
      "requires": ["bolt_pattern == interface:flange"] },

    { "id": "leg_plane", "op": "plane",
      "anchor": "face:plate_bottom",
      "tilt": { "about": "axis:Y", "angle": "$leg_angle" },
      "spin": "$leg_spin",
      "produces": ["plane:leg"],
      "intent": { "role": "datum", "function": "orients the lower tube" } },

    { "id": "leg", "op": "extrude", "on": "plane:leg",
      "profile": "sketch:leg_circle", "distance": 120,
      "produces": ["body:leg"],
      "intent": { "role": "leg_tube", "function": "receives a mating tube" } },

    { "id": "leg_bore", "op": "shell", "target": "body:leg",
      "open_faces": ["face:leg_end"], "thickness": "$min_wall",
      "requires": ["wall >= min_wall"] },

    { "id": "leg_hole", "op": "cut", "target": "body:leg",
      "profile": "sketch:cross_hole", "through": true,
      "intent": { "role": "fastener", "function": "cross-pin the mating tube" } },

    { "id": "blend_leg", "op": "fillet",
      "edges": "edge: body:leg ∩ body:plate",     // semantic selector, not #7
      "radius": 14,
      "intent": { "role": "gusset", "function": "structural blend" } },

    { "id": "blend_block", "op": "fillet",
      "edges": "edge: body:block ∩ body:plate", "radius": 8 }
  ]
}
```

**The op schema, in words:**

| field | meaning | why the agent needs it |
| --- | --- | --- |
| `target` / `on` | the scope it acts in | makes the op local; bounds the blast radius |
| `produces` | named geometry it creates | gives later ops (and the agent) something to reference |
| `intent` | role / function | lets the agent judge *optimal for what* and *what not to break* |
| `requires` | invariants to preserve | the guardrails the agent checks after any edit |
| `params` (top level) | named, shared values | drives features; a mutation is often one param edit |

Note `leg_spin: "$leg_spin"` — the 45° mutation is `params.leg_spin: 0 → 45`.
Nothing else in the tree changes.

---

## 2. The geometry inventory (the agent's eyes)

`build(tree)` returns the mesh + STEP **and** an inventory: every body, face, and
edge with a **stable id** and descriptors. This is the selection subsystem's
output — it's what selectors resolve against and what the agent "sees."

```jsonc
{
  "bodies": [
    { "id": "body:block", "made_by": "block", "volume": 41200, "bbox": [...] },
    { "id": "body:plate", "made_by": "plate", "volume": 9800,  "bbox": [...] },
    { "id": "body:leg",   "made_by": "leg",   "volume": 22600, "bbox": [...] }
  ],
  "faces": [
    { "id": "face:block/top", "body": "body:block", "made_by": "block",
      "kind": "planar", "normal": [0,0,1], "area": 1560, "centroid": [...],
      "tags": ["top"] },
    { "id": "face:bore_wall", "body": "body:block", "made_by": "bore",
      "kind": "cylindrical", "radius": 15, "axis": [1,0,0], "tags": ["bore"] },
    { "id": "face:plate_bottom", "body": "body:plate", "made_by": "plate",
      "kind": "planar", "normal": [0,0,-1], "tags": ["mounting"] }
  ],
  "edges": [
    { "id": "edge:leg∩plate", "between": ["body:leg","body:plate"],
      "made_by": ["leg","plate"], "length": 96, "kind": "spline",
      "consumed_by": ["blend_leg"] }
  ]
}
```

**Stable ids / the topological-naming approach.** A derived face or edge is named
by its **provenance + a discriminator**, not by kernel index:

- provenance = the feature(s) that produced it (`made_by`) or the bodies whose
  intersection it is (`between`);
- discriminator = a descriptor that survives small edits (orientation, a `top` /
  `bore` tag, relative position).

On each rebuild the resolver re-derives ids by **matching descriptors**, so
`edge:leg∩plate` still resolves after the leg rotates — the edge moved, but it's
still "the intersection of leg and plate." That is the fix for the Fusion
corruption problem, stated as data. When a descriptor no longer matches anything,
that is a *detected* breakage (see validators), not silent corruption.

---

## 3. The dependency graph (blast radius)

Derived by resolving every op's `target`/`on`/`edges` against `produces`. Node =
feature; edge = "consumes what that feature produced."

```
block → bore → slot → bolts
plate ← (plane:mid)
leg_plane  ⇐ plate            (anchored to face:plate_bottom)
leg        ⇐ leg_plane
leg_bore   ⇐ leg
leg_hole   ⇐ leg
blend_leg  ⇐ leg, plate       (edge:leg∩plate)
blend_block ⇐ block, plate
```

**Blast radius of editing `leg_plane` (the 45° spin):**

```
downstream(leg_plane) = { leg, leg_bore, leg_hole, blend_leg }
untouched             = { block, bore, slot, bolts, plate, blend_block }
```

This is computed *before* rebuilding. It is also a primary input to the agent:
"what am I about to disturb?" is a graph query, not a guess.

---

## 4. Intent & constraints (the "why")

Geometry alone can't answer "will this break something that matters" or "is this
optimal." Intent and constraints carry the meaning.

- **Intent** lives on features/geometry (`role`, `function`, mating info). It lets
  the agent reason: `leg_hole` is a *fastener* that must remain *reachable*;
  `bore` must stay *concentric with the tube interface*.
- **Constraints** are invariants — global or per-feature — that must survive any
  edit. Machine-checkable wherever possible:

```jsonc
"constraints": [
  { "id": "wall",   "check": "min_wall_thickness(body:leg) >= params.min_wall" },
  { "id": "bore",   "check": "cylinder(face:bore_wall).dia >= params.bore_dia" },
  { "id": "bolts",  "check": "pattern(bolts) == interface:flange" },
  { "id": "clear",  "check": "no_interference(body:leg, body:block)" },
  { "id": "reach",  "check": "face:leg_end.normal points away from body:plate" }
]
```

Some constraints are external (`interface:flange`, `interface:tube_axis`) — the
part's contract with its neighbours. These are exactly the things the agent must
*not* optimize away, and the reason "optimal" needs an explicit objective: without
knowing you care about print time vs. stiffness, "better" is undefined. When the
objective is absent, the right agent behaviour is to **ask**.

---

## 5. Validators (the agent's senses after a rebuild)

After a candidate rebuild, run validators. Each returns pass/fail + a measurement
+ which constraint/feature it implicates. This is what closes the loop — the
agent *observes consequences* instead of predicting them.

Ranked by value-per-effort to build first:

1. **Rebuild status** — did every feature resolve? which failed and why? *(You
   already return `warnings`; extend to per-feature `status` + `error`.)* Near-free.
2. **Selector resolution** — did every selector still find a target? An empty
   selector (`edge:leg∩plate` matches nothing) is the silent-breakage case; make
   it *loud*. Cheap, high value — this is what catches "the blend fell off."
3. **Wall thickness / min feature size** — printability; catches shells and
   offsets going too thin. Moderate (ray/section sampling on the mesh).
4. **Interference / self-intersection** — bodies clash, or a rotated feature
   overlaps something it shouldn't. Moderate (boolean-intersection volume > 0).
5. **Constraint checks** — evaluate the `constraints` list (bore dia, bolt
   pattern, mass/bbox limits, reachability). Grows with the domain.

Output shape:

```jsonc
{ "rebuild": "ok",
  "features": [ { "id": "blend_leg", "status": "ok", "resolved_edges": 1 } ],
  "validators": [
    { "id": "wall",  "pass": true,  "measured": 3.4, "limit": 3 },
    { "id": "clear", "pass": true },
    { "id": "reach", "pass": false, "note": "leg_end now faces the mount plate" }
  ] }
```

---

## 6. One agent turn, worked: "rotate the lower tube 45°"

```
PERCEIVE   tree + inventory + dep-graph + intent/constraints + last report
REASON     goal = reposition leg_tube, keep clamp identical.
           dep-graph: editing leg_plane touches {leg, leg_bore, leg_hole, blend_leg};
           block/bore/bolts untouched by construction. Candidate: params.leg_spin 0→45.
           Risk hypotheses: blend edge moves (re-resolve?), leg may clash clamp,
           cross-hole orientation may become unreachable.
PROPOSE    edit: params.leg_spin = 45
ACT        rebuild(tree')  →  mesh + inventory' + validator report
OBSERVE    rebuild ok; blend_leg resolved 1 edge (survived); clear = pass;
           reach = FAIL (leg_end now faces the plate).
REVISE     two options: (a) spin 45 the other way — reach passes, clash passes;
           (b) keep 45, add note to relocate cross-hole. Prefer (a).
PRESENT    "Rotated the leg 45° (clockwise, so the open end still clears the
            mount). Clamp, bore, and bolts unchanged. The gusset blend recomputed
            on the new junction. Heads-up: at 45° the other direction the tube's
            open end would face the plate — say the word if that's what you meant."
```

The intelligence isn't in guessing the outcome — it's in **trying candidates and
reading the validators**, then choosing and explaining. Because `build(tree)` is
pure and fast, generating and scoring a few candidates is cheap.

---

## 7. What to build first (v0 of the world model)

The catalog of operations is commodity. The moat is this environment. A minimal
first cut that makes the agent possible:

1. **Inventory v0** — have `build()` emit stable ids + `made_by` provenance for
   bodies/faces/edges alongside the mesh. (Extends the builder we have.)
2. **Selector resolver** — resolve `body:…`, `face:tag`, `edge: A ∩ B` against the
   inventory. This is targeting *and* the agent's reference mechanism, one thing.
3. **Two validators** — rebuild-status and selector-resolution. Together they
   answer "did the edit break anything referenced?" — the core of "where it breaks."
4. **Dependency graph** — derive from resolved targets; expose blast-radius.

With just these, operations become local, edits become checkable, and the agent
has facts to read and checks to run. Intent/constraints and richer validators
(wall, interference) layer on after. See [../TODO.md](../TODO.md) for the backlog.

---

# Part II — The engineering reasoning layer

Geometry is the skeleton; this is what makes the agent an *engineer* rather than a
draughtsman. The bar is deliberately low and reachable: **qualitative, linear
stress reasoning — no magnitudes.** The agent needs to understand load *paths* and
*relative* consequences well enough to act on "make that gusset a bit stronger" —
not to compute stress in MPa. Real FEA (numbers) is an optional future
*confirmation*, explicitly out of near-term scope. The value is in the direction,
and the direction is enough to design with.

## 8. The environment (the part's neighbours)

A part is never alone. The leg-brace clamps a tube, and its rear flange presses on
a mounting surface. These are **not assemblies** — no mates, no motion. They are
*simplified reference bodies* that each supply three kinds of fact:

- **fit** — the bore must match the clamped tube;
- **load** — where forces enter and where they react;
- **clearance** — what the part must not collide with.

```jsonc
"environment": [
  { "id": "env:clamped_tube", "shape": "cylinder", "dia": 30, "axis": "bore",
    "role": "clamped", "provides": ["fit(face:bore_wall)", "reaction", "load_source"] },
  { "id": "env:mount_surface", "shape": "plane", "at": "face:flange_back",
    "role": "ground", "provides": ["support", "reaction"] },
  { "id": "env:mating_tube", "shape": "cylinder", "dia": 20, "axis": "leg",
    "role": "received", "provides": ["fit(face:leg_bore)", "load_source"] }
]
```

This is the light-weight "poor man's assembly": enough context to constrain fit
and anchor loads, none of the cost of real assembly modelling — and it is what
lets the agent reason that *rotating the leg changes the angle at which it presses
on `env:clamped_tube`.* Without that fact, the whole stress question is unanswerable.

## 9. Loads & materials — kept qualitative

- **Materials**: a *class* per body (`"PLA"`, `"aluminium"`) — enough to order
  bodies by relative stiffness/strength. Exact `E`/yield are optional, needed only
  if you ever go to numbers.
- **Load cases**: named, located on a selector (usually an interface), with a
  direction and a *qualitative* magnitude.

```jsonc
"loads": [
  { "id": "service", "on": "env:mating_tube",
    "direction": "up", "magnitude": "hard",       // qualitative, not Newtons
    "note": "the leg pushes hard upward against the clamped tube" }
],
"supports": [ { "at": "env:mount_surface" }, { "at": "bolts" } ]
```

Enough to reason about the load *path* and *relative* stress — not to compute it.

## 10. Qualitative structural reasoning (linear, no magnitude)

The agent reasons with monotonic, direction-only rules — the fundamentals, not a
solver:

| observation | qualitative rule |
| --- | --- |
| load path | force flows from where it's applied to the supports |
| moment | longer arm from load to a junction → more bending there |
| concentration | sharper corner / smaller blend / thinner wall → higher stress |
| mitigation | bigger blend radius, a rib along the load line, or more material on the path → lower stress |
| stiffness | material deeper from the neutral axis resists bending best |

That is enough to (a) locate the critical spot, (b) accept a fuzzy directive, and
(c) choose a concrete geometry change:

> "Make that gusset a bit stronger" → the gusset is `blend_leg`, on the primary
> load path (leg → plate → bolts). Options, best bang-for-buck first: enlarge the
> fillet radius; add a rib along the load line; thicken the plate locally. Propose
> one; check it qualitatively.

**Qualitative structural validators** — relative, no FEA:

- material was *added on* the primary load path, not off it;
- no *new* sharp concentrator was introduced;
- the load path was not *lengthened* (longer path → more bending);
- the change didn't thin a wall below `min_wall` or clash the environment.

They answer "did stress move the right way?" without a number. FEA can later
*confirm* a magnitude, but is not required to be useful.

## 11. Manufacturing process — the design driver

"Robust" has no meaning without the process. The world model carries a `process`
and `material` (per part, overridable per body), and the qualitative rules from
§10 are **conditioned on them**. The same intent — "make this joint robust" —
resolves to *different geometry* depending on how the part is made:

```jsonc
"manufacturing": { "process": "fdm", "material": "PLA" }
// or          { "process": "cnc", "material": "aluminium-6061" }
```

| intent | FDM (printed) | CNC (milled aluminium) |
| --- | --- | --- |
| robust joint | chamfered gusset — adds material, no overhang, prints in orientation | internal **fillet ≥ tool radius**; thicker section; no added gusset |
| internal corner | fine as-is | **must** be filleted to ≥ tool radius (a mill can't cut a sharp inner corner) |
| overhang / bridge | avoid, or add a support-free chamfer | irrelevant |
| bolt head recess | modelled counterbore | counterbore or spot-face |
| what varies strength | **print orientation** | fixturing / tool access |

So the agent's move for "make that joint robust" *branches on `process`*: on FDM it
may add a chamfer; on CNC it fillets the internal corner to the tool radius and
thickens the web. **Chamfer and fillet are both general primitives — the choice
between them is a process decision, not a preference.**

Process/material are first-class facts, not export settings: they change which
geometry is *correct*, and they accumulate in the ledger (§12) as durable intent.

## 12. The intent & fact ledger

Stress reasoning is only as good as the accumulated context. The agent keeps an
**append-only ledger** of everything the user states across the *whole* build —
loads, roles, preferences, directives, rationale — always in context, not just the
current geometry:

```jsonc
"ledger": [
  { "t": 0, "kind": "process",   "text": "FDM printed in PLA" },
  { "t": 1, "kind": "fact",      "text": "the leg pushes hard upward against the clamped tube" },
  { "t": 2, "kind": "intent",    "text": "the gusset is structural — primary load path" },
  { "t": 3, "kind": "objective", "text": "prefer stiffness over weight" },
  { "t": 4, "kind": "directive", "text": "make the gusset a bit stronger" }
]
```

Two kinds matter differently:

- **durable** (facts, constraints, objectives) — persist and are re-checked on
  every rebuild; they are *why the part is the way it is*.
- **one-off** (directives) — executed once, then kept as rationale so a later edit
  knows what a feature was *for*.

The ledger is also where the **objective** for "optimal" accumulates (t=3). It's
the memory that lets the agent say: "you told me the gusset is structural and to
favour stiffness, so I enlarged the fillet rather than shaving weight."

## 13. Worked turn: "rotate the leg 45° and redistribute the stress"

```
PERCEIVE   tree + inventory + dep-graph + environment + loads + ledger + last report
REASON     env:clamped_tube says the leg presses on the horizontal tube through the
           clamp. Load 'service' is up/hard at the leg. Rotating leg_spin 45° changes
           the angle the leg pushes on the clamped tube and lengthens the moment arm
           to blend_leg → more bending at the gusset, and the clamp split is loaded to
           open. Ledger: gusset is structural; favour stiffness.
PROPOSE    (1) params.leg_spin = 45   (2) grow blend_leg 14→20 + rib along the load line
ACT        rebuild(tree')  →  inventory' + qualitative structural report
OBSERVE    material added on the load path ✓; no new concentrator ✓; wall ≥ min_wall ✓;
           no clash with env ✓; clamp-split-opening flagged as a residual concern.
PRESENT    "Rotated the leg 45°. It now pushes on the clamped tube at a steeper angle,
            so the gusset carries more bending — I enlarged that fillet and added a rib
            along the new load line (you said the gusset is structural and to favour
            stiffness). Watch out: the new angle tends to pry the clamp open; if that
            matters we should stiffen the split or add a second bolt."
```

No magnitudes — but a decision an engineer would recognise, with the reasoning and
the residual risk both stated. That is the bar, and it is reachable now.

Build-order note: this whole layer is **facts + qualitative rules**, not a solver.
It rides on the v0 world model (inventory + selectors + dep graph). The concrete
first structural step is data, not math: add `environment`, `loads`, `materials`,
`process`, and the `ledger` to the IR, and the four qualitative validators above.
Structural rules are conditioned on `process` (§11). FEA stays out of scope until
numbers are actually needed.
```
