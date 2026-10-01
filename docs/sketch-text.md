# Sketch text outlines

In an active sketch, choose **Create → Text**, enter text, cap height in millimetres and an
angle in degrees, then click its baseline start. The preview follows the pointer. Escape cancels
placement; confirmed placement is one undo step. Existing geometry under the click is not replaced.

Text is converted at placement into normal lines and exact degree-2 control B-splines. Coincident
endpoint constraints keep each glyph contour closed. Glyph holes are normal nested sketch loops,
usable for extrusion and cutting. Height measures flat capitals such as H; rounded letters can
overshoot that height. Positive angles rotate counter-clockwise about the first baseline start.
Newlines move down by 1.6 times the cap height. Spaces use the font's advance width.

## Persistence decision

The approved condition was compatibility with previous versions. The implementation therefore uses
only existing sketch v3 entity and constraint payloads, with no text records, metadata, font blobs,
new entity types, version bumps or migrations. Existing sketch-v3 readers can reopen the outlines;
the v1/v2 limitations on v3 control B-splines are unchanged. Cloud manifests, merge rules and semantic
diffs use their existing geometry support. PR #45's editable `texts` payload and old sketch-v2 bump
were not imported.

Each segment receives an id through the current sketch allocator, including collision checks against
existing entities. Profile and swept-edge references use the existing entity-derived identities.
Saving retains the exact placed geometry, so reopening does not depend on a font or regenerate glyphs.

## Supported interactions and limits

- Select individual outlines or multiple outlines with the existing sketch selection tools.
- Edit line endpoints and B-spline poles; apply normal sketch constraints.
- Copy/paste, move, rotate, mirror and delete selected outlines. Copy/paste allocates fresh ids and
  transfers constraints wholly inside the selection. Deletion and transforms are undoable.
- Content, font, text-level height and angle cannot be edited after placement. To change wording,
  undo placement or delete the outlines and place new text. There is no stored text group or
  whole-text selection/edit command.
- Trim, split, extend and offset retain the existing geometry-tool restrictions: quadratic
  B-spline portions are unsupported; straight portions are ordinary lines.
- One deterministic Noto Sans Regular font ships. Coverage is printable ASCII, Latin-1 and the
  typographic marks baked by the generator. Unsupported characters and text without visible
  outlines are rejected without changing the sketch. There is no shaping, font choice or program/MCP
  text operation.

## Font assets and reference

The outline data, path decoder, OFL-1.1 license, generation script and text icon are reused from
[PR #45](https://github.com/Lenny32/spicy3d/pull/45), commit
`f5d8d20f209fe02bd370862a1b85f7db308f66a7`. Emboss/deboss and its unrelated changes are excluded.

Regenerate outlines with `node scripts/generate-font-outlines.mjs <NotoSans-Regular.ttf>`.
The runtime ships baked outlines and the adjacent OFL license, with no font parser or font download.
The application build includes the license at `licenses/noto-sans-OFL.txt`.

## Validation

Text kernel tests cover glyph holes, separate contours, cap height, multiline spacing, rotation,
entity-edge mapping, stable profile references through reordering and transforms, copy/paste and
mirror, and `.spicy` save/reopen with an extruded O and volume accounting for its hole. Command and
session tests cover exact quadratic conversion, preview, unsupported/empty input, random ids,
cancellation, one-step undo/redo, selection, transforms, deletion and session re-entry.
