# #85 guided loft native checkpoint

The accepted product binding is `loftGuidedTracked`; experimental `loftGuideProof` is removed.
This checkpoint implements no saved guided field or version registration yet. Root approved
the optional parametric-13 guided group; registration waits for versions 11 and 12.

The guarded native API copies all input shapes and geometry before any OCCT validation or
construction. Copy.ModifiedShape explicitly maps original edge/vertex enumeration onto the
copies used by PipeShell; returned ancestry indexes address the original inputs, all sections
followed by spine and boundary. Section history, generated side faces, start/end edges and
separate cap faces reuse the existing pipeHistory channels. Missing copy ancestry and incomplete
side/cap history fail rather than invent derivation.

Input validation requires 2-16 closed planar sections, 1-128-piece connected/unbranched open
paths without self-interference, finite nondegenerate curve spans and tolerances, unique exact
path/plane intersections and stations, monotonic first-to-last coverage, and boundary contact
with every section. Section inspection is bounded at 512 edges per section/8192 total; output
side faces are limited to 512. A reference to the spine itself cannot act as the boundary.

All requested sections are retained in NoContact construction with C2 and ForceApproxC1(false).
Non-destructive boolean cuts prove every full section and the complete boundary lie on the
generated SIDE-face compound. HasErrors, nonfinite/negative residual lengths and remaining
length above 1e-5 mm fail. No finite sampling or solid containment establishes acceptance.
Output self-interference is rejected by the native argument analyzer; accepted native geometry
also passes the public self-interference query in every positive proof.

Fourteen native tests pass, including two/three sections, guide influence versus ordinary loft,
interior/incompatible guides, both paths reversed, overshooting/closed/multiple-plane spines,
nonplanar section rejection, actual original topology history and distinct semantic caps.
Success and failure preserve unprimed input BREP strings and existing display mesh identities
and numeric buffers. Local-alias TypeScript and scoped npm check pass.

The combined compiled artifacts match accepted #88/#89, strict #90 faceSweepTracked and
copyTracked source plus this guided binding. All 72 tests in eight affected native, sweep,
projection and ordinary loft suites pass. Local-alias TypeScript and scoped npm check pass.
This checkpoint excludes the separate #84 corner binding; its accepted source will be combined
in a subsequent serialized rebuild. No parametric-13 version registration is included here.
