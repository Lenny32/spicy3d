# CLOUD-12: Merge Engine

## Summary

Implement CLOUD-11 as a pure function over serialized documents (browser + Node tests), plus the WASM validation pass. Client-only.

## API (`packages/core/src/merge/`)

```ts
export function diffDocuments(base: Serialized, next: Serialized): Change[];   // also used by history compare
export function mergeDocuments(base: Serialized, ours: Serialized, theirs: Serialized,
                               rules: MergeRuleRegistry): MergeResult;          // { merged, conflicts, changes }
export function applyResolutions(result: MergeResult, choices: Resolution[]): Result<Serialized>;
```

- Rule registry mirrors serialization registration; modules register their classes (parametric, sketch). Unknown classes → whole-node atomic 3-way.
- Inputs migrated to current format first; blobs compared by hash.
- Deterministic output and conflict order.

## Validation pass

1. Load merged document without views (null visual).
2. Evaluate bodies; compare per-feature status with ours/theirs.
3. Resolve references; add `dangling-ref` / `rebuild-failure`.

## Things to think about

- O(n) maps by id; patience diff for long sibling lists (big imported assemblies).
- Inputs never mutated (deep-freeze in tests).
- Merge applied as one undoable transaction before pushing.
- Progress + cancel for slow re-evaluation.

## Acceptance criteria

- [x] All CLOUD-11 fixtures pass. (31 cases, `packages/builder/test/mergeFixtures.test.ts`: expected document and conflicts, deep-frozen inputs, determinism, every choice of every conflict; `rebuild-failure` via the kernel test below)
- [x] Property tests (fast-check): `merge(b, x, b) = x`, `merge(b, b, y) = y`, `merge(b, x, x) = x` without conflicts. (`packages/builder/test/mergeProperties.test.ts` over generated documents with random edits, also with manifest inputs; 3000 runs each passed once, 150 in CI)
- [x] Every serializable class has a rule or the explicit atomic fallback. (`packages/builder/test/mergeRules.test.ts`, its source scan fixed to take the first class after the decorator)
- [x] Validation reports only merge-introduced failures. (`packages/parametric/test/mergeValidation.kernel.test.ts`: every fixture with the real kernel — only `rebuild-failure-thin-wall` reports, dangling locations and parents' failures skipped; progress, cancel, cached side reports)

## Dependencies and complexity

Dependencies: CLOUD-11. Complexity: high.
