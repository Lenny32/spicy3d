// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { Skill } from "./types";

export const parametricModeling: Skill = {
    name: "parametric-modeling",
    description:
        "How to build a PARAMETRIC body with run_parametric: the op catalog (sketch/editSketch/sketchInfo/extrude/revolve/loft/sweep/projection/faceSweep/editFaceSweep/fillet/chamfer/thicken/boolean/editFeature/features/construct/editConstruction/constructionInfo), sketch entity encodings, constraints, every sketch editing action, construction planes/axes/points, and how to pick edge indexes — load it before any run_parametric call",
    content: `Parametric modeling. run_parametric builds a feature TREE the user can re-edit; run_program builds throwaway geometry.

Long sketch-edit batches: use start_parametric_job with the same { ops, responseMode? } payload (optional timeoutMs up to 600000). It returns a jobId immediately; get_parametric_job polls its state/result, get_rebuild_status shows pending rebuilds, and cancel_parametric_job rolls back the job. Consecutive editSketch ops coalesce downstream rebuilds; an intervening query/feature operation is a geometry boundary. Rebuilds yield between uncached features, but individual synchronous kernel calls and topology-dependent operations can still block until they return. run_parametric also batches consecutive sketch edits and yields during their rebuilds, returning its result only after completion.

Which one: if the user should be able to change a dimension afterwards, roll the timeline back, or see the feature list — run_parametric. If it is a one-off shape, a measurement, or a geometry query — run_program. A parametric body is a long-lived asset: never feed it to run_program's edit-style ops (booleanCut/booleanFuse/fillet/pushPull/...), which DELETE their inputs and would destroy the feature history. To combine bodies, use run_parametric's own boolean op.

Validity: bounded run_program booleans and tracked worker booleans (including extrude operations during asynchronous rebuilds) validate result topology and every solid component's volume. Negative or non-finite component volumes always fail; a positive compound total is insufficient. Only when result topology is invalid are operands analyzed: an already invalid operand allows the result to be accepted, with a parametric warning naming the input/tool. Valid operands producing an invalid result still fail. Fillet/chamfer and loft validate inputs and results. Kernel/validity errors name the operation and feature step; user-input errors keep their wording. Worker checks use deadlines, not a guarantee against all self-intersections. Synchronous parametric boolean compatibility paths use the same result and invalid-operand checks without a face-count cutoff, and can still block.

Ops run in order; later ops reference earlier ids. An op that EDITS a body (extrude with "body", fillet,
chamfer, boolean) also registers its own id as another name for that body, so any of them works as a
reference afterwards. Anywhere a reference is expected you may also pass the real node id of an existing
sketch, body or construction. One call is one undo step, and ANY failure rolls the whole program back —
nothing is left half-built.

For small edits on large bodies, pass { responseMode: "compact", ops: [...] }. The default "full"
returns every touched body's feature list. Compact bodies.features includes only feature rows created
or directly edited in this call (final state, with reusable feature ids); removedFeatureIds reports
removed rows. featureCount gives the total, status is "ok" or "error", and diagnostics retains ALL
current feature errors/warnings, including untouched rows. created, consumed and results remain
available; explicit features, sketchInfo and constructionInfo ops always return their full reads.

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
    spline  points [[u, v], ...] (curve order)      uniform Catmull-Rom through the points, one cubic edge
            (or params [sx, sy, ex, ey, ...interior]) per pair of neighbouring points; always OPEN (a closed
                                                    one is refused); points 0=start 1=end; interior fixed
    bspline points [[u, v], ...] (curve order)      ONE interpolating B-spline edge through every point;
            (or params [x0, y0, x1, y1, ...])       parametrization: "chord" (default: no overshoot on
                                                    uneven spacing) | "centripetal" | "uniform";
                                                    periodic: true = closed C2 curve — do NOT repeat the
                                                    first point; points i = fit point i (all constrainable).
                                                    Prefer it for free-form outlines: one edge offsets,
                                                    lofts and booleans far better than many.
                                                    PointOn [point] + [bspline] slides a point on it;
                                                    Tangent [line, bspline] = the line along its end tangent
  Any entity may carry construction: true (constrainable helper geometry, never part of a profile) and
  name: "..." (a name later refs in this call can use instead of the id).
  Control-mode bspline uses poles:[[u,v],...] instead of points/params/parametrization. Optional
  degree defaults to min(3,poleCount-1); distinct strictly increasing knots and multiplicities must
  be supplied together (or use generated defaults). Open ends are clamped (degree+1); initial
  periodic support uses uniform knots and multiplicity one. Optional weights are one positive
  finite value per pole. The curve generally does not pass through interior poles. movePoint point
  indices address poles in this mode. Weighted curves require the native B-spline kernel binding;
  older kernels report an explicit error. Fit-point bsplines are unchanged.
  A closed profile of lines/arcs needs segments in perimeter order, each starting where the previous
  one ends (the last one ending on the first one's start); a periodic bspline closes on its own.
  The result (results[id]) reports the created entity and constraint ids, the names, dofs and solve status.
- { op: "editSketch", sketch, actions: [...] }   edits an existing sketch (or one built earlier in the call)
- { op: "sketchInfo", sketch, id? }   reads a sketch back: entities with their points, constraints with
  their datums (display units), angleSide (+1 counterclockwise, -1 clockwise) and effectiveDatum
  (the signed angle in degrees used by the solver), externals (projected edges, ids -100 and below), dofs, solve status,
  conflicting/redundant constraint ids and the dimensions autoDimension would add. Read it before editing
  a sketch you did not build in this call.
- { op: "extrude", id, sketch, depth, symmetric?, startOffset?, startFace?, body?, operation?, extent?, secondExtent? }
  Without "body" it starts a new body. With "body" + "operation" (fuse/cut/common) the new prism
  combines with that body's shape. All closed profiles of the sketch are extruded.
  extent: "distance" (default, by depth) | "throughAll" (through the whole body; direction = sign of
  depth, reversed by itself when nothing lies ahead; needs body + operation) |
  { type: "toObject", face: { nodeId, faceIndex }, offset? } (up to a face of any node, planar or curved;
  it follows the face on rebuild — a hole cut to a block's bottom face stays through when the block
  grows). With symmetric, extent applies to both sides; secondExtent gives the second side its own
  (a to-object extent cannot be mirrored).
  "next" | {type:"next",offset?} automatically chooses the nearest full-coverage face in eligible
  candidate bodies captured when authored. Rebuilds may select another candidate after upstream edits.
  Candidate IDs are a fixed search universe; hide unrelated bodies before authoring. Editing can
  refresh that snapshot. Depth sign chooses direction; Next never reverses itself. Offset translates
  the selected end along that direction after selection. Tied, crossing, partial/piecewise or absent
  boundaries fail explicitly. One complete face per profile is the initial supported boundary.
  startFace: {nodeId, faceIndex} selects an associative starting surface, including curved walls.
  startOffset moves that surface along the sketch normal; expressions are supported. With distance,
  depth separates the surface and its exact translated end cap. Upstream edits rebuild both caps.
  The profile must project completely onto the selected surface; incomplete or ambiguous boundaries
  fail explicitly. Omit startFace to retain the sketch-plane start.
- { op: "revolve", id, sketch, axis, angle? }
  axis: { point: {x,y,z}, direction: {x,y,z} } (world) | { construction, member? } (a construction axis;
  for a UCS member "X"/"Y"/"Z", default Z) | { nodeId, edgeIndex } (a linear edge of a node, e.g. a
  construction line drawn in a sketch). The two references follow their source when it changes.
  Always starts a new body — there is no join/cut revolve. angle is in degrees, default 360.
- { op: "loft", id, sections, solid?, ruled?, continuity?, guided? }
  sections: two or more sketch ids in loft order, each sketch holding ONE closed profile without holes,
  or ONE connected, non-branching, non-self-intersecting OPEN wire when solid: false. Ordinary lofts
  accept open curves (lines, arcs, splines); guided lofts still require closed profiles. All sections
  must be all open or all closed. Open curves produce an uncapped skin; use thicken with no
  openFaceIndexes to make a solid wall, then boolean or extrude operation "intersect" to trim it.
  (e.g. a rectangle on XY, a circle on an offset plane); consecutive sections must not share a plane.
  solid (default true) caps the ends, false leaves an open surface; ruled: true makes straight faces
  between sections (default smooth, continuity "c2"). The loft follows every section sketch when it
  changes. Always starts a new body — there is no join/cut loft; combine it with the boolean op.
  guided: { spine: { nodeId, edgeIndexes? , edgeRefs? }, boundary: { nodeId, edgeIndexes?, edgeRefs? } }
  references an open main spine and one curve that genuinely controls the side boundary. Each path
  uses exactly one of whole-edge indexes or persistent references returned by edges, with 1–128
  pieces. Guided lofts support 2–16 closed planar sections and smooth C2 only; ruled/C0/C1 fail.
  Keep sections in their authored planes: both paths must meet them once in strict station order,
  and the complete boundary must lie on generated side faces. Interior guides are rejected.
- { op: "editLoft", body, featureId, sections?, solid?, ruled?, continuity?, guided? }
  changes the loft inputs/options as one undo step. guided:null clears both paths and restores
  ordinary lofting; replacing the guided group must supply both spine and boundary.
- { op: "edges", body, id?, index?, edgeIndexes?, selector?, expectedCount? } queries persistent body-local edge references. Omit indexes for all edges.
- { op: "faces", body, id?, index?, selector?, expectedCount? } queries faces at the final shape or entering a feature index.
  selector predicates intersect: faceIds:[tracked ids], featureIds:[actual feature ids, from features],
  containsPoint:{x,y,z} (point on the trimmed face, body-local mm), largest:true, tolerance (default 1e-6 mm).
  Feature origins include surviving split/merged descendants. largest applies after the other filters;
  equal-area ties remain ambiguous. Reports contain index, area and reference:{nodeId,faceId}.
  Reuse reference directly in extent.face, secondExtent.face or startFace across calls and added bosses.
  These picks also accept {nodeId,selector:{...}} or the existing {nodeId,faceIndex}; exactly one mode.
  Extrusion requires one match; missing ids and split-id ambiguity fail rather than picking by order.
  A selector runs once during authoring; the resulting feature follows the existing tracked face reference.
  Example: {op:"faces",body:"shell",selector:{featureIds:["<shell-feature-id>"],largest:true},expectedCount:1}.
  Copy results.faces.faces[0].reference into a later {type:"toObject",face:reference,offset:"boss_embed"}.
  Re-query or add containsPoint if that tracked id has split into multiple faces.

- { op: "faceSweep", id, body, section:{sketchId,profileIndex?}, path:{nodeId,edgeIndexes:[...]}, support:{nodeId,faceIndex}, operation:"join"|"cut", roundCorner? }
  Adds an editable rib or groove to the EXISTING body. One hole-free profile must be authored at
  the path start, perpendicular to its tangent; this operation does not relocate a misplaced profile.
  Every ordered whole path edge must lie on the full trimmed support face. Uses the true support-normal
  Darboux frame, not a free-space sweep. Nearby/off-surface paths and paths crossing holes are refused.
  Section/path/support transforms are resolved into the host's local coordinates at the feature timeline.
  Requires actual reusable path and support ancestry: untracked/path-ref logical tokens are unsupported.
  The result must attach/intersect, change material, and form one valid connected solid. Curved walls
  are supported. Upstream edits follow actual tracked ancestry; moved starts require compatible authored
  section placement. The source sketches stay separate; the profile is hidden when creation succeeds.
- { op: "editFaceSweep", body, featureId, section?, path?, support?, operation?, roundCorner? }
  Re-picks or changes a face-sweep feature. Omitted fields keep their previous value. Invalid picks fail
  the whole call and leave the previous committed model and undo position intact.

- { op: "fillet", id, body, index?, edgeIndexes?, edgeRefs?, radius }  /  { op: "chamfer", id, body, index?, edgeIndexes?, edgeRefs?, distance }
  Fillets also accept radiusLaw: [{position:0,radius:"noseRadius"}, {position:1,radius:"tailRadius"}].
  Use 2–64 increasing samples with endpoints 0 and 1; radii are positive lengths/expressions.
  Positions are normalized selected-edge arc length in its natural curve direction, not world-space
  anchors: upstream parameterization reversal can exchange the physical ends. OCCT interpolates
  smoothly and propagates along tangent contours; select one edge per contour, and use equal law
  endpoint radii on a closed contour. BREP validation can reject a law that cannot fit the shape.
  editFeature action "setRadiusLaw" replaces the whole law; omit radiusLaw to restore the saved
  constant radius. setParameter keys radiusLaw.0, radiusLaw.1, ... edit individual radius expressions.
Guided lofts use a deferred native analyzer plus bounded worker validation when supported by
the kernel. Detected self-intersection is an error; timeout/unavailable-worker verdicts accept
with runtime warnings. Synchronous preview/program evaluation has a skipped-check warning.
Older kernels retain the original synchronous guided-loft analyzer. Construction and section/
guide coverage booleans remain synchronous.

- { op: "thicken", id, body, thickness, joinType?, mode?, tolerant?, openFaceIndexes? }
  tolerant:true opts into a material envelope: closed spheres/ring tori can consume an inward
  cavity entirely. Ordinary arc thickening is tried first; intersection fallback is verified only
  for analytic solids with only vertical-edge fillets. Free-form collapse and open skins are refused.
  joinType/mode are ignored. Programs await the bounded worker with a 30 s deadline.
  Intersection trimming retains the many-face guard; an older kernel reports unavailable.
  A live shell / thicken of the body's current shape. thickness is signed (a number or an expression,
  e.g. "wall_t" — the wall rebuilds when the variable changes): positive grows along the face normals
  (outward for a solid), negative inward; never zero. A SOLID with openFaceIndexes (face indexes, found
  like edge indexes) is shelled open at those faces; a solid without them is hollowed with a closed
  inner void. An OPEN shell or surface (an open loft: solid: false) becomes a solid wall; openFaceIndexes
  does not apply to it, nor do joinType ("arc" default | "intersection") and mode ("skin" | "pipe"),
  which shape a solid's walls. Faces the thicken leaves where they were keep their ids, so a fillet
  after it survives a thickness edit.
  Offset failures can name a likely limiting input face index, position (body coordinates, mm),
  and sampled curvature radius. Try a smaller absolute wall_t or smooth that region; the sampled
  radius is a local estimate, NOT a guaranteed maximum successful thickness. No reported limit
  does not rule out a narrow crease or collisions between distant offset walls. skin/pipe and
  arc/intersection do not provide a self-intersection-trimming envelope mode.
  Every thicken wall is checked for self-intersection in the bounded worker (30 s) before the next
  op runs: a crossing wall fails at its thicken op ("Thicken result intersects itself", with the
  output faces, a point on each crossing and its extent, and the sharpest input curvature radius
  against |thickness|), and a timeout fails it too (result unknown). Programs containing a thicken
  therefore await the worker on every op touching that document.
- { op: "boolean", id, body, operation, tools }   // operation: fuse | cut | common
  "tools" are node ids (or op ids). They are HIDDEN UNDER the body, never deleted — they stop
  rendering but stay reachable from the body's feature list.
- { op: "editFeature", body, featureId, action, ... }
  action: "setParameter" (key, value) | "setRadiusLaw" (radiusLaw?, fillet only) | "rename" (value) | "suppress" (value) | "moveTo" (index) | "remove"
  moveTo across a sketch or construction timeline anchor is refused.
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
  { kind: "Angle", entities: [line1, line2], datum }               signed from line1 to line2, CCW positive; angleSide preserves the chosen side
  Re-sending the same datum expression keeps a clockwise side; sketchInfo reports effectiveDatum.
  { kind: "Scale", entities: [line1, line2], datum }    length(line1) = datum × length(line2)
  Entity keys: an id, a name given earlier in this call, or "origin" (point 0), "xAxis", "yAxis" (lines).
  Point indexes are zero-based; point: -1 selects the last point in constraints (points or refs)
  and movePoint. For an open B-spline, point: 0 and point: -1 are its start and end; for a periodic
  B-spline, -1 is the last fit point/control pole (a periodic curve has no endpoints).
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
- { action: "setBSpline", entity, poles?, degree?, knots?, multiplicities?, weights?, periodic? }
  edits a control-mode B-spline atomically, preserving entity id and pole-index references. Degree
  changes generate default knots unless knots/multiplicities are explicitly supplied together.
- { action: "movePoint", entity, point, to: [u, v] }       drag a point; constraints stay satisfied
- { action: "trim", entity, at: [u, v] }                   removes the piece of the line/arc/circle around
    "at" between its neighbouring intersections (a circle needs two)
- { action: "split", entity, at: [u, v] }                  splits at "at" (snaps to a nearby intersection)
- { action: "extend", entity, to: boundary, end? = "end" } lengthens a line/arc to the boundary entity
- { action: "offset", entity, distance, associative?, name? }
  Parallel copy; + = left of a line / outward.
  Supports lines, arcs, circles and open/periodic B-splines (fit or control mode). For open B-splines
  + is left along the curve; for periodic B-splines + is outward regardless of winding. B-splines
  are approximated to 0.001 mm at checked samples, with at most 512 fit points; collapsed, inverted
  or crossing offsets are refused. distance takes mm or a length expression. Default associative:false evaluates ONCE.
  associative:true keeps an Offset constraint linking source and target; source edits and variable
  changes regenerate on fine solve / commit, not each pointer frame. Keep the source as construction
  geometry when only the offset outline should contribute to a loft. Removing the source or relation
  detaches the target. To close an open offset profile, Coincident may join a target endpoint
  to a movable line/arc endpoint: the connector follows the frozen target on fine solve.
  Use {entity: "offsetName", point: -1} for the target's end without reading its fit-point array.
  Target centers/interior B-spline points, other target constraints, and connectors that are
  offset sources/targets, Blocked or Fixed at the joined endpoint are refused; detach first.
  Offset chains are refused; detach first to edit a target. Move/rotate in place keep the relation. Mirror/copy/paste detach transformed relations.
  Pasted sources are snapshots of the other sketch, not cross-sketch links.
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
  Lengths (distance, offset, a "distance" position's value) and angles (angle) take a number or an
  EXPRESSION STRING of document variables, like feature parameters: distance: "sec_x_1" or
  "sec_x_1 * 2 + 5 mm" — the construction (and every sketch on it) follows when the variable changes.
  A bad expression fails the op naming the field.
The construct result reports the resolved geometry (plane origin/normal/xvec, axis origin/direction, point).

Variables. Every feature parameter (extrude depth/startOffset, revolve angle, fillet radius,
chamfer distance, thicken thickness), every construction length/angle and every sketch datum takes either a number or
an EXPRESSION STRING, so "width * 2" follows the document variable width instead of freezing a number
into the feature. Create them with
document_variables first — {"action":"set","variables":[{"name":"width","type":"length","expression":"40"}]}
— then name them in the ops. A variable may reference only the ones declared ABOVE it. This is
what makes the model parametric rather than merely feature-based: when the user changes width,
every feature that names it rebuilds. Reach for a variable when a dimension is one the user is
likely to come back to, and a plain number when it is incidental. run_program's numeric args accept
the same expressions, but evaluate them ONCE: its nodes keep the number and do not follow the variable.

Selecting edges for fillet/chamfer: query run_parametric [{ op: "edges", body: "b1", id: "picks" }].
results.picks = { bodyId, edges: [{ index, reference: { bodyId, edge } }, ...] }. The edge fingerprint
contains local line endpoints, circle center/axis/radius, or other curve midpoint/length, plus its
tracked edgeId when available. Select by geometry and retain each whole reference object. A later
call accepts [{ op: "fillet", id: "f1", body: "b1", edgeRefs: [<reference>], radius: 3 }].
Use exactly one of edgeRefs or edgeIndexes, with at least one selection. References belong to one
body: another body is refused. Existing tracked-id/fingerprint matching follows upstream rebuilds,
including edge reordering; a removed or ambiguous edge fails. Already split pieces remain narrow.
References are plain JSON and may be reused across calls; query again when intentionally selecting
new topology. These differ from run_program's subshape refs (including grouped refs): those identify
positions in a current shape, not persistent parametric selections. edgeIndexes remain supported
for immediate picks, but must be queried again after upstream edits.

Rule-based picks: edges accepts selector instead of edgeIndexes; every supplied field intersects.
- featureIds: [featureId, ...] selects edges first born at those features, including surviving split/
  merged descendants through boolean ancestry. Use feature ids from features, not feature names.
- adjoiningFaces: { all?: [face, ...], any?: [face, ...], exact?: [face, ...] } selects incident face
  sets. A face is a current face index or its tracked face id; all requires every selected face,
  any requires at least one, exact requires the complete adjacent set. Shared face ids expand to
  all current pieces. Unknown face ids/indexes fail instead of returning a misleading empty set.
- outlineOfFaces: [face, ...] selects any given face's outer-wire edges, excluding hole loops.
- curves: [<persistent reference>, ...] first resolves each saved pick against the current body.
  Selects edges sharing its supporting infinite line or circle; free-form curves use tracked
  ancestry. Missing/ambiguous saved curves fail. Already split picks choose the current supporting
  curve, so several collinear pieces may intentionally be returned.
- geometry: { kind?: "line"|"circle"|"other", radius?: number, cylinderRadius?: number,
  elevation?: { axis?: "x"|"y"|"z", value } }. radius is a circular EDGE radius; cylinderRadius
  requires an adjacent analytic CYLINDER of that radius (a sphere/torus does not qualify). elevation
  requires the ENTIRE edge at that coordinate, default axis z. Coordinates are body-local mm.
- tolerance?: positive mm, default 0.000001, governs geometry equality.
Example: { op: "edges", body: "b1", selector: { geometry: { kind: "circle", cylinderRadius: 3,
  elevation: { value: 20 } } }, expectedCount: 1 } selects a radius-3 bore's top rim.
A selector query returns selection { status, count, message } alongside candidate stable refs.
No matches = empty. expectedCount (positive integer) requires that many matches; a nonzero mismatch
is ambiguous. Without expectedCount, multiple matches are an intentional set. Inspect/refine an
ambiguous query before using its references; the query itself applies no feature or selection edit.
Selector queries skip edges with no capturable curve (e.g. sphere poles) and list their indexes/reasons
in unselectableEdges. An explicit raw index still fails if its curve cannot be captured.

Example — a 40x30 plate, 20 tall, then round one top edge R3:
 [ { op: "sketch", id: "s1", plane: "XY", name: "Plate outline", entities: [
       { type: "line", params: [0, 0, 40, 0] },
       { type: "line", params: [40, 0, 40, 30] },
       { type: "line", params: [40, 30, 0, 30] },
       { type: "line", params: [0, 30, 0, 0] } ] },
   { op: "extrude", id: "b1", sketch: "s1", depth: 20, name: "Plate" } ]
Then run a run_program query on "b1" to find which edge index is the top front edge, and:
 [ { op: "fillet", id: "f1", body: "b1", edgeIndexes: [<that index>], radius: 3 } ]

Sweep along a connected 3D path:
- { op: "sweep", id, section: { sketchId, profileIndex? },
    path: { nodeId, edgeIndexes: [ ...ordered whole-edge topology indexes ] }, solid?, roundCorner? }
  creates a new body from one hole-free sketch profile. Omit profileIndex only for a sole profile.
  Keep the authored profile at the path start, perpendicular to its initial tangent. solid defaults
  true; roundCorner defaults false. Connected lines and curves, including closed paths, are supported.
  Stable sketch/entity or tracked-body ancestry follows upstream edits. Untracked source picks use
  authored logical tokens with geometric matching; missing, ambiguous or incompatible edits fail.
- { op: "editSweep", body, featureId, section?, path?, solid?, roundCorner? } replaces these inputs
  atomically and rolls back on an invalid rebuild. The interactive feature editor previews and re-picks
  the same inputs; Cancel leaves the feature untouched, and Confirm produces one undo step.

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

Example — loft a square base into a circle 30 mm above it:
 [ { op: "construct", id: "p1", definition: { kind: "plane-offset", source: "XY", distance: 30 } },
   { op: "sketch", id: "s1", entities: [ { type: "line", params: [-10,-10,10,-10] }, { type: "line", params: [10,-10,10,10] },
       { type: "line", params: [10,10,-10,10] }, { type: "line", params: [-10,10,-10,-10] } ] },
   { op: "sketch", id: "s2", plane: { construction: "p1" }, entities: [ { type: "circle", params: [0,0,6] } ] },
   { op: "loft", id: "b1", sections: ["s1", "s2"] } ]

Example — the same skin as an open loft, thickened into a 1.5 mm wall driven by a variable
(create the variable first with document_variables: name "wall_t", type "length", expression "1.5"):
 [ ...the construct and the two sketches above...,
   { op: "loft", id: "b1", sections: ["s1", "s2"], solid: false },
   { op: "thicken", id: "b1", body: "b1", thickness: "wall_t" } ]

Example — an editable skin through open section curves, then a solid wall (no closing lines or caps):
 [ { op: "construct", id: "p1", definition: { kind: "plane-offset", source: "XY", distance: 20 } },
   { op: "sketch", id: "s1", entities: [ { type: "bspline", points: [[-10,0],[0,3],[10,0]] } ] },
   { op: "sketch", id: "s2", plane: { construction: "p1" }, entities: [ { type: "bspline", points: [[-8,0],[0,4],[8,0]] } ] },
   { op: "loft", id: "skin", sections: ["s1", "s2"], solid: false },
   { op: "thicken", id: "wall", body: "skin", thickness: 1 } ]

Fillet/chamfer creation accepts optional index, a zero-based insertion position in the
feature list (0..feature count; omitted appends). Edge selection resolves against the
shape entering that position. Query { op: "edges", body, index: 1, selector: ... } for
edges after feature 0, then use { op: "fillet", id, body, index: 1, edgeRefs, radius }.
This can round a loft before downstream cuts make its final faces unsuitable for filleting.
The later chain rebuilds in the same undo step; a failure rolls back the whole program.
Persistent references picked on the final body are also allowed when they resolve
unambiguously at the insertion position. Edges created later cannot be selected there.

Limits and recovery:
- Only whole sketches are extruded; individual profiles of a sketch cannot be selected (a hole in a
  sketch is a hole, not a separate extrusion). To cut a pocket, extrude a second sketch with
  operation "cut", or cut with a separate body via the boolean op.
- A sketch consumed by extrude/revolve/loft is hidden (visible = false). You can still reference it by id,
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
