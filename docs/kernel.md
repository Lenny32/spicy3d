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
loft, and thick-solid simple/join. Worker inputs and outputs are verified BREP replicas;
no native handles cross realms. See [bounded worker execution](kernel-bounded-worker.md).

While a main-thread native call runs, nothing else in the tab runs: no rendering, no input,
no autosave or cloud sync, and no WebSocket traffic, so the MCP relay gets no answer either. JavaScript cannot interrupt
synchronous code, so a call that never returns freezes the tab until it is reloaded. A call whose
memory keeps growing may take the browser tab (or the browser) down when it reaches the 4 GB cap.

### MCP tool calls

- Mutation and geometry-reading tools run in one shared FIFO `SerialQueue` per page
  (`packages/ai/src/mcp/server.ts`), preserving cross-call program refs. Built-in metadata reads
  `get_document_state`, `get_selection`, and the document resource remain responsive during a
  pending worker operation and report a captured committed-state snapshot.
- **Finite worker deadline.** Every worker request has a 90-second deadline. A timeout terminates
  its generation, fails the program, and rolls back nodes/history and reference registries.
  A following operation creates a fresh worker. Selected bounded factory methods never retry
  synchronously when a worker is unavailable or timed out. Other main-thread calls can still hang.
- **Cancellation.** A call cancelled while queued never starts. Programs check their signal
  between operations and before commit, rolling back if cancelled. A pending native operation
  in the strict bounded bridge terminates its worker generation immediately on abort, reports
  cancellation, and rolls back before the next queued mutation. See [cancellation](kernel-cancellation.md).
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
  `Shape.checkSelfIntersection` is feature-detected: an older binary answers "not available".

## Dead-kernel state

After an abort or a fatal trap, `packages/wasm/src/kernelGuard.ts` runs a small probe (a unit box)
against the module. Often the module survives, and nothing changes. If the probe fails, core's
`KernelState` records the kernel as crashed with the first reason. Its native generation is permanently retired: resetting public crash state cannot revive its handles. Factory and converter calls refuse to enter that generation. MCP kernel tools answer the crash error before starting work, while metadata tools report `kernel: "crashed"`.

The application offers Recover and Reload. Recover creates a fresh main WASM instance and stages reconstruction of every open document from its last healthy committed checkpoint. All candidates must validate before activation. Success preserves committed unsaved edits, stable document/feature IDs and clean/dirty status, then clears undo/redo as explicitly approved. Scene-backed MCP refs re-derive; standalone geometry and creation snapshots invalidate. Preparation failure keeps original document graphs and history. A later viewport refresh failure reports an error while the new kernel stays healthy. See [main-kernel recovery](kernel-recovery.md) for bounds, limitations and API details. `recover_kernel` uses the normal MCP mutation FIFO. Reload remains available if a current checkpoint or supported document reconstruction is unavailable.

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
with [bounded MCP factory execution](kernel-bounded-worker.md). Full model evaluation and
main-kernel recovery (#98) remain separate work.
