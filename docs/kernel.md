# Geometry kernel at runtime

How the OCCT kernel runs in the page, how it fails, and what keeps a single operation from taking
the tab down. Build details are in `cpp/README.md`; the plan to move the kernel off the main thread
is [KERNEL-01](../tickets/kernel-01-worker-kernel.md).

## Where it runs

OCCT 8.0 is compiled to one WebAssembly module (`packages/wasm/lib/spicy-wasm.wasm`,
`-sENVIRONMENT=web`, no pthreads, 256 MB initial memory growing up to `-sMAXIMUM_MEMORY=4GB`). The
page retains a main-thread instance for local shape handles and synchronous queries, previews,
meshing, imports and exports. The existing hybrid worker runs opt-in parametric booleans, and
MCP `run_program` uses its bounded factory bridge for boolean fuse/cut/common, fillet/chamfer,
loft, thick-solid simple/join, and the `shape.checkSelfIntersection` query. Worker inputs and outputs are verified BREP replicas;
no native handles cross realms.

While a main-thread native call runs, nothing else in the tab runs: no rendering, no input,
no autosave or cloud sync, and no WebSocket traffic, so the MCP relay gets no answer either. JavaScript cannot interrupt
synchronous code, so a call that never returns freezes the tab until it is reloaded. A call whose
memory keeps growing may take the browser tab (or the browser) down when it reaches the 4 GB cap.

### MCP tool calls

- Mutation and geometry-reading tools run in one shared FIFO `SerialQueue` per page
  (`packages/ai/src/mcp/server.ts`), preserving cross-call program refs. Built-in metadata reads
  `get_document_state`, `get_selection`, and the document resource remain responsive during a
  pending worker operation and report a captured committed-state snapshot.
- **Finite worker deadline.** Self-intersection queries have a deadline of at most 30 seconds (shorter when the
  slow-op budget is lower), including worker initialization and BREP import. Worker requests
  otherwise have a 90-second deadline; corner-setback fits have
  180 seconds for their fixed plate-fit budget (roughly three times the measured reference cost).
  Corner jobs default to a 240-second queue-inclusive deadline and remain immediately cancelable.
  A timeout terminates
  its generation, fails the program, and rolls back nodes/history and reference registries.
  A following operation creates a fresh worker. Selected bounded factory methods never retry
  synchronously when a worker is unavailable or timed out. The self-intersection query also
  refuses synchronous fallback. Use `start_program_job` with the query to get live progress
  and cancel it through `cancel_program_job`; metadata and job status calls remain responsive. Other main-thread calls can still hang.
- **Cancellation.** A call cancelled while queued never starts. Programs check their signal
  between operations and before commit, rolling back if cancelled. A pending native operation
  in the strict bounded bridge terminates its worker generation immediately on abort, reports
  cancellation, and rolls back before the next queued mutation.
  Other synchronous calls still only check cancellation between operations.
- **Document consistency.** A yielding MCP program holds a runtime document ownership scope;
  new UI commands and direct property/tree edits are blocked until commit or rollback.
  Its internal mutations and replay run under scoped authority, and other documents remain editable.
- **Slow-op warning.** Each op's wall time is measured (`packages/ai/src/tools/opBudget.ts`). An op
  that took longer than `Config.slowOpWarningSeconds` (30 s by default, page-level, not saved) adds
  a separate text line to the tool result: `Warning: op "makeThickSolidByJoin" took 48 s (slow-op
  budget 30 s) …`. The next result repeats it once, marked `(earlier call)`, because the call that
  ran the slow op is often the one whose answer the relay no longer waited for. This is a soft
  budget: it reports a slow op after the fact and cannot stop one.

## How a kernel call fails

- **OCCT exceptions.** OCCT reports failures by throwing `Standard_Failure`. The Release build now
  uses native WebAssembly exceptions (`-fwasm-exceptions`), and every binding entry goes through
  `cpp/src/guard.hpp`, which turns a raise into the binding's error channel: an error result
  (`isOk: false`), `undefined`, or a JS `Error`. The TS wrappers answer
  `"<Op> failed: <message>"`. The committed binary is built from the current sources
  (Emscripten 5.0.7, OCCT V8_0_1, 2026-09-30); a module built without this handling still aborts
  on an OCCT raise (`RuntimeError: Aborted(…)`), which the preventive guards keep rare.
- **Aborts and traps.** An abort (out of memory, a C++ bug, or any raise in an old binary) or a trap
  (`unreachable`, `table index is out of bounds`, `null function or function signature mismatch`,
  `memory access out of bounds`) abandons the C++ stack mid-operation. The call fails with
  `"<Op> failed: …"`.
- **Validation.** Thick-solid results (`makeThickSolidBySimple` / `ByJoin`) are checked with
  `BRepCheck_Analyzer` in C++ and `checkShape()` in TS: an invalid one is an error
  (`Thick solid is invalid`), not a solid. The inspections (`inspectionCommonVolume`,
  `inspectionMass`) refuse an input that fails `checkShape()`. They also run a bounded
  self-intersection test (`BOPAlgo_ArgumentAnalyzer`, up to 200 faces per shape).
  `Shape.checkSelfIntersection` in the worker is feature-detected: an older binary answers "not available".

### Thicken offset diagnostics (#121)

Failed thickening in the main factory and the bounded MCP worker bridge retains the original
kernel/validation error. Using existing surface D2, face normal and trimmed-domain queries,
TypeScript samples a 5 × 5 interior UV grid on at most 64 input faces, excluding opening faces
and points outside the face trim. When a principal curvature in the signed offset direction
has radius no greater than the requested thickness, the error names the likely input face
index (zero-based), position in local shape coordinates (mm), sampled radius and a suggestion
to reduce absolute thickness below that radius or smooth the region. The parametric thicken
feature forwards these errors, including when thickness is a live expression.

This is a sampled local regularity limit, **not a maximum successful thickness**. Sampling can
miss a narrow crease; collisions between distant faces and offset trimming failures have other
causes. Uninformative offset statuses with no sampled limit get a qualified hint instead of an
invented failing face. Successful results and the existing validity/opening-face checks are
unchanged. Diagnostics never retry the offset; worker cancellation/timeouts and native traps
do not trigger sampling.

The curvature-tolerant envelope mode remains blocked under the frozen save format and offline
WASM constraints. Open skins already use `MakeThickSolidBySimple`. The existing Join binding
fixes self-intersection handling to false and exposes no `RemoveIntEdges` argument. Exposing
such controls or another offset algorithm requires a C++ binding and a rebuilt WASM module;
the existing optional feature `mode` only accepts OCCT `skin`/`pipe`, and `joinType` controls
edge joins. A persisted envelope selection would require a new stored option (or extending
the existing mode's accepted values), approval of the payload change, a parametric version
bump/migration and fixtures. None of those changes is made here.

## Dead-kernel state

After an abort or a fatal trap, `packages/wasm/src/kernelGuard.ts` runs a small probe (a unit box)
against the module. Often the module survives, and nothing changes. If the probe fails, core's
`KernelState` records the kernel as crashed with the first reason. Its native generation is permanently retired: resetting public crash state cannot revive its handles. Factory and converter calls refuse to enter that generation. MCP kernel tools answer the crash error before starting work, while metadata tools report `kernel: "crashed"`.

The application offers Recover and Reload. Recover creates a fresh main WASM instance and stages reconstruction of every open document from its last healthy committed checkpoint. All candidates must validate before activation. Success preserves committed unsaved edits, stable document/feature IDs and clean/dirty status, then clears undo/redo as explicitly approved. Scene-backed MCP refs re-derive; standalone geometry and creation snapshots invalidate. Preparation failure keeps original document graphs and history. A later viewport refresh failure reports an error while the new kernel stays healthy. `recover_kernel` uses the normal MCP mutation FIFO. Reload remains available if a current checkpoint or supported document reconstruction is unavailable.

A main-thread hang is not a crash: the page cannot detect or end it. A worker hang is ended by
its finite deadline without marking the main kernel crashed.

## Guard rails against known hangs

- **Intersection join on many faces.** `makeThickSolidByJoin` with `joinType: "intersection"` runs
  `BRepOffset_MakeOffset` in `GeomAbs_Intersection` mode, which intersects the offset faces pairwise.
  On a shell of many narrow faces (a G2 loft of 61 faces in the original report) it may never finish.
  `packages/wasm/src/factory.ts` refuses such a call before entering the kernel when the input has
  more faces than `Config.thickSolidIntersectionMaxFaces` (40 by default, page-level, not saved;
  `Infinity` lifts the guard). The `Result.err` names the face count, the limit and the alternatives
  (`joinType: "arc"`, `makeThickSolidBySimple`). The guard sits in the factory, so it covers every
  caller: `run_program`, the Shell command (whose preview and confirm now toast the kernel's error)
  and the parametric thicken feature on a solid with open faces. Arc and tangent joins are not
  limited. The capability doc and the `modeling-recipes` skill warn agents about it.

## Plan

Phase 1 of [KERNEL-01](../tickets/kernel-01-worker-kernel.md) extends the existing hybrid worker
with bounded MCP factory execution. Full model evaluation and
main-kernel recovery (#98) remain separate work.


### Self-intersection query isolation (#120)

The MCP query runs on a verified BREP copy in a worker dedicated to that operation. Cancellation
or deadline terminates only that worker; the main kernel's source shapes and the resident boolean
worker remain intact. The next query creates a fresh instance. Timeout is an error, never a
successful validity result; choose a simpler skin or skip this expensive check explicitly when
appropriate, understanding that `checkShape` alone does not establish absence of self-intersection.
Direct synchronous `IShape.checkSelfIntersection()` calls (including feature validation) still
use the existing binding. OCCT has no cooperative cancellation hook in this offline build; stopping
a running check requires terminating its worker. Replica capture on the main thread and other
synchronous checks remain potential blocking work.
