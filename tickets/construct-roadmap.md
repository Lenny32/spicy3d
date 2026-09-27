# Construct Panel Enhancement Roadmap

Expand Spicy3D's Construct panel from working-plane controls to persistent, associative reference geometry. Status: planned.

## Current State

`packages/builder/src/ribbon.ts` exposes Set, Toggle, Align, and Section. The implementations in `packages/app/src/commands/workingPlane.ts` change `view.workplane`; they do not create independently editable construction objects. Section already computes a plane perpendicular to an edge at a picked point. Align samples a face normal at fixed surface parameters.

Generic Point and Ref Segment commands provide useful helpers, but do not retain the defining vertex or two-point dependency as construction features. Sketch construction geometry is a separate capability from the 3D reference geometry covered here.

## Tickets and Order

| Ticket | Scope | Depends on | Priority |
|---|---|---|---|
| [CONSTRUCT-01](construct-01-foundation.md) | Persistent reference objects, dependencies, consumers, UI | None | P1 |
| [CONSTRUCT-02](construct-02-basic-planes.md) | Offset Plane, Midplane, Plane At Angle | 01 | P1 |
| [CONSTRUCT-03](construct-03-reference-planes.md) | Plane Through Two Edges, Plane Through Three Points, Plane Along Path | 01 | P1 |
| [CONSTRUCT-04](construct-04-surface-planes.md) | Tangent Plane, Perpendicular Plane | 01 | P2 |
| [CONSTRUCT-05](construct-05-axes.md) | All five construction-axis tools | 01 | P2 |
| [CONSTRUCT-06](construct-06-points.md) | All six construction-point tools | 01 | P2 |
| [CONSTRUCT-07](construct-07-coordinate-systems.md) | User Coordinate System | 01 | P3 |

Implement 01 first, then 02 and 03. Tickets 04-06 can follow independently once the common object and reference contracts are stable. Plane commands must accept existing linear edges and vertices without requiring the axis and point creation tickets first. Each grouped ticket can be split into focused implementation PRs.

## Coverage and Definition of Done

The tickets cover the 20 tools in [Autodesk's current Construct reference](https://help.autodesk.com/cloudhelp/ENU/Fusion-Model/files/SLD-CONSTRUCT-TOOLS.htm): one UCS, eight planes, five axes, and six points. Names and capabilities are based on the comparison made on 2026-09-24. Older menu names such as Plane Tangent to Face at Point and Axis Perpendicular at Point are addressed by the surface-plane and axis tickets.

All construction tools must create editable document objects, retain source dependencies, update downstream consumers, support save/load and undo/redo, and report invalid or lost references. A command that only assigns the current working plane is not complete.

For each implementation, run focused Rstest behavior tests, relevant existing regression tests, and manually verify picking, preview, cancellation, and property editing. Add localized command labels and errors. Guard invalid kernel queries before calling WASM and return `Result.err` for expected failures.

Existing sketch roadmap tickets remain separate. Construction patterns and mirrors, assembly constraints, and manufacturing workflows are outside this tool-list scope.
