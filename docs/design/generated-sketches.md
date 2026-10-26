# Generated sketches + sketch chat: design (for review)

Status: proposal, nothing built yet. Branch `generated-sketches`.

## 1. What exists today (summary of the investigation)

**Sketch documents.** A sketch document's `data` holds `sketches[]`. Each sketch
has entities, constraints, `groups` (`{name, ids}`), element `name`s, and a `profile`.
The browser computes the profile on every save (`build/sharedSketch.ts`). It holds
the loops, items (circles with their center and radius, points, lines), names,
groups and per-group loops. Parts read only the profile, never the entities.
The profile's sha256 is the sketch's "version" (`shared_defs.profile_version`).
`solvedWith` / `solveError` record which project-parameter values the shapes were
solved for. The backend never solves: a sketch is "pending" when the values differ,
and "failed" when the browser's solve couldn't meet them (the last good shapes and
their values are kept, called "held").

**Versions.** Sketch documents have no version list. The only history is the undo
stack (History panel). Part versions pin each sketch's profile and the parameter
values they were built with.

**Sketch editor** (`EditorPage` → `SketchWorkspace`):
- toolbar (drawing tools, constraints, Props, 3D, DXF/PDF/PNG, CAM);
- History panel on the left, canvas in the middle;
- a fixed right column: Sketches, Groups + Used by parts (Rebuild all),
  Parameters (Project parameters / This sketch only), Pattern, Properties;
- Log and status bar at the bottom.

There is no chat. There is no read-only mode and no general hover highlight. There
is a non-editable overlay hook (`copyPreview`) and a sketch thumbnail renderer.

**Part editor** (`ScriptViewer`, 4,600 lines):
- layouts Code / Chat / Context / 3D / Operations;
- a textarea code editor with highlighting. Build errors show in a box over the 3D
  view, not on the line.

The part chat is written inline in ScriptViewer, so it is not a component yet. It
sends one request: `POST /build/edit`, which calls `assistant.edit_script` with:
- the project brief, parts manifest, project parameters and shared sketches
  (`project_context`);
- context files, @-mentions, and the `read_part`, `use_sketch`,
  `set_project_parameter` and `propose_brief` tools.

The pieces already shared are `MentionMenu`, `BriefProposalCard`,
`ParameterProposalCard`, `ContextChips`, `ChatMessage` and `Markdown`. Messages are
stored in `document.chat`, and every AI edit is a "↩ revert here" checkpoint.

**Parts using sketches.** `data.sketchRefs = {alias: {document, sketch}}`. On the
server, `shared_defs.resolve` turns each ref into a profile, and the engine binds
`SK["alias"]` as a build123d Sketch with `.group()`, `.named()`, `.circles`,
`.points`, `.on()`. Access checks:
- a sketch in the same project is always readable;
- otherwise the part's user needs document access;
- with no user, the same creator.

The "Use project sketch…" dialog (part side) lists sketch documents, sets the alias
and hints at `SK["x"].group("…")`. The sketch editor's "Make parts:" menu (Extrude… /
Cut… / Revolve…) picks the whole sketch, a group or a named element, then a part or
a new part. It then opens the part with the dialog ready.

**Out of date.** A part is out of date when what it reads now differs from its last
build (`stale`). This shows on the badge on cards, in "Used by parts" with
Rebuild all, and in the part editor, which rebuilds itself when a sketch it uses
has changed. A save that drops a group a part uses is held by the
"Not saved yet: this change would break…" banner (Undo / Save anyway).

**Build worker.**
- One warm subprocess, serialised, with a 60 s timeout. It is killed and restarted
  on a timeout or a crash.
- It runs in bubblewrap (no network, read-only filesystem) when available; on the
  Mac it runs as a plain subprocess. There are no import restrictions.
- `/build/run` builds without saving anything, and the op-dialog previews use it.
  `/build/inputs` reports unsolved sketches.

**Project parameters.**
- `PUT /projects/{id}/parameters` handles renames (it rewrites scripts and sketch
  expressions).
- `GET …/parameters/uses` gives each name's sketches and parts, so "affects N parts"
  is already computable.

## 2. Design decisions

1. **A generated sketch is a sketch document whose single sketch is written by the
   server.**
   - `data.type = "sketch"`, `data.source = "generated"` (absent means drawn) and
     `data.code`.
   - After each run the server writes the sketch's entities (lines, arcs, circles,
     points: display only, marked `generated`) and its profile:
     - each output is a group, and an output with one element is also a named element;
     - circles are kept as circles (center and radius).
   - The run record goes in `sketch.generated = {outputs: [{name, description, kind,
     count, size}], checks, annotations, reads, error, ran_at}`.

   Because it is the same profile, these work unchanged:
   - `SK["layout"].group("brace_holes")`, `.circles` and `.points`;
   - the version hash and pinning;
   - out of date, Used by and the save guard;
   - thumbnails, DXF/PDF/PNG export and CAM on the generated drawing (useful for CF
     plates).

   The browser never recomputes a generated sketch's profile.
2. **Parameters read** are recorded by a `PP` that remembers which names the code
   read. They go into `solvedWith` (the values of the last good run) and
   `generated.reads`. A failed run sets `solveError` exactly as a drawn sketch's
   failed solve does. `sketch_state`, held values, "Used by" on the project's
   Parameters table, and "parts never build from an unsolved sketch" then all apply
   as they are. The only difference: the **server** re-runs generated sketches. It
   does so when project parameters are saved (in the same request, for the sketches
   that read a changed name) and when the code is saved. So "pending" only shows
   briefly or after a crash, and a part build re-runs a pending sketch instead of
   asking the browser.
3. **Runs** use the same worker as parts, in a "sketch" mode, with the same sandbox
   and timeout. The namespace is `from build123d import *`, `PP`, and the four
   functions below. There is no `part`, `SK` or `ASSETS`.

   **Trial runs**:
   - are used by the parameter sliders and the chat's proposals;
   - take value overrides and return the result;
   - save nothing and create no version.
4. **Code history**: each saved change keeps the previous code
   (`codeHistory`, like `modelCodeHistory`). AI edits are "↩ revert here"
   checkpoints in the chat, like parts. As with drawn sketches there is no separate
   version list; parts pin the profile as they do today.
5. **The chat becomes a component.** The part chat's message list and input
   (mentions, attachments, context chips, model picker, proposal cards) move out of
   ScriptViewer into `ChatPanel`. The part editor and both sketch editors use it.
   The backend gets `assistant.sketch_chat` beside `edit_script`. It shares the
   context assembly and tool loop, with its own tools and its own "this sketch"
   context.

### The code API (proposed names)

```python
output(name, shapes, description=None)
    # shapes: a Face/Sketch (outline with holes), Wire/Edge, Circle, a point
    # (Vector/tuple), or a list of any of these. Circles keep center and radius.
    # The name is what parts use: SK["layout"].group(name). Names must be unique.
check(name, ok, message="", output=None)
    # A pass/fail line shown in Checks; output= links it to an output to highlight.
label(text, at)                     # a note on the drawing at (x, y)
dim(p1, p2, text=None)              # a dimension line on the drawing; text defaults
                                    # to the measured length
```

Plus one helper, `holes(points, d)`, which gives a list of circles. (Without it,
`[Circle(d/2).locate(Pos(*p)) for p in pts]` is the noise every sketch would repeat.)

## 3. Screens and wording

### 3.1 New sketch (no up-front choice)

On the project page, **New sketch** works as today: it opens an empty drawn sketch.
Next to it, a small ▾ opens a menu:
- "Drawn sketch" (the same as the button);
- "Generated from code": an empty generated sketch with a starter program.

The sketch card shows a small **GENERATED** tag, and its second line lists outputs:
"plate_outline, brace_holes, +5". Drawn sketches get no tag.

**Empty drawn sketch.** The canvas shows faint centred text that disappears with the
first element:

```
              Empty sketch.
   Draw with the tools above, or ask the AI below, for example
   "lay out the frame plate from the project parameters".
              Write it as code instead
```

"Write it as code instead" is a link. It turns this empty sketch into a generated
one.

**Chat in the drawn sketch editor.** A strip along the bottom, above the status
bar, is the same chat panel as the part editor's Code layout. It is collapsed to the
input line until there are messages. Placeholder: "Ask about this sketch, or describe
one for the AI to make; type @ to mention a part".

### 3.2 The AI proposes a generated sketch

The user writes in a drawn sketch's chat: "lay out the hexa frame from the project
parameters". The AI replies in one sentence, with two buttons:

```
┌ AI ─────────────────────────────────────────────────────────────┐
│ This is better made as a generated sketch: I'd write code that  │
│ draws the frame from the project parameters, so it follows them │
│ when they change.                                               │
│   [ Make it a generated sketch ]   [ No, I'll draw it ]         │
└─────────────────────────────────────────────────────────────────┘
```

- **If the sketch is empty**, it becomes the generated sketch: same document, same
  name.
- **If it has drawing in it**, the button reads "Make a new generated sketch". It
  creates "Frame layout" (a name the AI proposes, editable in the card) beside it and
  opens it. The drawn one is left alone.

The AI then writes the code. The reply lists what it made:
"Made 7 outputs and 3 checks (2 pass, 1 fails: …)".

If the user asks the chat in a drawn sketch to change the drawing, it says plainly:
"I can't change drawn sketches yet. Drag the shape or edit its dimension; or I can
remake this sketch as a generated one."

### 3.3 The generated sketch editor

It is the same page as the drawn editor (`/edit/:id`), with these differences:
- **Toolbar**: no drawing or constraint tools. It keeps Home, Project, the name with
  a GENERATED tag, Fit All, Props, DXF/PDF/PNG, CAM and the theme.
- **View switch** above the canvas: **Drawing | Code**.
- **Right column**: Outputs, Parameters, Checks, Used by parts.
- **Chat** along the bottom, open by default.

```
┌ ⌂  Drone frame / Frame layout  GENERATED      Fit  Props  DXF PDF PNG  CAM ┐
│ [Drawing] Code                                                            │
├──────────────────────────────────────────────┬────────────────────────────┤
│                                              │ OUTPUTS                    │
│      ╭───────────╮                           │ ▭ plate_outline  1 shape   │
│     ╱ ○○   ○○     ╲    plate 186 × 172       │   Top plate, Bottom plate  │
│    │  ○○  ┌─┐  ○○  │                         │ ○ brace_holes  36 holes Ø3.2│
│    │      └─┘      │   ← dims and labels     │   Top plate, Bottom plate, │
│     ╲ ○○   ○○     ╱      from the code       │   Arm brace                │
│      ╰───────────╯                           │ ○ wall_holes  12 holes     │
│                                              │ … (each row: hover lights  │
│                                              │   it up in the drawing)    │
│                                              │ PARAMETERS (read by the    │
│                                              │ code)                      │
│                                              │ brace_r_in [42  ] mm       │
│                                              │   ────────●──────          │
│                                              │ arms       [6   ]          │
│                                              │ …                          │
│                                              │ CHECKS            2 of 3 ✓ │
│                                              │ ✓ Fits the 300×300 bed     │
│                                              │ ✗ Braces collide: 2 and 3  │
│                                              │   overlap by 1.4 mm        │
│                                              │ ✓ Holes ≥ 4.8 mm from edges│
│                                              │ USED BY PARTS  Rebuild all │
│                                              │ Top plate      up to date  │
├──────────────────────────────────────────────┴────────────────────────────┤
│ (chat history)                                                            │
│ [Ask about this sketch or describe a change; type @ to mention a part][Ask]│
└───────────────────────────────────────────────────────────────────────────┘
```

**Drawing.** It shows the generated shapes in the normal sketch style, plus the
code's `label` and `dim` annotations. It is read-only:
- Hovering a shape outlines its output and shows a tooltip: "brace_holes: 36 holes
  Ø3.2 (Top plate, Bottom plate, Arm brace)".
- Clicking a shape selects its whole output and highlights the row in Outputs.
- Dragging, Delete, or pressing a drawing-tool key shows a hint for 3 s at the
  bottom of the canvas: "This drawing comes from code. Change a parameter on the
  right, or ask the AI below."

**Outputs.** One row per output: an icon (shape ▭, holes ○, points ·, lines ╱), the
name, and a size ("1 shape", "6 shapes", "36 holes Ø3.2", "12 points", "4 lines").
The second line is "used by Top plate, Arm brace" or "not used by any part yet". The
description from `output(..., description=)` shows as a tooltip.
- Hovering a row highlights the output in the drawing.
- Clicking a row selects it and shows **Use in a part ▸** with Extrude… / Cut… /
  Revolve…. This is the existing "Make parts" flow, with this output preselected
  under Shapes.
- Empty: "No outputs yet. The code makes them with output("name", shapes), or ask
  the AI."

**Parameters.**
- Heading: "Parameters (read by the code)".
- Each project parameter the last run read gets the shared parameter control
  (3.3a): number field, unit, slider.
- Changing a value runs the code with it (at most one run at a time, the latest
  value wins) and redraws. Nothing is saved.
- While any value differs from the project's, a bar shows over the drawing:

  ```
  Trying brace_r_in = 35 (project: 42). Not saved.   [Reset]  [Apply to project…]
  ```

  The changed rows show the project value faintly ("project 42"), and the checks
  update live.
- **Apply to project…** opens a small confirm:

  ```
  Set brace_r_in to 35 for the whole project?
  It affects 3 parts (Top plate, Bottom plate, Arm brace).
  They show out of date until they're rebuilt.
                                         [Cancel]  [Apply]
  ```

  The confirm also names other sketches that read the value. After Apply, Used by
  parts shows the three as "out of date" and the note reads: "brace_r_in = 35
  applied. 3 parts are out of date. Rebuild all". These are the same Rebuild all
  and badges as today.
- Below the list, a link: "All project parameters ↗" (the project page).
- Empty: "The code doesn't read any project parameters. Use PP["name"] in the code,
  or ask the AI to drive a size from one."

**Checks.**
- Heading: "Checks", with a count "2 of 3 pass" (red when any fail).
- Each row is ✓ or ✗, the name, and the message on a second line.
- Clicking a row that names an output highlights that output.
- Empty: "No checks. Ask the AI to add some, for example "check it fits a 300 mm bed"."
- A failing check never blocks anything. It is information, shown here, and as
  "⚠ 1 check fails" next to the sketch's link in the part editor.

**Used by parts.** This is the existing section (status per part, Rebuild all).
Each part's second line adds the outputs it uses.

**Code.**
- The Code view replaces the drawing with the editor: the part editor's highlighted
  textarea, with line numbers.
- **Run** (⌘/Ctrl+Enter) runs and saves.
- A short header comment explains the four functions.
- An error marks its line in red in the gutter, with the message under it.
- A save that would drop or rename an output a part uses gets the existing banner:
  "Not saved yet: this change would break 2 parts that use this sketch. Top plate
  uses brace_holes" [Undo] [Save anyway].

**Error state.** The code failed, or a parameter value can't be met. The last good
drawing stays, dimmed, with a box over it:

```
The code stopped at line 37: NameError: name 'brace_w' is not defined.
Parts keep using the last good drawing.          [Fix with AI]  [Show line 37]
```

For a value the code can't handle, the box reads: "Can't generate with brace_r_in =
20: (message). Parts keep the drawing for brace_r_in = 42." This is the same wording
as a drawn sketch's failed solve.

**Empty generated sketch** ("Generated from code", or "Write it as code instead").
- The code starts with:

  ```python
  # Code that draws this sketch. Parts use what it outputs.
  # PP["name"] reads a project parameter.
  # output("name", shapes) gives parts SK[...].group("name").
  # check(...), label(...), dim(...) add checks and notes to the drawing.

  output("outline", Rectangle(80, 60))
  ```

- The drawing shows that rectangle. Over the chat input: "Describe the sketch you
  want, for example "a 30.5 mm stack hole pattern with M3 holes"."

### 3.3a The parameter control (one control everywhere)

Every number parameter uses the same control:
- generated sketches (Parameters);
- drawn sketches (Project parameters, and This sketch only);
- the part editor (Parameters, the script's P values);
- the project page's Parameters table (the Value column).

```
brace_r_in   [ 42    ] mm  ⋯
─────────────●────────────────────
```

**The control**:
- **Number field**: any value, including outside the slider's range.
- **Unit**: mm, °, or blank for a count.
- **⋯ opens "Slider range"**: Min, Max, Step fields; blank means automatic. The range
  is saved with the parameter:
  - for project parameters, on the project parameter (new optional
    `min`/`max`/`step` fields);
  - for P values and a sketch's own parameters, in the document (`paramRanges`).
- **Automatic range**: about 0.5× to 2× the saved value, rounded to a round
  number. For example, 42 gives 20 to 85 in steps of 0.5, 3.4 gives 1.5 to 7 in
  steps of 0.05, and 406.4 gives 200 to 850 in steps of 5. A count (whole number,
  no unit) gives steps of 1 and never goes below 1. The range is worked out from
  the saved value, so it stays put while you drag.
- **Text values** ("M3") get no slider.
- **A trial value** has an accent outline, with the saved value faintly beside it
  ("saved 42").

**Trial values are never saved until you apply them.** Dragging or typing only
previews. One bar, in the same place in each editor (over the drawing or the 3D
view), lists the trial values:

```
Trying brace_r_in = 35 (project: 42). Not saved.        [Reset]  [Apply to project…]
Trying wall = 3 (saved: 2). Not saved.  building…       [Reset]  [Apply]
```

- **Apply to project…** (project parameters) confirms with "It affects N parts (…)",
  then saves. The parts show out of date, with Rebuild all.
- **Apply** (a part's P value, a sketch's own parameter) is the editor's normal save.
  For a part, that rewrites the P line in the script, keeping the old one in history.
  For a sketch, it is one undo step.
- **Reset** drops all trial values.
- **Leaving the editor** with trial values drops them: they were never saved.

**How fast the preview follows the slider**:
- **Generated sketch**: live while dragging. One run at a time, at most about 8 a
  second. A result for a value the slider has already left is dropped, and the run
  for the latest value goes next.
- **Drawn sketch**: live while dragging. The browser re-solves on each frame, and
  nothing goes into undo until Apply.
- **Part**: it rebuilds when the slider pauses (about 300 ms) or is released, and
  when Enter is pressed in the number field. The previous model stays visible but
  dimmed until the new one arrives, and "building…" shows in the bar. A result for a
  value that has since moved on is dropped.
- **Project page**: a changed value shows the bar at the foot of the table:
  "brace_r_in 42 → 35, not saved. It affects 3 parts (…). [Reset] [Apply]". Names,
  units and descriptions save as today, when you leave the row.

### 3.4 Chat in a generated sketch

- **What the AI sees**:
  - everything the part chat sees (brief, parts manifest, project parameters with
    Used by, context files, @-mentions, `read_part`);
  - this sketch: its code, its outputs with sizes, its checks with results, the last
    error, and the parameters it read;
  - Used by: each part and the outputs it uses.
- **How it changes the sketch**: it writes the code (a tool like `write_script`).
  The server trial-runs it, with one corrective retry on an error.
  - **No output a part uses changes**: the change is applied and saved straight
    away, with a checkpoint.
  - **Otherwise**: the reply card shows what changes and holds it until the user
    agrees. The drawing shows the proposal over the current one, which is dimmed.

    ```
    This changes outputs parts use:
      brace_holes: 36 → 48 holes (Top plate, Bottom plate, Arm brace)
      plate_outline: 186×172 → 200×184 mm (Top plate, Bottom plate)
                                           [Discard]  [Apply]
    ```
- It may add checks and labels without being asked.
- It can propose a project parameter, through the existing "Proposed project
  parameter" card.

### 3.5 The part side

There is nothing new to learn here.
- **"Use project sketch…"** lists both kinds, with a thumbnail. A generated sketch's
  row shows its outputs ("plate_outline · 1 shape", "brace_holes · 36 holes Ø3.2",
  …), and the hint uses its first output: `SK["layout"].group("brace_holes")`.
- **Extrude/Cut/Revolve "Shapes"** lists "Output: brace_holes (36 holes)" for a
  generated sketch, where a drawn one shows "Group: …".
- **The part's top line** stays "Sketch Frame layout Edit ↗", plus "⚠ 1 check
  fails" when one does.
- **The part chat's shared-sketch context** lists outputs with their descriptions.

## 4. First-use walkthrough (Drone frame)

**Setup** (once, in a test copy of the database): a "Drone frame" project
with a short brief and these parameters. It is a hexa X: arms at 30°, 90°, …,
330°, forward is +X, and the origin is the body centre on the bottom plate's top
face.

| name | value | name | value | name | value |
|---|---|---|---|---|---|
| prop_d | 406.4 mm (16") | tip_gap | 20 | arm_count | 6 |
| arm_od | 16 | clamp_gap | 0.5 | brace_l | 80 |
| brace_w | 40 | brace_t | 15 | brace_chamfer | 10 |
| brace_r_in | 42 | plate_t | 5 | bed | 256 |
| wall_t | 8 | stack_pitch | 30.5 | m3_clear | 3.4 |

The layout rules are constants in the code, as you gave them. The checks are:
plate fits bed; braces don't collide (5 mm clearance at the inner corners); hole
edge to brace edge ≥ 2 mm; stack_space holds a 36 mm board.

Expected: a plate of about 239 × 248 mm and a stack space of Ø84. With brace_r_in
35: about 227 × 234 and Ø70.

**(1) Create the layout by asking.**
1. On the project page, click **New sketch**. An empty sketch opens, with the hint
   that names the AI.
2. Type "lay out the hexa frame from the project parameters" and press Ask. The AI
   proposes a generated sketch in one sentence.
3. Click **Make it a generated sketch**. The document is renamed "Frame layout", the
   toolbar loses its drawing tools, and the drawing appears.
4. The chat says "Made 7 outputs and 3 checks (all pass)".

**(2) Understand it.** The right column says it all:
- Outputs: plate_outline, brace_outline (6 shapes), brace_holes (36 holes Ø3.2),
  wall_holes (12), stack_holes (4), top_opening, stack_space, each with "not used by
  any part yet";
- Parameters: the ones the code read;
- Checks: Fits the 300×300 bed / No braces collide / Holes ≥ 4.8 mm from edges.

Hovering brace_holes lights up the 36 holes. Trying to drag one shows the hint.

**(4) Use an output in a part** (before (3), so there are parts to update).
1. Click plate_outline, then **Use in a part ▸ Extrude…** → New part "Top plate".
2. The part editor opens with Extrude ready: the shape is
   `SK["frame_layout"].group("plate_outline")`, 2 mm. Click OK.
3. In the same part, Cut… → brace_holes, wall_holes, top_opening.
4. Do the same for Bottom plate (with stack_holes), and Arm brace (brace_outline
   extruded, brace_holes cut).
5. Back in the sketch, each output's row now names its parts, and Used by parts
   lists all three as up to date.

**(3) Change a parameter, see it, apply it.**
1. In Parameters, drag brace_r_in from 42 to 35. The plate shrinks as you drag, to
   about 227 × 234, and the bar reads "Trying brace_r_in = 35 (project: 42). Not
   saved."
2. The checks update as you drag. The stack space drops to Ø70.
3. Click **Apply to project…**. The confirm reads "It affects 3 parts (Top plate,
   Bottom plate, Arm brace)". Click Apply.
4. Used by parts shows the three as out of date, and so do their cards on the
   project page.
5. Click **Rebuild all**. They rebuild with the holes in their new places. Open Top
   plate and Bottom plate to see the holes line up.

## 5. Build order (after OK)

1. **Backend**: the sketch run mode in the worker, and the conversion from outputs
   to profile + entities. Then:
   - the run / trial-run / save endpoints;
   - re-running on a parameter save;
   - `sketch_pp` / `uses` / `used_by` for generated sketches;
   - per-alias output use;
   - tests.
2. **The ChatPanel component**, extracted from ScriptViewer, with the part editor
   unchanged in behaviour.
3. **The generated editor**: read-only drawing, Outputs/Parameters/Checks, the Code
   view, the error state, and conversion.
4. **Sketch chat**: the backend `sketch_chat`, the drawn-sketch chat, the proposal
   to make a generated sketch, and the confirm before used outputs change.
5. **The part side**: the dialog, the Shapes list, and the check warning.
6. **Finishing**: the walkthrough in the browser, the guide section and screenshot,
   and the feature plan.
