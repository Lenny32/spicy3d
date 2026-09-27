# Inspect Panel Enhancement Roadmap

Expand Spicy3D's measurement and shape-checking tools with persistent visual, geometry, manufacturing, and assembly analyses. Status: planned. Comparison baseline: 2026-09-24.

## Current State

The Inspect group in `packages/builder/src/ribbon.ts` contains Length, Angle, Select, Section, and Check Shape.

- Length measures between picked points; Angle uses three picked points.
- Select measures edge length, face area, and solid volume, with running totals.
- Section creates intersection geometry between selected shapes; it is not an interactive viewport cutaway.
- Check Shape reports face validity and diagnostic statuses.
- Boolean Common is an existing modeling operation, not an interference report.

Preserve these workflows while extending inspection. No implementation is included in these planning tickets.

## Tickets and Order

Priorities: P1 = everyday inspection and shared infrastructure; P2 = surface/manufacturing visualization; P3 = capabilities requiring broader data or workflow prerequisites. Priorities are proposed implementation order, not delivery commitments.

| Ticket | Scope | Depends on | Priority |
|---|---|---|---|
| [INSPECT-00](inspect-00-foundation.md) | Analysis Lifecycle and Display Foundation | None | P1 |
| [INSPECT-01](inspect-01-measure.md) | Unified Selection-Based Measure | 00 | P1 |
| [INSPECT-02](inspect-02-section-analysis.md) | Interactive Section Analysis | 00 | P1 |
| [INSPECT-03](inspect-03-interference.md) | Interference Detection and Reporting | 00 | P1 |
| [INSPECT-04](inspect-04-center-of-mass.md) | Center of Mass Analysis | 00 | P1 |
| [INSPECT-05](inspect-05-curvature-comb.md) | Curvature Comb Analysis | 00 | P2 |
| [INSPECT-06](inspect-06-curvature-map.md) | Curvature Map Analysis | 00 | P2 |
| [INSPECT-07](inspect-07-draft-analysis.md) | Draft Angle Analysis | 00 | P2 |
| [INSPECT-08](inspect-08-environment-map.md) | Environment Map Surface Inspection | 00 | P2 |
| [INSPECT-09](inspect-09-isocurve-analysis.md) | Isocurve Analysis | 00; 05 for curvature-comb overlay | P2 |
| [INSPECT-10](inspect-10-zebra-analysis.md) | Zebra Surface Continuity Analysis | 00 | P2 |
| [INSPECT-11](inspect-11-accessibility-analysis.md) | Directional Accessibility Analysis | 00 | P2 |
| [INSPECT-12](inspect-12-minimum-radius.md) | Minimum Concave Radius Analysis | 00, 06 | P2 |
| [INSPECT-13](inspect-13-design-advice.md) | Plastic Part Design Advice | 00, 07, 12; wall-thickness query prerequisite | P3 |
| [INSPECT-14](inspect-14-fastener-stack.md) | Fastener Stack Analysis | 00; assembly/fastener metadata prerequisite | P3 |
| [INSPECT-15](inspect-15-component-colors.md) | Display Component Colors | 00 | P2 |
| [INSPECT-16](inspect-16-mesh-face-groups.md) | Display Mesh Face Groups | 00; mesh face-group metadata prerequisite | P3 |
| [INSPECT-17](inspect-17-similar-components.md) | Find Similar Components | Component library/index prerequisite; 00 for UI conventions only | P3 |

Implement the foundation first, then Measure, Section Analysis, Interference, and Center of Mass. Zebra and Draft are useful first surface-analysis deliveries. Curvature Map supplies the evaluation needed by Minimum Radius; Curvature Comb supplies Isocurve's optional comb overlay. The later advisor, fastener, mesh-group, and search tickets include explicit prerequisite/design work and must not be presented as ready solely because viewport infrastructure exists.

Construction references are optional integration points with [CONSTRUCT-01](construct-01-foundation.md). Accept existing origin planes, faces, and edges without requiring all Construct tools to ship first.

## Fusion Coverage

The 17 feature tickets map one-to-one to the tools in the [Autodesk Inspect reference](https://help.autodesk.com/cloudhelp/ENU/Fusion-Model/files/SLD-INSPECT-TOOLS.htm). INSPECT-00 adds the shared lifecycle needed by our implementation. Fusion availability varies by workflow and license; this is a capability backlog, not a promise of identical licensing or full product parity.

Measure extends existing functionality. Section Analysis is a new visual tool alongside our current Section operation. Other rows are missing dedicated user-facing equivalents in the audited source. Check Shape remains a useful existing tool and does not substitute for interference or manufacturing advice.

Design Advice uses the plastic-part workflow described in [Autodesk's Design Advice documentation](https://www.autodesk.com/support/technical/article/caas/sfdcarticles/sfdcarticles/How-to-access-and-use-Design-Advice-in-Fusion.html). The ticket explicitly limits the first rule set. Fastener Stack and Find Similar Components require semantic assembly/library data beyond the current inspection commands.

## Shared Implementation Requirements

- Define numerical units, tolerances, orientation conventions, supported inputs, and unknown/error states for each analysis.
- Persistent analyses retain source references and editable settings, support save/load and undo/redo, and invalidate correctly after geometry or transform changes. Transient measurement inspectors and display toggles use the relevant subset of the lifecycle.
- Inspection must not silently modify source geometry or materials. Any optional modeling action is separate and undoable.
- Respect nested transforms, trimmed geometry, and stable parametric sub-shape identity; report lost or ambiguous references instead of guessing.
- Guard null/degenerate kernel inputs before native queries. Release WASM disables C++ exception catching; try/catch is not a substitute for preventive validation. Expected failures use Result errors at the application boundary.
- Dispose temporary kernel shapes, shaders, textures, clipping state, event subscriptions, and overlays. Expensive evaluation supports cancellation and rejects stale results.
- Integrate commands into Inspect with localized labels, accessible controls, unit-aware values, and clear legends. Preserve Check Shape and existing measurement shortcuts.
- Treat local curvature, draft, and directional access as distinct checks. None alone proves manufacturability or collision-free tool motion.

## Verification

For implementation tickets, add focused Rstest behavior tests with analytic fixtures and meaningful numeric tolerances. Cover supported selection types, transforms, degenerate inputs, invalidation, and lifecycle where applicable. Use shared test helpers and restore global patches.

Run relevant regression tests and manually verify picking, preview, legends, cancellation, and restoration of original materials. Native query changes require rebuilding WASM and validating the actual kernel path; shader/clip changes require viewport checks. Broader tests should follow the scope of the change.

These files are planning documents; creation of the backlog requires only document and link validation.

