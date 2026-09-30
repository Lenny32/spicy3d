# #85 guided loft proposal

This is a proposal for root review, not an approved saved-format implementation. Native
experiments remain isolated in `mouse/85-guided-loft`; no version is registered here.

## Accepted native feasibility

Pinned OCCT V8_0_1 public `BRepOffsetAPI_MakePipeShell.SetMode(auxiliary, false,
BRepFill_NoContact)` retains every requested section. Its guide-driven trihedron can control
twist without the broken automatic homothety of ContactOnBorder. A straight central spine,
rectangular sections at z=0 and z=20 rotated through 90 degrees, and a corner-radius quarter
helix produce a valid solid different from the ordinary loft. The native acceptance check cuts
every complete requested section and the complete auxiliary curve against the compound of
generated SIDE faces. Residual curve length must not exceed 1e-5 mm; containment inside the
solid and finite point sampling are insufficient.

The same proof preserves a third section at z=10 rotated through 45 degrees, rejects an
interior radius-2 guide, and rejects a translated intermediate section incompatible with the
guide. The accepted two-section case takes approximately one second. Opposite auxiliary wire
orientation also succeeds, with the same full-coverage checks; OCCT resolves correspondence
geometrically. NoContact is an internal solver mode, not a statement about boundary contact.

Continuity evidence is in pinned `BRepFill_PipeShell.cxx:765-783`: construction explicitly asks
`GeomAbs_C2`, unless a discrete trihedron was chosen. This proof uses the auxiliary-guide mode,
not a discrete trihedron, and calls `SetForceApproxC1(false)`. The public MakePipeShell API has
no `SetContinuity`. Initial guided mode therefore supports absent/default or explicit c2 only;
guided c0, c1 and ruled requests return explicit unsupported-option errors. Unguided lofts
retain all existing c0/c1/c2, ruled and solid behavior exactly. This is longitudinal surface
construction continuity, not a promise that polygonal section corners become smooth seams.

## Proposed additive saved shape

Extend existing `LoftFeatureData` with one optional atomic group:

```ts
guided?: {
    spine: { nodeId: string; edges: EdgeRef[] };
    boundary: { nodeId: string; edges: EdgeRef[] };
}
```

Absent `guided` keeps the existing operation. Both paths reuse existing anchored EdgeRef
shapes and #88's shared ordered path resolver. The main spine is explicitly referenced rather
than inferred from profile centers; the author can place it independently. `boundary` is one
whole connected guide required to lie on the output side boundary, and genuinely drives the
frame/twist. Do not advertise passive additional boundary validation as additional shape
control. Initial limits: 2-16 single hole-free planar sections, two open connected paths of
1-128 native edge pieces each, and at most 512 generated side faces. A future multi-guide
solver requires separate feasibility and approval.

Sections and paths resolve in the loft host's coordinates, preserving authored placement.
Require one unambiguous monotonic main-spine intersection with every section plane, spanning
the first and last section. Require the boundary to meet each complete section boundary at
the corresponding station. Missing, ambiguous, crossing, disconnected, interior, incompatible
or over-budget inputs fail clearly; never drop or replace a section to obtain a result.
No section scaling/translation is invented. Existing profile selection remains associative.

## Runtime, identity and authoring

Add `loftGuidedTracked` to the core factory interface, wasm wrapper and guarded native binding;
the product API exposes only the accepted NoContact construction and validates its limits.
No experimental mode parameter is exposed. Return genuine Generated ancestry for section
edges/vertices where OCCT reports it. Give guide-derived associations semantic IDs based on
actual input identity and feature provenance only when native history or exact full boundary
overlap proves the association; no fabricated Generated guide history. Reuse existing loft
tracking and explicit feature-scoped fallbacks for outputs without proven ancestry.

Reuse path timeline dependencies, pre-consumption cache keys and reanchor channels for both
paths. A single atomic guided group binds spine and boundary choices coherently. Creation and
editing add spine/boundary pick-and-repick controls, exact preview, clear unsupported-option
feedback, and one-step confirmation/undo; cancel leaves committed data unchanged. MCP loft
accepts the same optional group with persistent edge references or captured index selections,
validates every index before capture and supports upstream edits across calls.

## Approval and ownership requested

Propose parametric 13 after faceSweep 11 and corner-setback 12, a pure 12-to-13 identity
migration, the optional atomic guided loft merge field, a NEW immutable document fixture,
reference deletion/conflict tests, all older fixture rebuilds and `.spicy`/cloud manifest/blob
roundtrips. Root owns recording approval before saved writes and coordinates version-order
integration. This agent owns loft-specific feature/editor/program/MCP hunks, core/wasm guided
factory hunks and native guide construction, dedicated tests and documentation. Preserve
shared path-helper ownership and all #88/#89/#90 factories when rebasing; rebuild artifacts
only in a serialized native slot from the combined committed source baseline.
