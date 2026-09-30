# Saved-model performance evidence

**Latest final validation after both P1 fixes:** [final-paired.md](final-paired.md),
[compact paired data](final-paired.json), and one raw gzip capture per mode
([main](final-paired-main.json.gz), [hybrid](final-paired-hybrid.json.gz)). One unchanged build, five
scenarios including ten repeats, all 83 sketches, tracked IDs, picking and real-worker cancellation.
Earlier artifacts below remain immutable historical observations.

`before-firefox-series` is the pristine-HEAD cold load, unchanged sketch cycles and ten-cycle memory series.
Its third sketch was the last node in tree order (`Sk_RibBox3`), **not** the final feature's sketch.
`before-firefox-final` corrects that coverage with a fresh cold load and `Sk_SwBlockSlit_B` (feature 83).

The `.json` files summarize measured records; `.json.gz` files preserve the full records and before/after
BREP, feature JSON, sketch JSON and visibility snapshots. Both runs used detached HEAD
`bf111c777bb2aa4d266146a51372a6d6081f7b4e`, with no source patches. Read the limitations and methodology
in [the performance report](../saved-model-performance.md) before comparing results.

`after-firefox-combined` captures the production working-tree build with opt01–07 integrations, all five
scenarios and all 83 sketches. `after-firefox-regression` is an independent real-browser test of the
same built distribution, additionally checking the two hidden nodes' visual and kernel mesh state.
Both preserve detached, triangulation-cleaned BREP comparisons against the pristine BEFORE export.
The model hash, build fingerprint, source fingerprint and separate runtime/source counters are retained.

`worker-integrated-observation` is the worker owner's captured run, replay-audited without a new model
benchmark. Its `.json` is a concise summary, `.json.gz` is the unmodified original measurement, and
`.geometry.json.gz` retains a separate independent graph/volume audit tied to the measurement's hash.
Read [the worker review](worker-integrated-observation.md): this snapshot predates final hardening,
contains 86 sessions (no ten-repeat series), and shows elapsed-time/memory regressions alongside improved
responsiveness. Hybrid geometry validation is explicit and does not claim pristine BREP byte identity.

Historical pre-final comparison: [`worker-opt-in-paired.md`](worker-opt-in-paired.md) with the owner's small
[`worker-opt-in-paired.json`](worker-opt-in-paired.json) preserved verbatim once. Both modes used one build;
resident reuse and matching complete tracked IDs are recorded. This precedes the fallback/picking P1 fixes;
see the [completed final paired validation](final-paired.md) for the post-fix results. The shared harness serves mode-specific,
in-memory deployment configuration; its default is explicitly main/worker-off.
