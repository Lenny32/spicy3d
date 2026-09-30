# KERNEL-01: Geometry kernel and model evaluation in a Web Worker

## Summary

Run the OCCT kernel, and with it the evaluation of the document model, in a dedicated Web Worker.
The main thread keeps the UI, the viewport and the meshes. A kernel call that hangs or runs out of
memory can then be ended with `worker.terminate()` and the kernel re-created, without reloading the
tab and without losing the open document. This is a design ticket: it fixes the architecture and the
phasing, and each phase gets its own implementation ticket. The current runtime is described in
[docs/kernel.md](../docs/kernel.md).

## Motivation

An MCP agent modelling a lofted part called `makeThickSolidByJoin {joinType: "intersection",
thickness: -3.75, mode: "skin"}` on a 61-face G2 shell. The call never returned. OCCT's intersection
join intersects the offset faces pairwise, and on many narrow faces it may not terminate. Because the
kernel runs synchronously on the main thread:

- the relay timed out after 120 s, and every later tool call timed out too, `get_document_state`
  included, because the page's single `SerialQueue` was blocked and so was the WebSocket;
- the UI froze, and Firefox finally crashed, which is consistent with memory growing to the 4 GB
  `-sMAXIMUM_MEMORY` cap;
- the call could not be cancelled. JavaScript cannot preempt synchronous code, and the MCP
  `notifications/cancelled` is only read once the call returns.

Current mitigations, delivered with this ticket's issue, reduce the risk without solving it: a
face-count guard on the intersection join, cancellation between the ops of a program, a slow-op
warning, and the dead-kernel state for aborts. Only a separate thread can bound a call that never
ends.

## Constraints

- **Synchronous handles everywhere.** `IShape`, `IFace` and `IEdge` are live embind objects used
  synchronously across `app` (bodies, commands, selection steps), `parametric` (feature handlers,
  sketch profiles, stable ids from kernel history), `three` (meshes, highlighter), `ai` (run_program
  queries) and `core` (`ShapeNode.shape: Result<IShape>`). Every `IShapeFactory` method returns a
  `Result` synchronously (see CLAUDE.md, the Result pattern).
- **Embind objects are not transferable.** A `TopoDS_Shape` lives in the worker's WASM heap. The
  main thread can only hold an opaque id, BREP text, or mesh buffers. Mesh `Float32Array`s and
  `Uint32Array`s can be transferred without a copy.
- **Headless document as the worker-side model.** `Document.loadHeadless` + `NullVisual` (used by
  `HeadlessDocumentEvaluator` for `validateMerge`) already loads and rebuilds a document without a
  viewport. It still takes an `IApplication`. The worker needs a minimal application without DOM
  (no `window`, no `document`, no IndexedDB services, no UI).
- **Build.** `-sENVIRONMENT=web` must become `web,worker`. No pthreads are needed, so there is no
  `SharedArrayBuffer`, and COOP/COEP headers are not needed. The CSP already allows workers
  (`worker-src 'self' blob:`, docs/security.md and `docker/default.conf.template`). The worker is a
  module worker from the same origin, bundled by Rspack.
- **Re-init cost.** A new module means reloading the WASM (about 10 MB, from the HTTP cache) and rebuilding the
  document's shapes from the serialized model. It is seconds, not milliseconds: that is fine for a
  cancel, too slow for normal use.
- **The save format does not change.** The worker loads the same serialized document.

## Candidate architectures

### A. Whole document model in the worker (recommended)

The worker owns the authoritative evaluated document: nodes, parametric bodies, shapes and kernel
history. The main thread keeps a mirror of the node tree (ids, names, properties, visibility,
transforms), and receives one mesh per node (faces, edges, and the face/edge index ranges used for
picking) plus metadata (bounding box, sub-shape counts).

- Commands and MCP tools send intents ("run these ops", "set this property") and await a reply.
  Their public APIs are already async (`ICommand.execute`, tool handlers).
- Picking returns `(nodeId, subShapeType, index)`. Queries on a picked face (area, normal, curvature)
  become worker requests.
- Undo/redo: the history lives in the worker, and the main thread mirrors its position for
  `isDirty`.
- Cancel = `terminate()`, then a new worker loads the last committed serialized state, and the main
  thread keeps its mirror and meshes meanwhile, read-only. The rolled-back call answers
  `cancelled`.

Cost: large. Every synchronous shape use in `app`, `three`, `ui`, `parametric` commands and in the
inspect tools becomes a message. It can be done by layers, see Phasing.

### B. Kernel proxy with an async `ShapeFactory`

Keep the model on the main thread and forward each factory call to the worker. Every
`IShapeFactory` / `IShape` method then returns `Promise<Result<…>>`. This breaks the synchronous
`Result` API at its root. `generateShape(): Result<IShape>`, the feature handlers
(`registerFeature`), `Transaction.execute`, stable-id tracking and every query would all turn
async. The API change spreads to hundreds of call sites. Worse, one parametric rebuild would cost
many round trips (one per sub-shape query), and the handles would still be ids into the worker. It
ends up with A's messaging cost without A's clean cut. Rejected. A narrow variant (only a few
long-running ops such as `makeThickSolidByJoin` forwarded to a throwaway worker that runs on BREP
text) is possible as an interim step, see phase 1.

## Recommended phasing

1. **Sacrificial worker for known long ops.** Ship the WASM for `web,worker`. A pool of one worker
   runs chosen expensive ops (thick solid / offset on many faces, booleans on large inputs) from BREP
   text, with a timeout and a cancel that call `terminate()` and re-create the worker. The result
   comes back as BREP. The call site stays synchronous for everything else, and only the MCP program
   runner awaits these ops. This removes the reported hang with a bounded change. run_program's op
   loop runs inside the synchronous `Transaction.execute`, so an awaited worker op needs the
   `Transaction.executeAsync` variant; the parametric feature handlers (`registerFeature`) stay
   synchronous and are not routed to the worker in this phase.
2. **Headless application in the worker.** A DOM-free `IApplication` for `Document.loadHeadless`,
   used for the merge validation (`validateMerge`) off the main thread first. It is useful on its
   own and exercises the model in the worker.
3. **Worker-owned document (architecture A).** A mirror protocol (node tree, properties, meshes,
   history position), commands and MCP tools as worker requests, and picking by index. Migrate
   package by package behind a flag: MCP tools first, then commands, then inspect tools.
4. **Remove the main-thread kernel.** Once nothing on the main thread holds an `IShape`, stop
   loading the module there.

## Risks

- The size of phase 3. The inventory of synchronous `IShape` users must come first, and the
  interactive commands (previews while dragging) need a latency budget. A mesh per preview frame
  across the thread boundary may be too slow for live handles.
- Two copies of the model state during migration, and bugs where they drift apart.
- Re-init after `terminate()` loses anything not yet committed. The contract has to say
  "rolled back to the last committed state".
- Memory: a worker plus the main-thread module doubles WASM memory in phases 1 and 2.
- The PlaneGCS solver (its own WASM) has the same main-thread issue, but it is out of scope here.

## Tests

- Phase 1: an op that loops or runs over its timeout is terminated. The worker is re-created and
  the next call works. The document is unchanged, and the call answers `cancelled` or `timeout`.
- The kernel tests run in Node against the worker entry (a `worker_threads` adapter), so the same
  `*.kernel.test.ts` suites pass on both paths.
- Phase 3: mirror consistency (property tests: random command sequences, where the main-thread
  mirror must equal the worker's tree after each), undo/redo parity, and picking by index.
- MCP: `get_document_state` answers while a long op runs in the worker.

## Acceptance Criteria

- [ ] Phase 1: a worker op over its timeout or cancelled is terminated, the worker is re-created, the
      next call works, and the document is back at its last committed state.
- [ ] Phase 1: `get_document_state` answers while a long op runs in the worker.
- [ ] The kernel test suites pass against both the main-thread module and the worker entry.
- [ ] Each later phase has its own implementation ticket with a synchronous-`IShape` inventory
      (phase 3) and a latency budget for interactive previews.
- [ ] No save-format change; the CSP needs no new source.

## Dependencies and Complexity

Dependencies: none for phase 1 (the WASM build for `web,worker`); phase 2 builds on
`Document.loadHeadless`, phases 3 and 4 on phase 2. Complexity: phase 1 medium, phase 2 medium,
phase 3 very high, phase 4 low once phase 3 is done.

## Out of scope

- Pthreads, `SharedArrayBuffer`, multi-threaded OCCT.
- Running several documents' kernels in parallel.
- Server-side evaluation.
- Changing the save format.
