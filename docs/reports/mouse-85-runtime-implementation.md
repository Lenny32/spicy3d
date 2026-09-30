# #85 associative guided loft implementation

The approved optional `loft.guided` group binds a referenced open main spine and boundary curve.
Creation and editing retain the section sketches and authored placement. Both path pickers capture
whole-edge references, preview the exact native result, allow independent repicking, and commit as
one undo step. Invalid guided previews cannot confirm. Cancel preserves payload, history and visibility.
Guided construction supports C2 continuity only (the default). Guided ruled/C0/C1 combinations fail clearly. Unguided loft defaults and all existing continuity/ruled options remain unchanged.

The runtime resolves actual section entity ancestry and both paths in host coordinates, records
world placement and entering-timeline dependencies in cache keys, and writes refreshed logical
anchors back to the correct spine or boundary group. Native topology pairs and boundary channels
must be complete arrays with valid index ranges and parity. Missing or indistinguishable side origins
receive distinct fresh `untracked:` IDs, which propagate through exact adjacent-face edge incidence.
Known sides/caps and edges use actual provenance and native start/end boundary roles, never slots.

MCP supports `loft.guided` and `editLoft` inputs/options. Each path accepts exactly one of validated
whole-edge indexes or the JSON references returned by `edges`; persistent references are bound to
their source body. `editLoft guided:null` restores ordinary lofting. Invalid inputs roll back the call.

Validation: 118 tests across seven feature/UI/actual-MCP/ordinary-loft/program/schema suites pass;
local-alias TypeScript and scoped npm check pass. New cases prove genuine tracked upstream guide
and section edits preserve a downstream chamfer reference, malformed native history fails,
unknown topology stays ephemeral, and explicit host placement rebuilds use current coordinates.

Same-host projected guides now resolve against the host state entering the loft, including
source-aware refresh suppression and unchanged producer tree ownership. Fifty-three targeted
guided/path/sweep/face-sweep cases pass after this extension. Two spine references plus one
boundary reference remain separate after reanchoring; unique tracked edges refresh their geometry
while logical multi-piece spans retain their whole-span anchors. Section entity reordering preserves
semantic IDs. Unsupported or ambiguous native history fails explicitly.

Approved parametric format 13 registers the optional guided group with a pure 12→13 migration.
The entire spine/boundary pair is atomic for merges, with nested node/edge reference declarations
retaining integrity checks. Concurrent guide changes or clearing versus repicking conflict once;
independent solid options merge. A merge-introduced deleted guide source reports the complete
atomic pair as a dangling reference. Earlier immutable fixtures remain untouched; envelope 2 and
sketch 3 remain unchanged.

The new immutable v2/parametric13-guided-loft.json fixture loads both actual sketch guide paths,
rebuilds a 1200 mm³ solid and saves all models back unchanged. The compatibility test follows
the existing cloud payload path: models.nodes[].featuresJson becomes a content-addressed blob
through splitManifest, assembles exactly through assembleManifest, and survives encodeDocumentFile
/decodeDocumentFile with both guide anchors and opaque userData unchanged.

Final validation against the accepted combined corner/guided-loft/face-sweep/copy kernel:
149 tests across 12 affected suites pass, including all historical document fixtures, native complete
boundary coverage and input preservation, genuine downstream reference continuity, same-host
projected guide refresh without loops, UI preview/confirm/cancel/undo, actual MCP JSON references,
pure migrations, atomic merge behavior, cloud/device round trips and ordinary loft regressions.
Local-alias TypeScript, scoped npm check and git diff --check pass. The regenerated merge catalog
matches the registered rules. No additional native changes are required.

Initial boundaries are 2–16 single planar sections, one referenced open spine and one referenced
open frame-driving boundary, at most 128 pieces per path and 512 generated sides. Section placement,
unique ordered stations and full guide/section coverage are checked; unsupported or ambiguous
configurations fail explicitly. Outputs without proven unique ancestry remain ephemeral.
