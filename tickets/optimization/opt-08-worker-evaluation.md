# opt-08: Worker-owned kernel evaluation

## Summary

Move OCCT kernel ownership and geometry evaluation into a Web Worker so that long-running synchronous kernel calls do not block the browser's main thread.

## Status

**Gated by opt-01 and opt-07.** Only proceed if measurements show that a single OCCT call (e.g. the `SkirtWall` fuse) blocks the main thread long enough that yielding between features is insufficient.

## Motivation

opt-07 yields between feature evaluations, but a single boolean operation on a complex shape can block for seconds. The example model fuses `SkirtWall` (181 faces, 420 edges) as its second feature, and every subsequent fuse/cut operates on the accumulated body. OCCT's `BRepAlgoAPI_Fuse::Build()` and the history extraction that follows are synchronous C++ calls that cannot be interrupted.

The WASM module is built with `-sENVIRONMENT=web` and no pthreads (`cpp/CMakeLists.txt:101`), so all kernel calls run on the main thread.

## Scope

### Architecture

```
Main thread                    Worker thread
┌──────────┐   requests   ┌──────────────────┐
│ App / UI │ ───────────► │ OCCT / WASM      │
│ Three.js │ ◄─────────── │ ShapeFactory     │
└──────────┘   results     │ Mesher           │
                            └──────────────────┘
```

### What moves to the worker

- WASM module initialization and ownership.
- `ShapeFactory` (all boolean, prism, revolve, fillet operations).
- `Mesher` (OCCT → mesh data).
- `Converter` (BREP/STEP/IGES/STL).
- `Shape` queries (bounding box, sub-shapes, geometry).

### What stays on the main thread

- Document model, node tree, serialization.
- Parametric body evaluation logic (chain, cache, tracking).
- Three.js rendering.
- UI, commands, selection, sketches.

### Communication protocol

1. **Request/result pairs**:
   - Operations are identified by a request id.
   - Arguments are serializable: BREP strings for shapes, JSON for feature data, typed arrays for mesh data.
   - Results include shape handles (worker-local ids), mesh buffers (transferable), tracking maps.

2. **Shape handles**:
   - Shapes live in the worker; the main thread holds opaque ids.
   - `IShape` on the main thread becomes a thin proxy delegating to the worker.
   - Dispose requests free worker-side shapes.

3. **Transferable buffers**:
   - Mesh data (positions, normals, indices) uses `Transferable` `ArrayBuffer`s.
   - BREP strings for shape serialization use `postMessage` with structured clone.

4. **Cancellation**:
   - The main thread can cancel a pending request.
   - The worker checks a cancellation flag between operations (not mid-OCCT-call).
   - A cancelled request returns no result; the main thread ignores it.

### Implementation phases

#### Phase A: Worker shell
- Create the worker, initialize WASM in it.
- Proxy a single operation (e.g. `boundingBox`) end-to-end.
- Verify performance of a round-trip.

#### Phase B: Shape factory proxy
- Move `ShapeFactory` operations to the worker.
- Implement shape-handle protocol.
- Proxy `IShape` methods used by the feature chain.

#### Phase C: Mesher proxy
- Move meshing to the worker.
- Transfer mesh buffers to the main thread.
- Integrate with `ThreeGeometry`.

#### Phase D: Full evaluation
- Run the complete feature chain through the worker.
- Integrate with opt-07's rebuild scheduler.
- Cancellation and stale-result handling.

### Limitations and risks

- **Round-trip latency**: each kernel call now crosses the worker boundary. For small operations, the overhead may exceed the benefit. Keep small chains on the main thread.
- **Shared state**: the node tree, variable scope and feature data live on the main thread. The worker needs serializable snapshots of what it needs to evaluate.
- **Emscripten threading**: the current build does not use pthreads. The worker is a single-threaded WASM instance. OCCT calls still block the worker, but the main thread stays free.
- **GC and FinalizationRegistry**: `OccShape.dispose()` uses a bound delete. The worker must own the lifecycle; the main thread sends dispose requests.
- **Debugging**: worker-side errors need to surface on the main thread with enough context.

## Dependencies

- **opt-07** (responsive rebuilds) — the scheduler provides the async framework the worker plugs into.
- **opt-01** (performance baseline) — measurements determine whether this ticket is needed.

## Acceptance criteria

- [ ] Firefox remains responsive during the longest single OCCT call on the example model.
- [ ] The main thread processes input and repaints while the worker evaluates geometry.
- [ ] Shape results are correct (geometry equivalence with the main-thread baseline).
- [ ] Mesh data is transferred efficiently (no unnecessary copies).
- [ ] Cancellation works: a stale request's result is ignored.
- [ ] Shape disposal works: worker-side shapes are freed.
- [ ] Small operations have acceptable round-trip latency.
- [ ] Existing kernel and parametric tests pass (adapted for worker communication).

## Test plan

- Geometry equivalence: evaluate the example model on the main thread and through the worker; compare BREP output.
- Performance: measure round-trip latency for small operations vs. the blocking time saved on large ones.
- Cancellation: start a rebuild, cancel it, verify no partial result is installed.
- Disposal: verify worker-side shapes are freed (memory trend stable across cycles).
- Run adapted existing tests.

## Files

- `packages/wasm/src/` — worker-side WASM initialization, shape factory proxy
- `packages/wasm/src/worker.ts` — new worker entry point
- `packages/wasm/src/shape.ts` — `IShape` proxy on the main thread
- `packages/wasm/src/factory.ts` — proxy `ShapeFactory` operations
- `packages/parametric/src/parametricBodyNode.ts` — integrate worker evaluation with the rebuild scheduler
- `cpp/CMakeLists.txt` — worker build configuration (if needed)
