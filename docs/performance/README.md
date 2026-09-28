# Saved-model performance evidence

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
