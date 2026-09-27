// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { Skill } from "./types";

export const parametricModeling: Skill = {
    name: "parametric-modeling",
    description:
        "How to build a PARAMETRIC body with run_parametric: the op catalog (sketch/editSketch/sketchInfo/extrude/revolve/fillet/chamfer/boolean/editFeature/features/construct/editConstruction/constructionInfo), sketch entity encodings, constraints, every sketch editing action, construction planes/axes/points, and how to pick edge indexes — load it before any run_parametric call",
    content: `Parametric modeling. run_parametric builds a feature TREE the user can re-edit; run_program builds throwaway geometry.

Which one: if the user should be able to change a dimension afterwards, roll the timeline back, or see the feature list — run_parametric. If it is a one-off shape, a measurement, or a geometry query — run_program. A parametric body is a long-lived asset: never feed it to run_program's edit-style ops (booleanCut/booleanFuse/fillet/pushPull/...), which DELETE their inputs and would destroy the feature history. To combine bodies, use run_parametric's own boolean op.

Ops run in order; later ops reference earlier ids. An op that EDITS a body (extrude with "body", fillet,
chamfer, boolean) also registers its own id as another name for that body, so any of them works as a
reference afterwards. Anywhere a reference is expected you may also pass the real node id of an existing
sketch, body or construction. One call is one undo step, and ANY failure rolls the whole program back —
nothing is left half-built.

- { op: "sketch", id, plane?, entities?, constraints?, actions?, name? }
  plane: "XY" (default) | "YZ" | "ZX"
       | { nodeId, faceIndex }             a planar face of a node; the sketch follows the face, and the
                                            face's boundary edges come in as reference externals
       | { construction, member? }         a construction plane (op id or node id); for a UCS, member
                                            "XY" (default) / "YZ" / "ZX" picks its plane. The sketch follows it.
  entities are in sketch (u, v) coordinates, mm; entity ids are the 1-based position in "entities":
    line    params [x1, y1, x2, y2]                 points 0=start 1=end
    circle  params [cx, cy, r]                      point 0=center
    arc     params [cx, cy, sx, sy, ex, ey]         center, start, end; sweeps counter-clockwise
                                                    points 0=center 1=start 2=end
    point   params [x, y]                           point 0
    ellipse params [cx, cy, ax, ay, bx, by]         center and two perpendicular axis ends
                                                    points 0=center 1=first axis end 2=second axis end
    spline  points [[u, v], ...] (curve order)      open interpolating spline; points 0=start 1=end
            (or params [sx, sy, ex, ey, ...interior])
  Any entity may carry construction: true (constrainable helper geometry, never part of a profile) and
  name: "..." (a name later refs in this call can use instead of the id).
  A closed profile needs its segments in perimeter order with the first point repeated as the last.
  The result (results[id]) reports the created entity and constraint ids, the names, dofs and solve status.
- { op: "editSketch", sketch, actions: [...] }   edits an existing sketch (or one built earlier in the call)
- { op: "sketchInfo", sketch, id? }   reads a sketch back: entities with their points, constraints with
  their datums (display units), externals (projected edges, ids -100 and below), dofs, solve status,
  conflicting/redundant constraint ids and the dimensions autoDimension would add. Read it before editing
  a sketch you did not build in this call.
- { op: "extrude", id, sketch, depth, symmetric?, startOffset?, body?, operation? }
  Without "body" it starts a new body. With "body" + "operation" (fuse/cut/common) the new prism
  combines with that body's shape. All closed profiles of the sketch are extruded.
- { op: "revolve", id, sketch, axis, angle? }
  axis: { point: {x,y,z}, direction: {x,y,z} } (world) | { construction, member? } (a construction axis;
  for a UCS member "X"/"Y"/"Z", default Z) | { nodeId, edgeIndex } (a linear edge of a node, e.g. a
  construction line drawn in a sketch). The two references follow their source when it changes.
  Always starts a new body — there is no join/cut revolve. angle is in degrees, default 360.
- { op: "fillet", id, body, edgeIndexes, radius }  /  { op: "chamfer", id, body, edgeIndexes, distance }
- { op: "boolean", id, body, operation, tools }   // operation: fuse | cut | common
  "tools" are node ids (or op ids). They are HIDDEN UNDER the body, never deleted — they stop
  rendering but stay reachable from the body's feature list.
- { op: "editFeature", body, featureId, action, ... }
  action: "setParameter" (key, value) | "rename" (value) | "suppress" (value) | "moveTo" (index) | "remove"
- { op: "features", body }   // reads the feature list: ids, names, parameters, errors
- { op: "construct", id, definition, name?, displaySize? }   // construction plane / axis / point / UCS
- { op: "editConstruction", node, definition?, name?, displaySize? }
- { op: "constructionInfo", node, id? }   // definition and resolved geometry

Constraints. A sketch without constraints is a fixed drawing: its coordinates are final and a later
dimension change cannot move anything. Add constraints when the sketch should stay solvable. Write them
the way the UI picks them — by entities and points — and the refs are derived for you:
  { kind: "Coincident", points: [{entity:1,point:1},{entity:2,point:0}] }
  { kind: "Horizontal" | "Vertical", entities: [1, 3] }            one per line (or two points)
  { kind: "Parallel" | "Perpendicular" | "EqualLength", entities: [1, 2] }
  { kind: "Tangent", entities: [line, circle] }                    any line/circle/arc pair but two lines
  { kind: "Equal", entities: [a, b] }                              two lines, circles or arcs
  { kind: "EqualRadius", entities: [circle1, circle2] }
  { kind: "PointOn", points: [p], entities: [line|circle|arc|"xAxis"|"yAxis"] }
  { kind: "Midpoint", points: [p], entities: [line] }
  { kind: "Symmetric", points: [p1, p2], entities: [line|"xAxis"|"yAxis"] }
  { kind: "Collinear", entities: [line1, line2, ...] (+ points) }
  { kind: "HorizontalAlign" | "VerticalAlign", points: [p1, p2] }
  { kind: "Fix", points: [p], datums?: [u, v] }                    pins a point (at its position if no datums)
  { kind: "Block", entities: [...] }                              freezes whole entities
  { kind: "EqualAngle", entities: [l1, l2, l3, l4] }               angle(l1,l2) = angle(l3,l4)
  Dimensions — "datum" is mm, degrees for Angle, a ratio for Scale; omit it to keep the current value:
  { kind: "Distance", points: [p1, p2], datum }   or   { kind: "Distance", entities: [line], datum }  (length)
  { kind: "HorizontalDistance" | "VerticalDistance", points: [p1, p2], datum }   signed: p2 − p1
  { kind: "PointLineDistance", points: [p], entities: [line], datum }   signed: + = left of the line direction
  { kind: "Radius", entities: [circle|arc], datum }
  { kind: "Angle", entities: [line1, line2], datum }
  { kind: "Scale", entities: [line1, line2], datum }    length(line1) = datum × length(line2)
  Entity keys: an id, a name given earlier in this call, or "origin" (point 0), "xAxis", "yAxis" (lines).
  "direction": [u, v] rotates the axis of Horizontal/Vertical/HorizontalDistance/VerticalDistance.
  Explicit { kind, refs: [{entity, point}, ...] } in the solver layout also works for every solver kind.
  "datum" may be an expression naming document variables (e.g. "width / 2"). "name" names the constraint
  for a later setDatum/remove in the same call. Arcs and ellipses carry an invisible structural constraint
  each (reported as structural by sketchInfo) — it cannot be removed.

Sketch actions (the "actions" of sketch/editSketch; all coordinates sketch (u, v), angles degrees; the
sketch re-solves after each action and a failing one rolls everything back):
- { action: "add", entities?, constraints? }              same specs as the sketch op
- { action: "rectangle", corners: [[u1,v1],[u2,v2]], name?, construction? }
    4 lines + coincident corners + H/V; names name.top/.right/.bottom/.left
- { action: "polygon", center, rim, sides, inscribed? = true, name? }
    regular polygon on a construction circle; rim is a vertex (inscribed) or an edge midpoint;
    names name.circle and name.0 … name.(sides−1)
- { action: "remove", entities?, constraints? }           removing an entity drops its constraints;
    external (projected) entities are removed the same way
- { action: "setDatum", constraint, value, index? }        change a dimension (display units or expression)
- { action: "setConstruction", entities, value? = true }   toggle construction geometry
- { action: "movePoint", entity, point, to: [u, v] }       drag a point; constraints stay satisfied
- { action: "trim", entity, at: [u, v] }                   removes the piece of the line/arc/circle around
    "at" between its neighbouring intersections (a circle needs two)
- { action: "split", entity, at: [u, v] }                  splits at "at" (snaps to a nearby intersection)
- { action: "extend", entity, to: boundary, end? = "end" } lengthens a line/arc to the boundary entity
- { action: "offset", entity, distance, name? }            parallel copy; + = left of a line / outward
- { action: "move", entities, delta: [du, dv], copy? }
- { action: "rotate", entities, center: [u, v], angle, copy? }
- { action: "mirror", entities, axis: line|"xAxis"|"yAxis", copy? = true }   copies get Symmetric constraints
- { action: "paste", from: sketch, entities: [ids], delta? }   copy entities (and the constraints wholly
    inside the selection) from another sketch
- { action: "projectEdges", nodeId, edgeIndexes, role? = "reference", names? }   brings coplanar edges of
    another node in as associative externals (they follow the source). "reference" edges are for
    constraints only, "profile" edges also close profiles. Only lines and circles/arcs lying in the
    sketch plane can be projected. Constraints on externals must be relational (Coincident, PointOn,
    Parallel, Tangent, Equal, Collinear, ...), never dimensions or Fix/Horizontal/Vertical.
- { action: "setExternalRole", entities, role }           switch externals between reference and profile
- { action: "autoConstrain", entities?, tolerance? = 0.001, angleTolerance? = 5 }
    the draw-time inference: coincident endpoints, points on curves/axes, near-H/V lines, tangency
- { action: "autoDimension" }   adds the size dimensions the sketch still lacks (lengths, radii)

Construction geometry (construct). definition = { kind, ...fields }; a construction is associative: it
re-evaluates when its sources change, and sketches/revolves referencing it follow. References:
  "XY" | "YZ" | "ZX"                        global origin planes
  { datum, member? }                        another construction (op id or node id); member picks a UCS
                                            plane "XY"/"YZ"/"ZX" or axis "X"/"Y"/"Z"
  { nodeId, face | edge | vertex: index }   a sub-shape of a node (findSubShapes order)
  { snap: <edge ref>, at: "start" | "end" | "middle" | "center" }
  { path: [<edge refs>], reversed?, branch? }
  { point: [x, y, z] }   { axis: { origin: [x,y,z], direction: [x,y,z] } }   fixed geometry
  { facePoint: { nodeId, face }, point: [x, y, z] }   a point kept on a face
Kinds (plane refs accept faces, construction planes and origin planes; axis refs accept linear edges,
construction axes and fixed axes; point refs accept vertices, snaps, construction points and fixed points):
  plane-offset        { source: plane, distance, toPoint?: point }          (toPoint replaces distance)
  plane-midplane      { first: plane, second: plane, solution?: 0 | 1 }     (bisector choice if they cross)
  plane-angle         { axis, baseline: plane, angle (deg), offset? }
  plane-two-edges     { first: edge, second: edge, offset? }
  plane-three-points  { first, second, third: point, offset? }
  plane-along-path    { path, position, offset? }       normal to the path
  plane-tangent       { face, contact: point, offset? }
  plane-perpendicular { source: plane|face, contact: point, orientation: axis, distance? }
  axis-analytic       { face }                          axis of a cylinder, cone or torus
  axis-normal         { source: plane|face, contact: point }
  axis-two-planes     { first: plane, second: plane }
  axis-two-points     { first: point, second: point }
  axis-edge           { edge }
  point-vertex        { vertex }
  point-two-edges     { first: edge, second: edge, solution? }
  point-three-planes  { first, second, third: plane }
  point-center        { source: circle edge | sphere/torus face }
  point-edge-plane    { edge, plane }
  point-along-path    { path, position }
  ucs                 { origin: point, first: axis, second: axis, firstAxis? = "X", secondAxis? = "Y",
                        reverseFirst?, reverseSecond? }
  position (along-path kinds): { kind: "distance", value } (mm) | { kind: "normalized", value } (0..1)
                               | { kind: "to-point", point }
The construct result reports the resolved geometry (plane origin/normal/xvec, axis origin/direction, point).

Variables. Every feature parameter (extrude depth/startOffset, revolve angle, fillet radius,
chamfer distance) and every sketch datum takes either a number or an EXPRESSION STRING, so "width * 2"
follows the document variable width instead of freezing a number into the feature. Create them with
document_variables first — {"action":"set","variables":[{"name":"width","type":"length","expression":"40"}]}
— then name them in the ops. A variable may reference only the ones declared ABOVE it. This is
what makes the model parametric rather than merely feature-based: when the user changes width,
every feature that names it rebuilds. Reach for a variable when a dimension is one the user is
likely to come back to, and a plain number when it is incidental.

Selecting edges for fillet/chamfer: "edgeIndexes" index the body's current edge list (findSubShapes
order). Get them with a run_program query on the body node first — shape.findSubShapes(target: "b1",
args: { subshapeType: "edge" }) returns refs like e#3, and that number IS the index to pass.
Identify the edges you want by geometry (edge.ends, edge.length) before picking.

Example — a 40x30 plate, 20 tall, then round one top edge R3:
 [ { op: "sketch", id: "s1", plane: "XY", name: "Plate outline", entities: [
       { type: "line", params: [0, 0, 40, 0] },
       { type: "line", params: [40, 0, 40, 30] },
       { type: "line", params: [40, 30, 0, 30] },
       { type: "line", params: [0, 30, 0, 0] } ] },
   { op: "extrude", id: "b1", sketch: "s1", depth: 20, name: "Plate" } ]
Then run a run_program query on "b1" to find which edge index is the top front edge, and:
 [ { op: "fillet", id: "f1", body: "b1", edgeIndexes: [<that index>], radius: 3 } ]

Example — a fully dimensioned slot plate driven by a variable:
 [ { op: "sketch", id: "s1", actions: [
       { action: "rectangle", corners: [[0, 0], [60, 40]], name: "r" },
       { action: "add", entities: [{ type: "circle", params: [30, 20, 5], name: "hole" }],
         constraints: [
           { kind: "Coincident", points: [{ entity: "r.bottom", point: 1 }, { entity: "origin", point: 0 }] },
           { kind: "Distance", entities: ["r.bottom"], datum: "width" },
           { kind: "Distance", entities: ["r.left"], datum: 40 },
           { kind: "Radius", entities: ["hole"], datum: 5 } ] } ] },
   { op: "extrude", id: "b1", sketch: "s1", depth: 10 } ]

Example — sketch on an offset plane, then revolve around a construction axis:
 [ { op: "construct", id: "p1", definition: { kind: "plane-offset", source: "XY", distance: 25 } },
   { op: "construct", id: "a1", definition: { kind: "axis-two-points", first: { point: [0,0,0] }, second: { point: [0,1,0] } } },
   { op: "sketch", id: "s1", plane: { construction: "p1" }, entities: [ ... ] },
   { op: "revolve", id: "b1", sketch: "s1", axis: { construction: "a1" } } ]

Limits and recovery:
- Only whole sketches are extruded; individual profiles of a sketch cannot be selected (a hole in a
  sketch is a hole, not a separate extrusion). To cut a pocket, extrude a second sketch with
  operation "cut", or cut with a separate body via the boolean op.
- A sketch consumed by extrude/revolve is hidden (visible = false). You can still reference it by id,
  but select_nodes/capture_screenshot will not find it.
- An editSketch closes the sketch the user has open for editing (their work is committed first).
- Failures are reported by the op index, e.g. 'op 2 ("fillet") failed: feature "Fillet" (…) failed: …',
  and inside a sketch by the action index ('sketch action 3 ("trim") failed: …'). A sketch whose
  constraints cannot be satisfied fails with the conflicting/redundant constraint ids.
  Read the message, change the value, and re-run the whole program — the failed call rolled back
  completely, so re-running is safe and costs nothing. Do not re-run the identical program.
- A feature failure also raises one app error toast before the rollback; that toast is not a signal
  to retry — the returned error text is the authoritative one.
- After a successful build, verify like any other model: select_nodes the body, fit_content,
  capture_screenshot. Use the "features" op to read back the feature ids you will need for editFeature.`,
};
