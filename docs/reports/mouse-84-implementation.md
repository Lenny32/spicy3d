# Independent corner setback fillets (#84)

The implementation adds a genuine trimmed, tangent-constrained corner patch to a constant-radius
fillet. Three independent setbacks measure arc length away from the common selected-edge vertex;
they are not variable endpoint radii. The native source and all three kernel artifacts contain the
accepted corner, guided loft, face sweep, and tracked-copy bindings together.

## Controls and execution

Select exactly three incident edges on one parametric body and choose **SOLID → MODIFY → Corner
setbacks**. The modal edits the radius and three setback lengths independently, including length
expressions and project-unit literals. **Recompute preview** starts the strict geometry worker;
**Cancel recompute** terminates it. Confirm stays disabled until a successful preview. The preview
shows the edited step; confirmation replays and validates its remaining feature chain. Edit on a
saved setback fillet reopens this modal. A successful edit is one undo step; cancel/failure preserves
the committed payload and history. Closing during work waits for worker/rollback cleanup.

Preview is off-model and fits once. Confirmation checks the document revision, variable scope,
entire feature list, exact entering shape identity, and the continued presence of the host body,
then publishes that single-use prepared result through the ordinary feature cache. Tail replay
uses explicit document mutation authority across resumed synchronous callbacks. Unrelated writes
remain blocked during the owned transaction; rollback restores its exact records.

MCP uses `start_corner_setback_job`, `get_corner_setback_job`, and `cancel_corner_setback_job`.
Start names an existing fillet by actual `bodyId`/`featureId` and supplies three distances in its
persisted selected-edge order; optional expected edge refs reject stale repicks. Jobs use the
existing mutation FIFO, bind to caller/document, support session/recovery cancellation, retain
bounded results, and report cancellation only after cleanup. `run_parametric` remains synchronous;
use the dedicated jobs for setbacks.

## Geometry and compatibility limits

The first version supports one corner triplet matching exactly three selected edges, a constant
radius, three unambiguous original supporting faces, and regular incident curves/support normals.
Each distance must be positive, exceed the radius, and stay inside its edge. Missing/ambiguous
history, unsuitable connectors, invalid solids, excessive repaired tolerances, self-interference,
and inaccurate fits fail explicitly. Actual ancestry produces stable corner/strip/support IDs;
positional identities are not invented for untracked output.

The degree-14 single-plate construction keeps the 512-segment bound and existing 90-second worker
deadline. The accepted 40 mm cube, radius 2 mm, setbacks 2.49/2.50/2.51 mm takes roughly 60–64 seconds
on this host. Its independent CAD boundary distance is 6.4916e-7 mm and normal angle 8.4061e-4 rad;
OCCT reports ApproxError 6.2741e-5 mm and CriterionError 8.4049e-4 rad. All four finite/nonnegative
gates remain bounded by 1e-4 mm / 1e-3 rad. These engineering checks are not a global mathematical
certificate. See [native research](mouse-84-native-research.md) for the algorithm, measurements,
and rejected constructions. Curved supports were investigated, but the spherical-octant case
exceeded the worker budget and is not claimed as an accepted production case.

Approved parametric version 12 adds only optional `fillet.cornerSetbacks`; absent preserves prior
fillet behavior. The 11→12 migration is identity, refs and their distances merge atomically, and
a new immutable fixture captures actual upstream kernel IDs. The document envelope stays at
format 2. Device/cloud roundtrips preserve expressions and references.

Saved loading and headless merge validation rebuild corners asynchronously. AbortSignal reaches
pending work both while loading and while preparing rebuild status; private documents are disposed
after deserialization/worker cleanup. Current **kernel crash recovery refuses corner-setback
documents atomically** because its replay contract is synchronous. The existing committed tree,
payload, IDs, and undo/redo history remain unchanged on that refusal; no blocking synchronous fit
is substituted. Recovery of these documents needs a future asynchronous recovery staging design.

## Validation

- Six real native corner cases preserve BREP/display caches and verify geometry, sections,
  requested cylinder radii, four quality metrics, and actual derivation history.
- Chromium 153 and Firefox 155 worker proofs retain responsive page ticks during accepted fits;
  mid-native cancellation terminates one worker, clears handles, and allows fresh geometry.
- Real saved-fixture loading and merge validation rebuild the accepted corner successfully.
  The accepted model's synchronous recovery candidate rejects atomically with unchanged state.
- Controlled tests exercise low-count live scheduling, synchronous no-fallback errors, stale and
  detached hosts, independent expression inputs, single-fit confirm, one undo, no-op confirmation,
  tail-failure rollback, delayed close/rollback cleanup, and preview-render failure disposal.
- Dedicated published MCP proofs cover a real fit, exact undo/redo, queue/caller/document binding,
  cancellation/deadlines/session cleanup, stale selection, read-only refusal, and removed hosts.

Checks use the isolated checkout's aliases. Native all-three source/header inputs were compared
byte-for-byte with the installed artifact build inputs; TypeScript and scoped Biome checks pass.
