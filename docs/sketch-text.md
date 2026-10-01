# Sketch text

The sketch ribbon's **Text** command creates an editable text object. Pick two opposite frame
corners, enter multiline content, and confirm. **Edit text**, Enter on a selected frame, or a
double-click reopens its settings. The selected frame has a rotation handle; drag it to rotate.
Select a frame before dragging it to move. Escape cancels a drag; dialog Cancel clears its preview.
Each confirmed placement, edit, transform, explosion or deletion is one undo step.

Settings include cap height, frame dimensions and position, angle, character spacing, horizontal
and vertical alignment, and horizontal/vertical flips. Positive angles rotate counter-clockwise
about the frame origin. Cap height measures flat capitals such as H; rounded letters may overshoot.
Explicit newlines use 1.6 cap heights between baselines. Text is aligned using glyph advance widths;
the frame does not clip outlines or automatically wrap content.

## Persistence decision

The two options were fixed outlines using existing geometry, or editable text with a new saved
payload. Editable text was approved so future scripts can change its content. Backward compatibility
was clarified as **the new build opens existing documents**. Older builds need not preserve new text.

Sketch module version **4** adds optional `SketchData.texts`. Each record stores `id`, `value`, `x`,
`y`, `height`, `angle`, `frame: { width, height }`, and `profileIds`, with optional `font: "sans"`,
`alignment`, `verticalAlignment`, `spacing`, `flipHorizontal` and `flipVertical`. The saved document
envelope version and parametric module version remain unchanged. The sketch 3 → 4 migration is an
identity operation: existing geometry, constraints and metadata retain their meaning. Older builds
refuse version 4 instead of loading a document and discarding its text. Existing document fixtures
are unchanged; `v2/sketch4-text.json` demonstrates editable text and an explicit extrusion reference.

Text is outside PlaneGCS. Solver load/save, fork, reset and solve retain its settings and identities.
Every object and contour id uses the current collision-checked sketch entity allocator. Each contour
has its own stable slot; size, placement, rotation and object reordering preserve profile references.
Shortening content retains retired slots, which cannot be allocated to ordinary entities. Changing
content can change the topology: slots track contour order, not the semantic identity of letters.

Merge rules match objects by id. Content and its contour slots merge together, frame position merges
as one pair, and height, angle and other layout fields merge independently. Different concurrent
content changes conflict once. Semantic comparison summarizes text changes per sketch; conflict
reveal selects the owning text. Resolving a deleted text against a new profile reference restores
the whole owning record. Device files and cloud manifests carry the same text settings.

## Supported interactions and limits

- Select, edit, move, rotate, mirror, copy/paste and delete complete text objects. Copies receive fresh
  object and contour ids. Mirrored text remains editable.
- Use text outlines as normal sketch profiles, including glyph holes and extrusion. The frame does
  not contribute profile edges.
- **Explode text** is a separate undoable command. It converts text to ordinary lines and exact
  degree-2 control B-splines, with coincident seams. Text-level editability is then lost. Existing
  downstream profile references should be reselected after explosion because entity identities change.
- Editable text cannot be constrained, trimmed, split, extended or offset at glyph level. Explode
  first to use the existing geometry tools; their existing B-spline restrictions still apply.
- One deterministic Noto Sans Regular font ships. Coverage is printable ASCII, Latin-1 and baked
  typographic marks. Unsupported characters and content with no visible outlines are rejected.
  Font selection, bold/italic, shaping, automatic wrapping, text on a path, associative frame
  constraints and an MCP text operation are unsupported in this story.

The public `SketchSolver.addText`, `updateText`, `removeText`, `text` and `texts` methods provide
validated edits for the future scripting story. `updateText(id, { value: "New content" })` preserves
existing contour slots and allocates additional slots if needed. A caller commits `solver.toData()`
through the normal sketch editor or a document transaction; these APIs do not create history by
themselves.

## Font assets and reference

The outline data, decoder, OFL-1.1 license, generation script and icon reuse
[PR #45](https://github.com/Lenny32/spicy3d/pull/45), commit
`f5d8d20f209fe02bd370862a1b85f7db308f66a7`. Its old sketch-v2 assignment and unrelated emboss/deboss
changes are excluded. Regenerate with `node scripts/generate-font-outlines.mjs <NotoSans-Regular.ttf>`.
The build ships the license at `licenses/noto-sans-OFL.txt`, with no runtime font download or parser.

The interaction follows Fusion's [rectangular text placement](https://help.autodesk.com/cloudhelp/ENU/Fusion-Sketch/files/SKT-CREATE-TEXT.htm),
[editable text settings](https://help.autodesk.com/cloudhelp/ENU/Fusion-Sketch/files/SKT-REF-TEXT-DIALOG.htm),
and separate [Explode Text](https://help.autodesk.com/cloudhelp/ENU/Fusion-Sketch/files/SKT-EXPLODE-TEXT.htm).

## Validation

Kernel tests cover glyph holes, cap height, multiline layout, rotation, contour/edge mapping, stable
profile references after transformations, size changes and reordering, copy/paste/mirror, explosion,
fixture loading and `.spicy` save/reopen with an explicit extrusion. Command/session tests cover
preview, invalid input, allocator collisions, retained slots, solver round trips, cancellation,
rotation-handle undo, selection, transforms, deletion and session re-entry. Merge tests cover
independent and conflicting edits, semantic comparison and cloud manifest/device file round trips.
