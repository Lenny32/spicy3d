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
- **Finite worker deadline.** Self-intersection queries have a deadline of a fixed 30 seconds, including worker initialization and BREP import. Worker requests
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
  `inspectionMass`) refuse an input that fails `checkShape()`. Common-volume and section-cap
  inspections also run a bounded self-intersection test (`BOPAlgo_ArgumentAnalyzer`, below
  200 unique faces per shape). Mass only runs `BRepCheck_Analyzer` and `VolumeProperties`;
  it does not run the self-intersection analyzer.
  `Shape.checkSelfIntersection` in the worker is feature-detected: an older binary answers "not available".

### Thicken offset diagnostics (#121)

Failed thickening in the main factory and the bounded MCP worker bridge retains the original
kernel/validation error. Using existing surface D2, face normal and trimmed-domain queries,
TypeScript samples a 5 × 5 interior UV grid on at most 64 input faces, excluding opening faces
and points outside the face trim. When a principal curvature in the signed offset direction
has radius no greater than the requested thickness, the error names the possible input face
index (zero-based), position in local shape coordinates (mm), sampled radius and a suggestion
to reduce absolute thickness below that radius or smooth the region. The parametric thicken
feature forwards these errors, including when thickness is a live expression.

This is a sampled local regularity limit, **not a maximum successful thickness**. Sampling can
miss a narrow crease; collisions between distant faces and offset trimming failures have other
causes. Uninformative offset statuses with no sampled limit get a qualified hint instead of an
invented failing face. Successful results and the existing validity/opening-face checks are
unchanged. Diagnostics never retry the offset; worker cancellation/timeouts and native traps
do not trigger sampling. If more than 64 faces exist, diagnostics explicitly say
“sampled the first 64 of N faces”. Validation failures describe a possible offset collapse.

The opt-in `tolerant` thicken option (parametric module 15; 14→15 identity migration) builds
material rather than a bare offset. With no option, old documents retain their exact behavior.
Closed full spheres and ring tori with inward thickness at least their sphere/tube radius
have a proven empty cavity: the envelope is a copy of the entire input solid. Surface type,
face count, area and volume identify the complete analytic shape; trimmed patches do not
qualify. Smaller walls and other single solids use OCCT all-parallel intersection trimming
with intersection joins and internal-edge removal, followed by the wall boolean, ShapeFix,
UnifySameDomain, exact BRepCheck and finite positive component-volume checks. Inward material
cannot exceed the source volume. The normal many-face intersection-join guard still applies.

This is a limited envelope mode, **not a general solution for scanned free-form creases**.
Confirmed classes are full spheres, ring tori at cavity collapse, and opened planar box solids.
Open skins, multiple solids, pipe mode and unrecognized cavity collapse remain errors; other
solids may fail OCCT trimming or the validity gates. OCCT 8.0.1's local
`BRepOffsetAPI_MakeThickSolid.hxx` documents SelfInter removal as unimplemented and all-parallel
intersection as incomplete; enabling SelfInter would not provide the requested guarantee.
The new binding is feature-detected; older binaries refuse the opt-in rather than changing
its meaning. MCP `thicken { tolerant: true }` and the creation/edit panels expose the option.
Curvature-collapse diagnostics suggest retrying tolerant mode for supported solids. General
free-form rolling-ball envelopes remain unfinished.

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

The MCP query runs on a verified BREP copy in a worker dedicated to that operation.
Cancellation or deadline terminates only that worker; the main kernel's source shapes and
resident boolean worker remain intact. The next query creates a fresh instance. Timeout is
an error: "Self-intersection check timed out after N ms (result unknown)", never a successful
validity result. Simplify the skin before retrying; `checkShape` alone does not establish
absence of self-intersection.

Before `run_program` calls `inspectionCommonVolume` or `inspectionSectionCaps`, it runs the
same bounded worker query on each applicable input.
Common volume checks both shapes; section caps checks its input. Both skip pre-checks
when any input fails `checkShape()`, letting the binding return its existing invalid-input error immediately.
Timeout, cancellation, or worker failure refuses the inspection with an error and never
calls its main-thread binding; a detected self-intersection returns the inspection's
unavailable-result error. Missing bounded worker
support also refuses an inspection that needs the pre-check. Feature detection skips the
pre-check when the self-intersection binding is unavailable, and inputs with at least 200
unique faces skip it because the kernel's bounded inspection analyzer already skips those
inputs. Its occurrence count can be larger, so repeated faces may cause an extra pre-check.
Queries that do not use this analyzer (`inspectionMass` and `inspectionDistance`) do not
pre-check. Mass retains its topology validity gate and mass calculation without a worker.

Each applicable pre-check exports a BREP replica and starts a fresh Worker and OCCT instance.
That startup adds latency per inspection; common volume normally pays for two sequential
pre-checks, one per distinct input.

The pre-check duplicates work: common-volume and section-cap inspections repeat the same
analyzer synchronously after the verified BREP replica passes in the worker. A successful
pre-check does not impose a deadline on this repeated analyzer or the subsequent native
inspection. Boolean intersection, mass calculations, topology validation, and replica
capture can still block.
Skipping an explicit self-intersection query does not bypass these inspection pre-checks.

The analysis panel's section caps and interference queries use the same bounded pre-check,
with progress and Cancel while running; a deadline reports “timed out (result unknown)”.
The subsequent inspection binding still runs synchronously, with the limitations above.

Sweep and face-sweep handlers use cheap topology/volume gates and mark validation pending
in their runtime context. With bounded-worker support installed, top-level rebuilds
containing either feature take the asynchronous scheduler route even below the twelve-feature threshold. The scheduler captures each output
(including face-sweep's temporary tool before disposal) in a bounded worker and awaits all
checks **before caching, tracking commit, or displaying the new body**. Checks run at every
shape size: the 32-face/64-edge heuristic and 256-face refusal have been removed. Worker
termination enforces a fixed 30-second deadline independent of the slow-op warning setting.
Detected self-intersection is a feature error. A fast machine can detect self-intersection and reject
a shape that a slower machine accepts after timeout; there is no strict mode. Timeout, worker failure and unavailable worker
results accept the geometry with a runtime warning (result unknown; geometry not verified).
The warning appears on the timeline, edit panel, body warning list and MCP diagnostics;
later features still evaluate, including on document open and during merge validation.
Unknown results are cached with their warnings while inputs remain unchanged and checked
again after input changes. This cache lasts only for the session (#119/#120 policy).
A newer rebuild, job cancellation, undo/redo, or disposal cancels the pending checks and
releases the unaccepted output. A synchronous scheduler drain cannot fall back to the
analyzer. Document open and headless merge evaluation can await these scheduled rebuilds.
No validation state or shape is stored in the document.

run_program feature ops evaluate synchronously (cheap gates + skip warning); editSketch-triggered
rebuilds can await worker validation.
Factories without bounded-worker support in every rebuild mode (including chains of twelve
or more features), explicit synchronous program scopes, nested
producer/consumer rebuilds, and the current synchronous feature-preview API cannot await a worker. These run only the cheap checks,
with the runtime warning “Self-intersection check skipped in synchronous evaluation
(result unknown; rebuild validates in worker)”. Preview results expose the warning and
edit panels display it. This compromise can miss self-overlap in these contexts; it is
not proof of validity. Ordinary subsequent asynchronous rebuilds validate in the worker.

Remaining unrestricted main-thread callers:
- Guided loft construction at every size: the analyzer is inside `loftGuidedTracked` in
  `cpp/src/factory.cpp`. The existing TS worker protocol has no guided-loft tracked
  construction operation. Adding only a deferred query cannot contain this internal call.
- Common-volume and section-cap inspection bindings repeat the analyzer after their
  bounded pre-check. The worker protocol has no whole-inspection operation; those repeats,
  booleans, mass calculation and topology checks still have no hard deadline.
- Direct synchronous `IShape.checkSelfIntersection()` calls outside these managed routes.

Sweep construction, face-sweep booleans, cheap validity gates and BREP capture also remain
synchronous. This change contains their self-intersection validation, not arbitrary native
calls. OCCT has no cooperative cancellation hook in this offline build; stopping a running
check requires terminating its worker. Guided-loft and whole-inspection worker contracts
remain follow-up work; no C++ or committed WASM artifacts were changed here.

### Boolean and downstream validity (#119)

The tracked boolean worker and bounded operation bridge pre-check boolean operands for
finite, non-negative signed volume, without running `BRepCheck_Analyzer` on them. Boolean
results run the analyzer and check every solid component's volume. A positive compound
total cannot hide an inside-out component: negative or non-finite component volumes are
always rejected, even when an operand is already invalid.

Only when a result fails the topology analyzer are its operands analyzed. If any operand
already fails `checkShape`, the result is accepted, preserving support for imported STEP/BREP
tolerance defects. Parametric features report a runtime warning naming the invalid input or
tool; bounded operations accept silently. If all operands are valid, the invalid result is
rejected. Valid results incur no operand analyzer calls. Bounded fillet/chamfer and loft
continue to reject invalid inputs and results. Geometry rejection is an ordinary operation
error; it neither falls back to the synchronous kernel nor disables a healthy worker. Kernel
and validity errors identify the parametric feature type and step id; user validation errors
keep their original wording.

Worker checks run inside the existing terminable request deadline. Synchronous parametric
boolean compatibility paths also run `checkShape` and per-solid volume checks on results,
with the same invalid-operand policy and no face-count cutoff. These main-thread calls can
block; neither path adds the more expensive self-intersection analyzer. Empty boolean
results retain the existing feature-specific errors. Thicken retains its orientation repair
for a valid inside-out offset before it becomes a feature result; the bounded bridge performs
the same repair before checking every output component.

### Fillet/chamfer invalid-face diagnostics (#132)

The supplied final-body snapshot did not reproduce #132 in investigation. Diagnostics now
identify up to eight invalid result faces by zero-based index and BRepCheck status, including
wire and edge defects under a face. They reuse the face-status implementation of `checkFaces`.
Failed fillets inspect OCCT's partial result when one exists; an early build failure explicitly
reports that no result faces are available. Chamfer invalid results use the same diagnostics.
The result detail is bounded to 1,800 characters, in addition to the existing bounded contour
and MCP selected-edge/adjoining-face context. Result face indexes refer to the attempted output,
while the selection indexes refer to the input. The synthetic near-wall mouse-skirt recess
regression produces `Intersecting Wires`. For the investigated attachment, set
`SPICY3D_ISSUE_132_MODEL` to a local `.spicy` path to run the opt-in final-body fillet regression;
no download or large committed attachment is needed.
