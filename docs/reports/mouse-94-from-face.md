# #94 — associative from-face extrusion

Implemented the approved parametric-format-6 `startFace?: {nodeId?: string; face: ProfileRef}` field. Existing extrusions omit the field and retain their behavior. The pure 5-to-6 migration changes no feature payload; document format remains 2 and sketch remains 3. Approval and version reservations remain in `mouse-schema-plan.md`.

The native `prismFromTracked` splits a profile-footprint prism by the actual starting and ending surfaces. A distance ending surface is a translated copy of the start, preserving curved caps rather than deriving an offset from a center point. A ray witness chooses the bounded cell, not its cap geometry. The trimmed starting patch must cover the complete profile: missing or partial coverage fails, multiple accepted cells report ambiguity, and translated-surface distance also checks exact projected-area times depth. To-object and through-all endings use the same operation.

History retains profile origins for side faces and curved starting edges, plus authoritative end-cap indexes. Starting references reuse the extent timeline/dependency/cache/re-anchor machinery, including host input, linked target input, external live bodies and world-to-host placement. Start offset expressions move the selected surface along the sketch normal, including negative-depth extrusions. Symmetric sides use opposite directions.

Create/edit commands expose Start from face and Choose starting face, highlight stored or picked starts, gate confirmation on a pick, and commit through the existing one-step undo transaction. MCP `extrude` accepts `startFace: {nodeId, faceIndex}` and captures its stable ProfileRef. Modeling skill text describes exact caps and boundary failures.

Validation covers a real cylindrical starting wall of radius 10 rebuilt to radius 12: curved caps, exact 80 mm³ tool volume, boundary vertex positions, preserved edge identities, undo, and a downstream fillet still resolving its captured edge. Other tests cover both depth directions, positive/negative offsets, to-object/through-all/symmetric endings, transformed external start faces, linked extrudeTarget timelines, complete and partial coverage failures, JSON program calls with upstream edits, create/edit selection/preview/undo, and all legacy fixtures. The new immutable fixture is `v2/parametric6-from-face.json`.

Cloud payload evidence: `featuresJson` remains the existing serialized string path under models.nodes. The new fixture is split with `splitManifest` into manifest/blobs, JSON-round-tripped, reassembled with `assembleManifest`, compared exactly with its original, and merged without conflicts. The atomic startFace merge declaration keeps its node and face together; independent depth/startOffset edits merge. No cloud envelope/blob encoding changes are needed.

Native artifacts were built sequentially in the shared Emscripten 5.0.7 / OCCT V8_0_1 cache after merging root 16a7b379, preserving #82 factory diagnostics and #103 mesher tolerance code. Only the approved #94 native binding was added to that source base.

Final checks: 490 tests across 17 focused files passed; aliased TypeScript typecheck and scoped `npm run check` passed. Biome reports existing advisory warnings/information, with no errors. Temporary alias configs ensured tests used this checkout rather than root workspace symlinks.
