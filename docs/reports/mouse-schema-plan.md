# Mouse project schema coordination

The boss approval in [mouse-plan.md](../../mouse-plan.md) permits necessary backward-compatible
payload changes for #81–#106. Existing fixtures and unknown-node/userData content remain unchanged.
After the approval reviewer rejected file-based authorization, the user directly confirmed
"Approve the plan’s backward-compatible format changes" in response to the explicit approval
question covering #81–106 and the sketch-3 proposal below. No further approval is needed within
that scope; unrelated format redesign remains outside the authorization.
The document envelope stays at version 2. Parametric remains version 5 until a separate feature
payload design is approved and assigned here.

## #93: control-point and weighted sketch B-splines

Approved owning module version: **sketch 3**, from sketch 2. Worker: `mouse_86`, in the isolated
`mouse/93-control-nurbs` branch. This is the only authorized sketch payload change in this wave.

Add optional `SketchEntityData.control` for existing `type: "bspline"` entities:

```ts
control?: {
    degree: number;
    knots: number[];
    multiplicities: number[];
    weights?: number[];
};
```

When present, the existing `params` coordinate vector holds UV control poles. The existing
`periodic` flag retains its meaning. Absent `control` preserves fit-point behavior and all existing
defaults. Control mode rejects simultaneous fit parametrization. Omitted weights mean unit weights.
Control mode must preserve entity ids while editing poles, weights, degree and knots.

Initial open control curves require clamped endpoint multiplicities, keeping existing endpoint and
end-tangent point references honest. Periodic control curves support the existing uniform,
multiplicity-one periodic layout initially; unsupported custom periodic layouts receive a clear
validation error. These restrictions must be explicit in the UI, MCP schema and documentation.
No rational approximation is silently substituted on older kernels lacking the B-spline binding.

The sketch 2→3 migration is pure identity: every earlier sketch remains valid without data rewrite.
The existing atomic entity `params` merge rule remains; the new `control` definition is atomic as
one coherent layout, preserving unknown fields through existing merge behavior. Geometry validation
must identify incompatible merged layout/pole combinations as rebuild failures.

Root assigns `mouse_86` ownership of the sketch-only version/migration registration in
`parametric/src/migrations.ts`, the sketch entity rule in `parametric/src/mergeRules.ts`, a NEW
`core/test/fixtures/documents/v2/sketch3-control-nurbs.json` fixture and affected current-version
assertions. Existing fixtures are immutable. No other worker may edit those sections in this wave.

Required validation: old documents/fit splines, rational known geometry, solver constraints and
editing/picking previews, native parity, persistence/undo, pure migration, merge rules and conflict
fixtures, document compare/history/restore/cloud-compatible payload paths. Older application
releases need not read the newly saved sketch-3 payload.

## Reserved later feature payloads

#83/#84, #85, #88/#89/#90 and #95 remain pending kernel feasibility and concrete design.
No worker may bump parametric versions or introduce these fields independently. Assign consecutive
versions and serialize migration/rule ownership after each payload design is reviewed.

## #94: associative extrusion starting face

Approved owning module version: **parametric 6**, from parametric 5. Worker: `mouse_86`.
Add optional `startFace?: { nodeId?: string; face: ProfileRef }` to the extrusion payload.
Absent `startFace` preserves existing extrusion behavior. Reuse `startOffset` as an axial offset
of the selected starting surface. For distance extent, depth separates the starting surface and
its translated copy along the extrusion axis; the cap remains exact curved geometry.

Resolve and re-anchor the face using the existing extent timeline rules, and include it in
dependencies, cache keys and previews. Ambiguous intersections or incomplete coverage fail
explicitly. A witness may select a split cell but must not approximate the cap. Preserve existing
profile-origin history and end-cap tracking, including stable curved starting edges.

The pure parametric 5→6 migration is identity. Add an atomic startFace merge field and a NEW
fixture; existing fixtures remain immutable. The worker owns only this version/migration step
and corresponding extrusion rule. Other payload versions remain unassigned.

Required proof includes a cylinder-wall boss with nonplanar starting cap, upstream radius edits,
downstream references, transformed/linked/external timelines, both directions and offsets,
invalid/ambiguous targets, expressions, old fixtures, merge and UI undo. Serialize native artifact
builds with #82 and #103 so each committed binary matches all committed C++ sources.

## #83: editable variable-radius fillet law

Reserved owning module version: **parametric 7**, following #94's parametric 6. Worker: `mouse_101`.
Add optional `radiusLaw: { position: number; radius: ParameterValue }[]` to the fillet payload.
Absent law retains the existing constant radius. Positions are strictly increasing normalized
arc lengths, starting at 0 and ending at 1, in each selected edge's natural curve direction.
Resolve expressions to positive finite radii, bound the knot count and validate native results.
OCCT smooth interpolation is explicit; do not describe it as piecewise linear.

Initially reject multiple selected edges sharing one tangent contour and unequal endpoint radii
on closed contours, preventing OCCT's order-dependent junction overwrite or silent endpoint
adjustment. Map reversed OCCT contour orientation consistently. Persistent EdgeRefs keep edge
identity, but reversing an upstream curve's natural parameterization may reverse a nonconstant
law; this limitation must be documented and tested without claiming a world-space direction anchor.

The pure parametric 6→7 migration is identity. Treat radiusLaw as one atomic merge field and add a
NEW fixture. Worker may implement native/runtime/feature/UI/MCP code now, but must wait for #94's
committed version-6 registration before editing version/migration/rule/fixture sections.
Serialize native artifact builds after #94 and retain all earlier committed C++ sources.

## #95: automatic next-face extrusion extent

Reserved owning module version: **parametric 8**, following #83's parametric 7. Worker: `mouse_86`.
Add an extent/secondExtent union variant `{ type: "next"; nodeIds: string[]; offset?: ParameterValue }`.
Capture eligible existing candidate body IDs automatically at authoring time, with host input
implicit. Freeze that candidate universe to prevent future downstream bodies introducing cycles;
editing may explicitly refresh candidates. Resolve each referenced body's appropriate timeline
state and recompute the nearest valid face on every rebuild. Missing candidates fail explicitly.

Choose the uniformly nearest complete trimmed surface by exact tool containment, not a center
sample or face index. Crossing or tied minima and incomplete coverage report useful ambiguity.
Initial scope requires one full-coverage face per profile; piecewise caps are unsupported explicitly.
Choose the unoffset target first, then apply the axial offset and rebuild. Do not reverse a
one-sided search automatically; depth sign chooses direction and symmetric sides search separately.
Enforce bounded candidate/face/tool inspection with clear limit errors and geometric pruning.

The pure parametric 7→8 migration is identity; the next variant is atomic with node references and
its offset expression declared. Add a NEW immutable fixture. Migration/rule/version edits wait
for #83's committed version-7 step. Native builds follow #83 and preserve all earlier sources.
Required proof covers moving/curved candidates, full and partial coverage, thin curved walls,
ties/crossing order, offsets, both signs/symmetric, #94 starts, transformed/linked timelines,
UI/MCP edits/undo, old fixtures, atomic merge and cloud payload round trips.

## #98 runtime recovery boundary

The user directly approved "Allow undo/redo reset during recovery" in response to the explicit
question about preserving committed edits, document IDs and feature references while clearing
native-bearing undo records. This permits an undo reset only after successful reconstruction.
Failed preparation must retain the original live state. Runtime generation/checkpoint/recovery
infrastructure must not change any saved payload, envelope or module version.

## #88: associative sweep profile and 3D path

Reserved owning module version: **parametric 9**, following #95's parametric 8.
Add a new feature variant `{ type: "sweep"; section: LoftSection;
path: { nodeId: string; edges: EdgeRef[] }; solid?: boolean; roundCorner?: boolean }`,
alongside the existing feature identity/name fields. Reuse the sketch profile reference and
existing stable edge references. The path is an ordered connected chain of whole edges,
resolved in the appropriate source timeline and transformed into the host body's coordinates.
Reject disconnected, ambiguous or missing inputs without a stored geometry fallback. Defaults
are solid and existing right-corner behavior. Initially accept one hole-free section; report
unsupported holes clearly. Existing features and saved fields retain their behavior.

Reuse OCCT's existing pipe-shell sweep and add runtime native history channels for both section
and path ancestry. Derive output identities from their combined stable source identities,
including distinct caps and seam/junction edges; enumeration indexes must not masquerade as
stable references. Require native validity and self-intersection checks with useful failures.
Profile/path changes must invalidate dependencies and preserve references where topology remains
compatible. Creation and editing support preview, cancel and one-step undo through UI and MCP.

The pure parametric 8→9 migration is identity. Treat section and path as atomic reference fields
and declare their node dependencies. Add a NEW immutable fixture with cloud roundtrip/merge,
old-document compatibility, transformed/timeline inputs, multi-segment 3D and curved paths,
closed paths, cap/seam identities, upstream changes and downstream fillet references tested.
Version/migration/rule/fixture edits wait for #95's committed version-8 registration. Native
artifact builds must preserve all previously integrated native sources and use the shared slot.

## #89: associative directional curve projection

Reserved owning module version: **parametric 10**, following #88's parametric 9. Worker: `mouse_86`.
Add `{ type: "projection"; source: { nodeId: string; edges: EdgeRef[] };
target: { nodeId: string; face: ProfileRef }; direction: XYZLike }` alongside existing feature
identity/name fields. The fixed saved direction is in world coordinates, finite and nonzero;
convert it consistently when evaluating in host coordinates. Source is an ordered connected
whole-edge chain, resolved with the shared sweep path resolver. Source/target edits resolve
their correct timeline states, transforms, dependencies and re-anchored stable references.

Project onto exactly one trimmed face along positive rays. Behind, disjoint, partial, folded
or multiple forward branches fail explicitly. Prove full transverse source-curve coverage with
exact curve intersections and lengths; endpoint samples do not establish coverage. Existing
native projection and boolean operations may be reused without new bindings. Output identities
combine actual stable source and target ancestry with node/feature provenance, never source
array slots or invented kernel history. Honest split pieces may share a logical source identity
and use the existing span/anchor machinery. Output is a curve/wire for later sweep or face-rib use.

The pure parametric 9→10 migration is identity; source and target are atomic reference fields.
Add a NEW immutable fixture and cloud roundtrip/merge, old-document, missing/ambiguous input,
oblique direction, trimmed-hole coverage, upstream source/target edits and UI/MCP undo tests.
Version/migration/rule/fixture edits wait for #88's committed version-9 registration.

## #90: associative face-supported groove or rib

Reserved owning module version: **parametric 11**, following #89's parametric 10. Worker: `mouse_81`.
Add `{ type: "faceSweep"; section: LoftSection; path: { nodeId: string; edges: EdgeRef[] };
support: { nodeId: string; face: ProfileRef }; operation: "join" | "cut";
roundCorner?: boolean }` alongside existing feature identity/name fields. The entering host shape
is the boolean operand. Resolve the section, ordered whole-edge path and exactly one trimmed
support face in their correct timelines and host coordinates. Preserve authored section placement.

Require complete exact path coverage on the selected trimmed face and a genuine support-normal
sweep frame. Any native p-curves needed by that frame must describe the actual referenced curve;
sampled normals or an ordinary unsupported sweep do not establish this behavior. Require a valid
swept solid and an attaching/intersecting tracked join or cut. Missing, ambiguous, off-face,
detached or incompatible inputs fail clearly. Preserve combined section/path/support ancestry
through the boolean result, and rebuild after any referenced geometry changes.

The pure parametric 10→11 migration is identity. Section, path and support are atomic reference
fields with declared node dependencies. Add a NEW immutable fixture, old-document and cloud
roundtrip/merge tests, curved-wall join/cut and upstream-edit proofs, transformed/timeline inputs,
downstream references, UI/MCP editing, cancel and one-step undo. Version/migration/rule/fixture
registration waits for #89's committed version-10 step. Native feasibility may proceed earlier
after the sweep implementation, using the shared serialized build slot. #84 and #85 versions
remain unassigned until their geometry and concrete payload designs pass review.

## #84: independent fillet corner setbacks

Reserved owning module version: **parametric 12**, following #90's parametric 11. Worker: `mouse_101`.
Add optional `FilletFeatureData.cornerSetbacks` as a list of
`{ edges: [EdgeRef, EdgeRef, EdgeRef]; distances: [ParameterValue, ParameterValue, ParameterValue] }`.
Initially require exactly one triplet matching the feature's three selected edges, one unambiguous
eligible trihedral corner and a constant radius; reject combination with `radiusLaw` explicitly.
Absent setbacks preserve existing fillet behavior. Distances are independently editable expressions
in millimetres, finite and positive, larger than the radius and shorter than each selected arc length.

The accepted native feasibility construction trims actual rolling strips and support surfaces,
fits a bounded tangent-constrained plate, repairs parameter consistency, sews and validates the
result. Require the unchanged 0.0001 mm boundary/tolerance limit and 0.001 rad tangent limit,
valid closed BREP, no self-interference, positive reduced volume, retained constant-radius strips
and unchanged input geometry/display cache. Finite independent boundary checks are not a global
mathematical certificate. Unsupported or failed fits return specific errors. The faster experimental
quadrilateral construction has not met the tangent limit and is not approved for production.

Native tracking must compose actual copy, fillet, trimming and sewing ancestry: retained supports,
rolling strips, the new corner cap and connector/section edges keep their actual contributing
input face/edge provenance. Do not manufacture history through positional or nearest-geometry IDs.
Use a dedicated tracked worker operation for expensive live solves, retaining the existing
**90-second** deadline, generation termination for cancel/timeout and no main-thread fallback.
Handle synchronous shape reads and configuration flushes explicitly so they cannot invoke the
expensive solver on the live main thread. Preview uses explicit recompute/confirm/cancel rather
than continuous dragging. Explicit synchronous native proof/headless evaluation remains possible.

The pure parametric 11→12 migration is identity. Setback picks and distances form one atomic
coherent payload, with declared expression dependencies. Add a NEW immutable fixture, old-document
and cloud roundtrip/merge tests, independent-distance geometry and actual history proofs,
scalar/expression UI/MCP editing, rollback, cancel and one-step undo. Version/migration/rule/fixture
registration waits for #90's committed version-11 step. Runtime/native implementation may proceed
under the serialized native build slot. #85's owning version remains unassigned.
