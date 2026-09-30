# Associative sweep (#88)

The approved parametric format 9 adds a sweep with one hole-free sketch section, an ordered path
reference, and optional solid/round-junction settings. Its pure 8→9 migration changes only the module
version; existing fixtures remain immutable. The new fixture is `v2/parametric9-sweep.json`.

The Sweep ribbon command picks a section then whole path edges in traversal order. Confirm ends the
path picker; creation produces one undo step. Editing previews options and can re-pick both inputs.
Confirm refuses an invalid preview, and Cancel preserves the stored feature and undo position.
MCP `run_parametric` exposes `sweep` and `editSweep` using section sketch/profile indexes and ordered
path topology indexes; captures persist references rather than those transient indexes.

The native PipeShell operation validates input and output topology and reports combined section and
spine ancestry, vertex origins and exact section boundaries. Semantic face/edge identities derive
from those origins and cap/seam/junction roles, without topology enumeration indexes. Expected missing
or incomplete ancestry returns an error. Runtime checks reject self intersections and bound expensive
path inspection (256 path pieces, 8192 inspected source edges, 256 output faces).

Tracked body paths resolve against their entering timeline when the source later consumes the swept
body. Cache dependencies use that entering shape and world placement, avoiding a cycle through the
source's final boolean shape. Sketch paths retain actual entity identity and follow length/curvature
edits. Source-local picks transform through source world placement and the host's inverse transform.

Untracked picks have an authored UUID in the existing `EdgeRef.edgeId` field, prefixed `path-ref:`.
This token identifies the authored logical pick; it does **not** supply native topology ancestry.
Matching strips that token before geometric lookup, accepts only an unambiguous surviving match,
and fails missing, ambiguous or incompatible edits. Arbitrary upstream reparameterization of such
untracked sources is not supported. Existing tracked/sketch IDs keep genuine source provenance.

The profile must be authored at the path start perpendicular to its initial tangent. Branching,
disconnected or repeated paths, holes and unavailable timeline states fail explicitly. PipeShell
uses its public corrected/Frenet frame and right or round transitions. These checks demonstrate the
implemented cases; they do not reproduce the unknown historical scan-specific sweep failure.

Regression coverage includes nonplanar multisegment paths, open shells, closed toroidal paths,
profile entity permutation/resizing, tracked path length and circle radius edits, downstream fillet
references, source consumption without cache loops, source/host placement, history-vector ownership,
interactive preview/cancel/re-pick/undo, MCP JSON and rollback, atomic reference merge and cloud/device
roundtrip. Native bindings and artifacts were rebuilt with the pinned Emscripten 5.0.7/OCCT V8_0_1
toolchain; generated JavaScript was byte-identical to its baseline.
