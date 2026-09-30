# opt-08: opt-in hybrid geometry worker

## Enablement recommendation

**Keep hybrid evaluation opt-in during review.** Its responsiveness benefit is real, but its cold-load
time and main-memory costs are still material regressions. The default is the measured opt-07
main-thread scheduler, even when `Worker` exists. Enable the experimental capability at deployment startup:

```json
{ "performance": { "geometryWorker": true } }
```

This belongs in the existing `deployment.json`; no setting is stored in a model or localStorage. Only a
literal boolean `true` enables it, and a Worker implementation must be available. SDK callers can explicitly
override deployment selection with `new OccShapeProvider({ geometryWorker: true })` (or `false`). Reload
after changing deployment configuration. Installing the capability does not eagerly start a worker.

### Review-fix status and acceptance limits

The persistent-failure and profiling-gate fixes passed TypeScript and **111 targeted tests**. This is
ready for independent re-verification, not final signoff. The mesh/picking correspondence P1 has a separate
owner; this pass changes no picking maps or range construction. Earlier smoke assertions below do not
close that independent review issue. The performance observations below predate these review fixes;
there is no new elapsed-time or memory-win claim, and hybrid remains opt-in.

### Latest paired performance check

Both modes used **one isolated temporary application build**, Firefox 155.0, fresh browser contexts, the
same original model and unchanged source hashes before/after. Main mode used an empty deployment config
to test the real default; hybrid mode served the explicit opt-in above. All 83 sketches were exercised
in both modes, with zero unchanged-session booleans/cache misses and stable payloads and tracked ids.

| Measurement | Default main scheduler | Opt-in hybrid |
|---|---:|---:|
| Cold open | 45,709 ms | 98,816 ms |
| Maximum main event-loop gap | 5,055 ms | 1,305 ms |
| Native worker / main booleans | 0 / 83 | 83 / 0 |
| Main WASM capacity, cold | 268,435,456 B (256 MiB) | 658,833,408 B (628.3125 MiB) |
| Main WASM capacity, after 83 sessions | 268,435,456 B | 760,741,888 B (725.5 MiB) |
| Resident prefix reuse | — | 82 hits |

These are observations on a shared machine, not confidence intervals. The earlier ~100-second hybrid
result is essentially unchanged; **no material elapsed/memory improvement is claimed**. The cold capacity
is higher than the earlier 531 MiB observation: detached input snapshots now remain alive while awaiting
the worker. Capacity is not live allocation, and these numbers exclude the worker heap, JS and GPU memory.

The implementation does reduce repeated work: the worker imported/verified **84** new inputs rather than
166 (82 preceding outputs stayed native), main `take()` imports only the new output rather than parsing
the inputs again, and the bounded cache owns at most two native results. However, `replica.capture` still
took **17,335 ms**, worker replica export **14,315 ms**, and `replica.install` **19,671 ms**. Verification,
serialization and complete native replicas for retained prefixes still dominate the overhead. Dropping
verification is not an acceptable optimization; sharing prefix geometry or changing materialization needs
a broader ownership design. Recommendation to the orchestrator: leave the default off and offer this
only as the explicit responsiveness/memory tradeoff while that work is reviewed.

Evidence: `C:\Users\lcormi\AppData\Local\Temp\opencode\worker-performance-5182df2d-22ce-437e-b1c3-7b831194c1a1.json`.
Source SHA-256: `769747e6a3ddf252fe5d417b564cc1ad2b583b1107cf913d49eb89db8936a397`.
Build SHA-256: `0cb12633ae51961cd06b603c4c6233811f24f184831e2074de0f81924b84ce39`.
The complete ordered face/edge tracking-id hash is identical between modes:
`066b5c62cf70c5ef1a8d39b1c7f30d187991502ee2d66342bacc045e331fca2b`.

Final checks for this pass: TypeScript passed; the WASM suite plus hybrid/scheduler/rollback tests reported
**687 passing tests across 35 files** (the Windows runner again emitted a libuv shutdown assertion);
the production application Rspack build passed in a separate temporary directory with size warnings.
Focused tests explicitly cover mutation through a surface alias, rejected non-lease raw handles, bounded
residency, queued/late cancellation, source disposal and provider disposal of untaken input snapshots.

## Architecture and supported paths

The approved **hybrid replicas** path is integrated into the real application. `OccShapeProvider`
(already installed by `AppBuilder.useWasmOcc()`) supplies the optional core `IAsyncShapeFactory`
capability when explicitly enabled and browser `Worker` exists. The worker starts lazily on the first eligible operation.
It announces initialization before processing queued native requests. Browser loading errors before that
announcement allow synchronous fallback; transport failures after initialization retain native quarantine.
Parametric imports only core capability interfaces; it does not import WASM.

| Path | Execution |
|---|---|
| Scheduled large chains (12+ features): explicit fuse/cut/common | Tracked native boolean in worker |
| Scheduled sketch extrude or press-pull with join/cut/common | Profile/sweep/seed construction on main; final tracked combine in worker |
| Final supported feature's render mesh | Worker mesher; transferred typed arrays installed on local replicas |
| Curves, surfaces, topology queries, selection, serialization | Ordinary synchronous local OCCT replicas |
| Small chains, nested dependent evaluation, explicit synchronous programs | Existing synchronous path |
| `DocumentRebuilds.flush()`, synchronous serialization/export demands | For a healthy capability, cancel parked request and continue locally with completed prefix retained; a known native quarantine blocks synchronous booleans too |
| Revolve, fillet/chamfer, profile building, internal multi-profile fuses, other kernel operations | Synchronous, with the existing between-feature scheduler yields |
| No Worker, unavailable worker construction/bootstrap, unsupported inputs, rejected replica correspondence | Synchronous compatibility fallback; only compatibility unavailability disables the capability |
| Native worker rejection/trap, malformed response or unclassified transport failure | Persistent provider-wide quarantine: keep last-good geometry and fail later boolean rebuilds without falling back to main |

This is **not worker-only kernel ownership** and does not implement all-kernel offload from the literal
opt-08 ticket. The main thread retains the document, feature chain, timeline cache, tracking completion,
reference resolution and local geometry. The same kernel artifact runs independently in the worker.

## Rebuild correctness

- `FeatureHandler.prepareAsync` captures inputs in the current per-feature construction/timeline context.
  The capability synchronously makes owned, immutable native snapshots before returning, validating their
  topology against their source. Uncached inputs are exported once; those same local snapshots are handed
  to history completion, then disposed, instead of being destroyed and parsed back from BREP. Transformed
  tools and generated prisms are disposed immediately; no borrowed sketch face must survive an await.
- Input/output face and edge order is verified by `replicaTopology`: **independent direct-child graph
  traversal** assigns canonical topology identities, preserving shared vs coincident-but-distinct TShapes
  and located instances. `findSubShapes` must map to the same ordered identities/orientations. Graph
  adjacency, types and orientations compare exactly; world vertex positions, curve samples and face bounds
  compare within `1e-9 + 32*epsilon*scale` to permit analytic reconstruction roundoff. This validates
  correspondence, not just counts, and is not a replacement for BREP geometry. Copy/Read can bake vertex
  locations into coordinates; incidental placement representation is not compared as geometry.
- Snapshots strip tessellation on a **detached deep copy**, never on a live input. Whole-subshape BREP
  hashing was tried and rejected: duplicated curves/triangulations made it prohibitively expensive.
- All six history channels cross the boundary. The main thread completes history on owned immutable
  input replicas and applies captured tool/sketch seeds. Reference snapshots and feature keys are captured
  before waiting. No partial chain is committed: the old display/cache remains until the full replay wins.
- `RebuildJob` parks on an awaitable operation rather than polling. Before resumption it checks the existing
  body/document revision guard. Cancellation returns the generator, discarding only its uncommitted entries.
  Output imports happen **only in `take()` after the guard**. Cancellation disposes frozen local inputs and
  releases any accepted-but-untaken native output; a completed task retains no input snapshots.
- Synchronous takeover cancels the operation and resumes the **same** generator at that feature. It does
  not discard or re-evaluate the completed prefix. Subsequent misses in that replay also run synchronously.
  `flush()` never spins on RPC. The ordered-program scope remains synchronous; ordinary save/settled paths
  await the worker. MCP save kind/label behavior is unchanged.
- Native failure is latched **on receipt**, even for a late result whose caller cancelled or a result never
  taken by the feature. The failed capability stays installed (`available` is not set false), and later
  requests return a failed operation with `canFallback: false`. An unused-variable edit, repeated rollback
  restoration, or `dispose()` cannot erase the latch. Main factory boolean entry points also consult the
  failure, so explicit synchronous demands cannot repeat an already-known rejected/trapped operation.
  This conservative quarantine applies to all booleans through that provider until a fresh provider/page
  is deliberately created. It is not saved in the document. Healthy in-flight synchronous takeover remains
  a separate compatibility policy: it cannot predict a failure the worker has not reported yet.

## Meshes, ownership and failures

- Worker-local handles have a random session prefix and monotonic ids. Newly created handles remain
  host-owned until accepted. Queued cancellation gets a terminal acknowledgement; cancellation after
  native completion frees unaccepted outputs. Cancellation cannot interrupt one native call.
- The integrated `booleanReplica` operation can mint an **unmeshed, single-use result lease**. The next
  operation consumes that verified native result without another prefix export/import. OCCT may mutate
  operands, so a consumed lease is never reused again. Queued cancellation also releases the transferred
  input lease, even if native execution never starts. Ordinary raw handles are not accepted as leases.
- `HybridShapeFactory` bounds unused leases to **two entries**. Each is keyed by the local shape object
  and an exact BREP version; location, tolerance, orientation and edge-update hooks eagerly invalidate,
  while the exact version check also catches raw native/geometry-alias mutations. Eviction and explicit
  shape/cache disposal unsubscribe and release immediately. This never relies on weak references or GC.
  The provider also owns pending operations and cancels their local snapshots on disposal. Accepted and
  late-cancelled replies have explicit release paths. Meshed final outputs are not retained as leases.
- Local input snapshots remain deep, immutable copies. Every copied input and every returned output still
  passes topology correspondence verification; resident reuse does not bypass output validation. The
  lower-level shell API supports explicit `release` and `dispose`; termination releases the worker heap.
- `ShapeResult.shape` is borrowed. An owned `TopoDS` value is retained before deleting the result.
  Generated TopoDS casts also move from their argument: traversal now keeps the typed replacement as its
  graph node instead of creating another location/value copy for every leaf. Only the caller's borrowed
  root needs a value copy. Vertex geometry is still checked; a vertex is a leaf by definition.
- Native scopes mark a `WebAssembly.RuntimeError` **before any enclosing native cleanup runs**. A trapped
  heap is never queried/deleted again; the client terminates it. Malformed response envelopes (including
  null, unknown type, missing result and invalid telemetry), transport failures and fatal messages settle
  all pending callers. Unknown native failure text is not logged with document content.
  `canFallback` distinguishes compatibility failures from persistent native failures; explicit synchronous
  takeover remains available for a healthy capability, but never bypasses a known native failure.
- Mesh positions, normals, UVs, indices, edge positions, group pairs and topology-index maps transfer as
  freshly allocated JS buffers. Embind's current array API requires one conversion out of native storage;
  the transfer does not copy those buffers again and never detaches the WASM heap.
- Mesher order can differ from topology order or omit an unmeshed face. Explicit maps bind pick ranges to
  **local** face/edge replicas; separate mesh indices select their buffer slices. Only the final supported
  result is eagerly meshed. A cached intermediate replica meshed during rollback retains its JS buffers
  and local pick ranges but clears native tessellation afterward, avoiding a second retained mesh cache
  for each complete prefix replica. Analytic geometry is unchanged.

## Initialization, security and profiling

`worker.ts` imports the generated module directly, without core/UI barrels, document globals, storage or
plugins. Worker/WASM URLs are bundler-owned and same-origin. Existing deployment CSP works unchanged.
There are no caller-selected executable URLs, shared-memory waits, new explicit network calls or storage keys.

The checked-in `-sENVIRONMENT=web` optimized glue actually initializes successfully in dedicated Chromium
and Firefox workers through `import.meta.url`/`fetch`. No shim, injected binary, CMake edit or generated
artifact change was needed. `cpp/build` dependencies are absent here. Keep the browser test when upgrading
Emscripten; future glue may require an explicit `web,worker` build.

`globalThis.Spicy3DWorkerProfile` exposes `snapshot()`, `settled()` and `reset()` for the profiling harness.
**Profiling is opt-in per request:** the client stamps the current `PerformanceTrace.captureId` only while
tracing is enabled. The worker keeps that choice for the entire queued/running request. Without it, the
worker reads no profiling clock, creates no timing-event array/records, and omits `nativeMs`. It still
performs all geometry/ownership/verification work. No core/UI tracing module is imported into the worker.

Counters are cumulative **profiled-work totals**, not uninstrumented lifetime workload totals. They count
actual traced boolean/history/mesh/buffer invocations, including cancelled-but-executed work. Enable/disable
of `PerformanceTrace` and worker restarts do not reset them. `settled()` sends FIFO barriers and waits for
cancelled-but-executing work and its terminal accounting, not just caller promises. Drain before enabling
a new capture, and keep tracing enabled through the final drain and snapshot.

The client retains the request's capture token until terminal delivery even after caller cancellation.
Events are forwarded before resolving the result and only into that same capture. A late event arriving
after disable or into a newer capture still increments the profiled counters, but is not misattributed:
`dropped` increases and `telemetryComplete` becomes false. Fatal loss of traced work also makes the epoch
incomplete. A recoverable reply-send failure forwards the already-collected native events with the error
reply instead of losing them. `reset()` succeeds only with tracing disabled and **all** native requests drained; it zeros
the counters/loss state and changes the epoch. A reset during active capture or pending native work returns
false without changing anything. Reload also creates a new epoch. Telemetry reset does not clear a
geometry-failure quarantine.

Exact source spans now distinguish `replica.copy` (deep copy, clean and local wrapper),
`replica.export.input/version/retain` (the individual native BREP writes), `replica.verify.source`
(source descriptor), `replica.verify.copy/output` (descriptor plus correspondence comparison), and
`replica.import` (native BREP read plus local wrapper). They are nested in capture/install spans, so must
not be added to those inclusive totals. Worker replica stages remain distinct from native booleans and
history conversion, and `worker.rpc` is latency, not native execution time. All source hooks gate clock
reads and timing metadata on tracing being enabled.

## Earlier integration evidence (before bounded leases / opt-in gating)

Real application smoke (Firefox 155.0, actual web entry plus a test probe, deployment CSP):

- **84-feature Mouse Bottom: 83 worker native booleans, zero main-thread booleans.**
- A browser click was handled during the first operation; 4,650 animation-frame callbacks during load.
- Longest worker native boolean: **5,327 ms**. Complete open: **120,218 ms** on this shared machine.
- Final **ordered topology graph** matches the pristine baseline; 1,232 faces / 3,448 edges / 2,255 vertices;
  exact bounds; volume **22,330.46097003607 mm³** (baseline 22,330.460970036078).
- Full feature JSON, every sketch payload and visibility match the pristine baseline. Local mesh pick
  ranges match their indexed native subshapes. Original benchmark SHA-256 remains
  `9049df8e40f1c0c98f0fbc70124762e67e48548bb1b10e9c3fee529c4e784569`.

A separate read-only profiling run (`worker-integration-graph-tolerance.json`, in the approved temporary
directory) recorded **112,572 ms** cold open, **1,362 ms** maximum main event-loop gap, 83/0 worker/main
booleans, complete realm telemetry and zero booleans/cache misses for the three named unchanged sketches.
It also found zero application errors/write attempts and unchanged hidden-geometry deferral.

The all-sketch full-build run, `worker-integrated-all-sketches.json` in that same temporary directory, exercised
**all 83 sketches** plus the three named sessions: **86 unchanged entry/exit sessions**, every one with zero
booleans, zero cache misses and stable feature/sketch/visibility payloads. Cold open: **99,830 ms**, maximum
main-loop gap **1,298 ms**, longest worker boolean **4,749 ms**, 83/0 worker/main booleans. Main WASM capacity
rose to **766,771,200 bytes** in the first three sessions and stayed there through all 83 sketches after
transient triangulation cleanup. This is capacity, not a live-allocation leak measurement. The full build
passed with size warnings; the affected 128-file suite passed **2,169 tests** (the optional saved-model
test skipped there and passed separately). The Windows runner emitted libuv shutdown assertions despite
reporting no failed tests; native/browser checks also passed independently.
After additional fail-closed fallback hardening, the 73-test worker/replica/hybrid/scheduler subset,
TypeScript and a fresh complete application/plugin build passed again.

**Tradeoffs remain measurable:** opt-07 opened in ~44 seconds, so this correctness-first per-feature
replica implementation improves responsiveness but regresses total elapsed time and uses more memory.
Main WASM capacity reached 556,793,856 bytes on that cold run (worker capacity is not included). That run
preceded transient rollback triangulation cleanup; its later capacity growth is not a leak-freedom claim.
The next performance work is reducing repeated graph/snapshot conversion and sharing immutable native
geometry between retained prefix replicas. Do not report an elapsed-time or memory win.

Raw/cleaned BREP bytes differ from pristine because of copy/read representation and floating round trips.
Ordered topology/geometry anchors, bounds, volume and model payload checks pass; the old byte-identical
BREP acceptance criterion is **not** claimed. Within the worker run, cold/post-sketch-cycle BREP is stable.

## Run checks

```powershell
npx tsc --noEmit --pretty false
npx rstest packages/wasm/test packages/parametric/test --pool.maxWorkers 4 --pool.minWorkers 1
node packages/wasm/test/browser/run-worker-smoke.mjs "C:\Users\lcormi\AppData\Local\Temp\opencode"
node packages/wasm/test/browser/run-app-worker-smoke.mjs "tickets/optimization/Mouse Bottom.spicy" "docs/performance/before-firefox-final.json.gz" "C:\Users\lcormi\AppData\Local\Temp\opencode"
npm run build
```

For a paired comparison from one private build, append `both all-sketches` to the application smoke
command. It serves the opt-in deployment setting only for the hybrid context, checks source/build/model
hashes, compares complete tracked-id hashes between modes, and writes a new evidence JSON to the supplied
temporary parent. The shared profiling harness's expected kernel mode is not an enablement switch:
serve `performance.geometryWorker: true` **before application startup** when requesting hybrid evidence.
Its scripts and shared documentation were not changed by this performance pass.

Tests cover native geometry/history equivalence, reordered-topology rejection, local picking and buffer
transfer, native traps/malformed replies, cancellation races, atomic stale rejection, transformed/borrowed
input lifetime, retained-prefix takeover, rollback, edited suffix + undo, all extrusion tracking ids against
a synchronous chain, MCP save barriers and synchronous serialization. The optional
`hybridSavedModel.kernel.test.ts` uses `SPICY3D_BENCHMARK_MODEL` read-only; the browser smoke always verifies
the original file hash. No saved format or benchmark file is changed.
