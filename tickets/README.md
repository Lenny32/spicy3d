# Sketch Tools Enhancement Roadmap

For inspection and analysis tools, see the [Inspect Panel Enhancement Roadmap](inspect-roadmap.md), covering the shared foundation and 17 Fusion feature gaps (INSPECT-00 through INSPECT-17).

Incremental plan to expand Spicy3D sketch capabilities to match Fusion 360 functionality.

For 3D construction planes, axes, points, and coordinate systems, see the separate [Construct Panel Enhancement Roadmap](construct-roadmap.md), covering tickets CONSTRUCT-01 through CONSTRUCT-07.

## Phases Overview

| Phase | Focus | Complexity | Est. PRs | Blockers |
|-------|-------|-----------|----------|----------|
| [Phase 1](phase-1-geometry-foundations.md) | Polygon, Ellipse, Point | Medium | 1 | PlaneGCS conic support |
| [Phase 2](phase-2-geometry-editing.md) | Trim, Extend, Split, Offset | Medium-High | 1-2 | Intersection detection |
| [Phase 3](phase-3-curve-support.md) | Spline, Bezier, Edit Curve | High | 1-2 | **PlaneGCS curve support (critical)** |
| [Phase 4](phase-4-utility-operations.md) | Mirror, Copy, Paste, Move, Rotate | Medium | 1 | Entity transformation logic |
| [Phase 5](phase-5-constraint-enhancements.md) | Collinear, Block, Construction, Equal Angle, Scale | Medium | 1 | PlaneGCS constraint support |
| [Phase 6](phase-6-solver-feedback.md) | Status panel, Auto-dimension, Conflict detection | High | 1-2 | **PlaneGCS introspection API (critical)** |

## Quick Links

- **[Phase 1: Geometry Foundations](phase-1-geometry-foundations.md)** — Polygon, Ellipse, Point
- **[Phase 2: Geometry Editing](phase-2-geometry-editing.md)** — Trim, Extend, Split, Offset
- **[Phase 3: Curve Support](phase-3-curve-support.md)** — Spline, Bezier (largest scope)
- **[Phase 4: Utility Operations](phase-4-utility-operations.md)** — Mirror, Copy, Move, Rotate
- **[Phase 5: Constraint Enhancements](phase-5-constraint-enhancements.md)** — Advanced constraints
- **[Phase 6: Solver Feedback](phase-6-solver-feedback.md)** — Analysis & diagnostics

## Critical Research Items

### Completed Research

✅ **Phase 3: PlaneGCS Curve Support** — [PHASE-3-RESEARCH.md](PHASE-3-RESEARCH.md)
- PlaneGCS v1.2.0 **does NOT support** splines, Bezier, or conics
- Curves must be **geometry-only** (endpoints constrained, shape fixed)
- Ellipse is a type stub with no solver bindings
- **Decision:** Implement splines/ellipse as fixed geometry with endpoint constraints

✅ **Phase 6: PlaneGCS Introspection** — Supported
- `diagnosis()` API provides conflict/redundancy detection
- Solver exposes degrees of freedom count
- Phase 6 feasible as planned

### Still Outstanding

⏳ **Phase 1: Ellipse Implementation**
- Include ellipse in Phase 3 (geometry-only) or Phase 1?
- If Phase 1: keep as stub, implement in Phase 3
- If Phase 3: combine with splines, implement together

## Recommended Sequence (Post-Research)

### Immediate Path (No Blockers)

1. **Phase 1: Geometry Foundations** ← Start here
   - Polygon, Point (straightforward)
   - Ellipse: **stub only** (defer implementation to Phase 3)
   - Risk: Low | Dependencies: None

2. **Phase 2: Geometry Editing** ← Can run in parallel
   - Trim, Extend, Split, Offset
   - Risk: Medium | Dependencies: Phase 1 (reference only)

3. **Phase 4: Utility Operations** ← Medium priority
   - Mirror, Copy, Paste, Move, Rotate
   - Risk: Medium | Dependencies: Phase 1 (reference only)

### Later Path (Research Complete, No Longer Blockers)

4. **Phase 3: Curve Support (Revised)** ← Now feasible, different scope
   - **NOT parametric:** curves are fixed geometry with endpoint constraints
   - Spline (geometry-only), Ellipse (geometry-only)
   - Risk: Medium | Dependencies: Phase 1-2 (reference patterns)

5. **Phase 5: Constraint Enhancements** ← After Phase 3 stable
   - Collinear, Block, Construction, Equal Angle
   - Risk: Medium | Dependencies: Phase 3 (optional)

6. **Phase 6: Solver Feedback** ← Last (Phase 6-specific research done, feasible)
   - Status panel, Auto-dimension, Conflict detection
   - Risk: Medium | Dependencies: Phase 1-5 (to give feedback on)

### Key Decision: Ellipse in Phase 1 or Phase 3?

| Phase 1 (Geometry Foundations) | Phase 3 (Curve Support) |
|---|---|
| ✅ Include as type stub | ⏳ Implement geometry-only |
| ✅ Add to ribbon (disabled) | ✅ Enable + implement rendering |
| ✅ Low effort | ✅ Combined with spline work |
| ❌ Incomplete feature | ✅ Consistent UI (both geometry-only) |

**Recommendation:** Ellipse in **Phase 3** (with splines, both geometry-only together)

## File Organization

```
tickets/
  README.md                              (this file)
  phase-1-geometry-foundations.md        Polygon, Ellipse, Point
  phase-2-geometry-editing.md            Trim, Extend, Split, Offset
  phase-3-curve-support.md               Spline, Bezier, Edit Curve
  phase-4-utility-operations.md          Mirror, Copy, Paste, Move, Rotate
  phase-5-constraint-enhancements.md     Collinear, Block, etc.
  phase-6-solver-feedback.md             Status panel, Auto-dimension, etc.
```

## Acceptance Strategy

Each phase:
1. Opens a GitHub discussion or issue describing scope
2. Creates 1-2 focused PRs (grouping related features)
3. Includes unit tests + visual regression checks
4. Updates ribbon layout + localization strings
5. Closed PR = phase complete

No phase merges until all acceptance criteria are met.

## Questions to Resolve

- Should Mirror create constraint link (symmetry) or independent copy?
- For Offset: fixed distance or parametric (constrained to source)?
- Auto-Dimension: how aggressive with suggestions?
- Should Construction toggle be per-entity or batch operation?
