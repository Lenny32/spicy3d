# opt-01: Performance baseline instrumentation

## Summary

Add opt-in performance instrumentation to measure where time is spent during model loading and sketch editing, producing a baseline against `Mouse Bottom.spicy` that later tickets validate against.

## Motivation

The analysis identified several likely bottlenecks, but the actual time distribution is unknown. Measurements are needed to:

- Confirm the priority ordering of subsequent tickets.
- Provide a before/after comparison for each optimization.
- Detect whether a single long OCCT call or the aggregate chain is the dominant cost.

## Scope

### Instrumentation points

| Stage | What to measure | Location |
|---|---|---|
| Document decoding | Gzip decompression, JSON parse, migration | `packages/core/src/documentFile.ts`, `packages/app/src/document.ts` |
| Node deserialization | Per-node construction time, total count | `packages/core/src/modelManager.ts`, `packages/core/src/model/node.ts` |
| Feature-chain evaluation | Per-feature duration, cache hit/miss, rebuild trigger | `packages/parametric/src/parametricBodyNode.ts` |
| Kernel operations | Boolean and history-completion time | `packages/wasm/src/factory.ts` |
| Sketch profile construction | Count and duration | `packages/parametric/src/features/profileBuilder.ts` |
| Meshing | OCCT mesh time, buffer conversion | `packages/wasm/src/shape.ts` (Mesher) |
| Visual creation | Three.js object creation time | `packages/three/src/threeVisualContext.ts` |

### Implementation approach

- Gate instrumentation behind a `performance` debug flag or environment variable — zero overhead when disabled.
- Use `performance.now()` for timings; collect into a structured log, not console spam.
- Record feature index, type, cache hit/miss and duration for each chain step.
- Record longest single main-thread blocking interval.
- Record boolean call count and total kernel time.
- Record mesh creation count (distinguishing body mesh from construction geometry).
- Record memory trend across repeated operations.

### Benchmark harness

- Disable autosave and file write-back during profiling.
- Verify the original file's hash before and after validation.
- Run in Firefox (the reported browser).

### Benchmark scenarios

| Scenario | Purpose |
|---|---|
| Cold-open the saved model | Separate deserialization, rebuild and display costs |
| Open/close `Sk_Plate` unchanged | Exercise full-chain rollback (83 downstream features) |
| Open/close `Sk_RibBox1` unchanged | Exercise a substantial downstream chain (~73 features) |
| Open/close the final sketch unchanged | Establish a small-rebuild comparison (1 feature) |
| Repeat unchanged open/close cycles | Detect accumulating memory or work |

## Dependencies

None.

## Acceptance criteria

- [ ] Instrumentation is opt-in and has zero overhead when disabled.
- [ ] All seven stages above produce structured timing data.
- [ ] Per-feature chain timing distinguishes cache hits from misses.
- [ ] Boolean call count is recorded.
- [ ] Mesh creation count distinguishes body mesh from construction geometry.
- [ ] Baseline table exists for all five benchmark scenarios.
- [ ] The original model file is verified unchanged after profiling.
- [ ] Memory trend is recorded across repeated cycles.

## Files

- `packages/core/src/documentFile.ts` — decode timing
- `packages/app/src/document.ts` — load/migration timing
- `packages/core/src/modelManager.ts` — deserialization timing
- `packages/parametric/src/parametricBodyNode.ts` — per-feature timing
- `packages/wasm/src/factory.ts` — kernel operation timing
- `packages/parametric/src/features/profileBuilder.ts` — profile construction timing
- `packages/wasm/src/shape.ts` — meshing timing
- `packages/three/src/threeVisualContext.ts` — visual creation timing
