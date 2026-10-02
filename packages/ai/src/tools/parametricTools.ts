// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    AutosaveHolds,
    DocumentMutations,
    DocumentRebuilds,
    type IDocument,
    Transaction,
} from "@spicy3d/core";
import type { ParametricOp, ProgramResult } from "@spicy3d/parametric";
import type { Tool } from "../llm/types";
import type { ProgramProgress } from "./capabilityEngine";
import { requireDocument } from "./documentContext";
import { noteOpDuration } from "./opBudget";
import { holdDocumentReadSnapshot } from "./readTools";

/**
 * Loads the parametric module on first use. It must not be imported at module scope:
 * `buildTools()` is called by `buildSystemPrompt()` on every request, so a static import
 * would pull the whole parametric chunk — and with it the wasm-backed constraint solver —
 * into the resident prompt path.
 */
let parametricModule: Promise<typeof import("@spicy3d/parametric")> | undefined;

function loadParametric(): Promise<typeof import("@spicy3d/parametric")> {
    parametricModule ??= import("@spicy3d/parametric");
    return parametricModule;
}

/** Ops that run the sketch constraint solver, which needs its wasm module loaded first. */
const SOLVER_OPS = new Set(["sketch", "editSketch", "sketchInfo"]);

const XYZ_SCHEMA = { type: "object", properties: { x: {}, y: {}, z: {} }, required: ["x", "y", "z"] };

const POINT_REF_SCHEMA = {
    type: "object",
    properties: {
        entity: {
            description:
                'Entity id (number), a name given earlier in this call, or "origin" / "xAxis" / "yAxis"',
        },
        point: { type: "number", description: "Point index within the entity" },
    },
    required: ["entity", "point"],
};

const ENTITY_SCHEMA = {
    type: "object",
    properties: {
        type: { type: "string", enum: ["line", "circle", "arc", "point", "ellipse", "spline", "bspline"] },
        params: { type: "array", items: { type: "number" } },
        points: {
            type: "array",
            items: { type: "array", items: { type: "number" } },
            description:
                "spline / bspline, instead of params: the points [[u,v], ...] in curve order (a bspline's fit points)",
        },
        poles: {
            type: "array",
            items: { type: "array", items: { type: "number" } },
            description:
                "Control B-spline poles [[u,v], ...]; replaces fit points. Point indices address poles.",
        },
        degree: { type: "integer", description: "Control B-spline degree, default min(3, poles.length-1)" },
        knots: {
            type: "array",
            items: { type: "number" },
            description: "Strictly increasing distinct knots; specify multiplicities together",
        },
        multiplicities: {
            type: "array",
            items: { type: "integer" },
            description: "Clamped open ends degree+1; periodic uniform knots/multiplicity1",
        },
        weights: {
            type: "array",
            items: { type: "number" },
            description: "One positive finite rational weight per pole, default one",
        },
        parametrization: {
            type: "string",
            enum: ["chord", "centripetal", "uniform"],
            description:
                "bspline only: chord (default, follows unevenly spaced points without overshoot), centripetal (tighter at sharp turns) or uniform (evenly spaced points only)",
        },
        periodic: {
            type: "boolean",
            description:
                "bspline only: a closed, smooth (C2) curve through the points — do NOT repeat the first point as the last",
        },
        construction: {
            type: "boolean",
            description: "Construction geometry: constrainable, but never part of a profile",
        },
        name: { type: "string", description: "Names the entity so later refs in this call can use the name" },
    },
    required: ["type"],
};

const CONSTRAINT_SCHEMA = {
    type: "object",
    properties: {
        kind: {
            type: "string",
            description:
                "Coincident, Horizontal, Vertical, Parallel, Perpendicular, Tangent, Equal, EqualLength, EqualRadius, PointOn, Midpoint, Symmetric, Collinear, Fix, Block, EqualAngle, Scale, HorizontalAlign, VerticalAlign, and the dimensions Distance, HorizontalDistance, VerticalDistance, PointLineDistance, Radius, Angle — or any solver kind name with explicit refs",
        },
        entities: {
            type: "array",
            description:
                "The entities the constraint applies to (ids, names, or xAxis/yAxis), as picked in the UI",
        },
        points: { type: "array", items: POINT_REF_SCHEMA, description: "The points it applies to" },
        refs: {
            type: "array",
            items: POINT_REF_SCHEMA,
            description: "Explicit point refs in the solver layout — instead of entities/points",
        },
        datum: {
            description:
                "Dimension value in mm, signed degrees from the first directed line to the second, CCW positive (Angle), or a ratio (Scale), or an expression naming document variables. Omit to keep the current measurement.",
        },
        datums: { description: "Multi-value datum, e.g. Fix = [u, v]" },
        direction: {
            type: "array",
            items: { type: "number" },
            description: "Rotated axis [u, v] for H/V kinds",
        },
        name: { type: "string", description: "Names the constraint for later setDatum/remove in this call" },
    },
    required: ["kind"],
};

const ACTION_SCHEMA = {
    type: "object",
    description:
        "One sketch edit. load_skill parametric-modeling for every action's fields; coordinates are sketch (u, v) in mm, angles in degrees.",
    properties: {
        action: {
            type: "string",
            enum: [
                "add",
                "rectangle",
                "polygon",
                "remove",
                "setDatum",
                "setConstruction",
                "movePoint",
                "setBSpline",
                "trim",
                "split",
                "extend",
                "offset",
                "move",
                "rotate",
                "mirror",
                "paste",
                "projectEdges",
                "setExternalRole",
                "autoConstrain",
                "autoDimension",
            ],
        },
        entities: {
            type: "array",
            description: "add: entity specs; otherwise the entity ids/names acted on",
        },
        constraints: { type: "array", description: "add: constraint specs; remove: constraint ids/names" },
        associative: {
            type: "boolean",
            description: "offset: keep source and expression linked (default false); no offset chains",
        },
        entity: { description: "Entity id or name (movePoint/trim/split/extend/offset)" },
        poles: {
            type: "array",
            items: { type: "array", items: { type: "number" } },
            description:
                "Control B-spline poles [[u,v], ...]; replaces fit points. Point indices address poles.",
        },
        degree: { type: "integer", description: "Control B-spline degree, default min(3, poles.length-1)" },
        knots: {
            type: "array",
            items: { type: "number" },
            description: "Strictly increasing distinct knots; specify multiplicities together",
        },
        multiplicities: {
            type: "array",
            items: { type: "integer" },
            description: "Clamped open ends degree+1; periodic uniform knots/multiplicity1",
        },
        weights: {
            type: "array",
            items: { type: "number" },
            description: "One positive finite rational weight per pole, default one",
        },
        periodic: { type: "boolean", description: "setBSpline: periodic closure" },
        point: { type: "number", description: "movePoint: point index" },
        to: { description: "movePoint: target [u, v]; extend: the boundary entity" },
        at: {
            type: "array",
            items: { type: "number" },
            description: "trim/split: [u, v] on the piece to act on",
        },
        end: { type: "string", enum: ["start", "end"], description: "extend: which end grows (default end)" },
        distance: {
            description:
                "offset: mm or a length expression; + = left for open curves / outward for closed curves. Default evaluates once; associative:true keeps a source/distance relation, regenerated on commit.",
        },
        delta: { type: "array", items: { type: "number" }, description: "move/paste: [du, dv]" },
        center: { type: "array", items: { type: "number" }, description: "rotate/polygon: [u, v]" },
        angle: { type: "number", description: "rotate: degrees, counter-clockwise" },
        axis: { description: "mirror: the mirror line (entity id/name, or xAxis/yAxis)" },
        copy: {
            type: "boolean",
            description: "move/rotate: keep the originals (default false); mirror: default true",
        },
        corners: { type: "array", description: "rectangle: [[u1, v1], [u2, v2]]" },
        rim: {
            type: "array",
            items: { type: "number" },
            description: "polygon: a vertex (or edge midpoint) [u, v]",
        },
        sides: { type: "number", description: "polygon: number of sides" },
        inscribed: { type: "boolean", description: "polygon: rim is a vertex (default) or an edge midpoint" },
        constraint: { description: "setDatum: constraint id or name" },
        value: {
            description: "setDatum: new value (display units) or expression; setConstruction: true/false",
        },
        index: { type: "number", description: "setDatum: datum index for multi-datum kinds" },
        from: { type: "string", description: "paste: the source sketch (op id or node id)" },
        nodeId: { type: "string", description: "projectEdges: node owning the edges" },
        edgeIndexes: { type: "array", items: { type: "number" }, description: "projectEdges: edge indexes" },
        role: { type: "string", enum: ["reference", "profile"], description: "projectEdges/setExternalRole" },
        names: { type: "array", items: { type: "string" }, description: "projectEdges: a name per edge" },
        tolerance: { type: "number", description: "autoConstrain: snap distance in mm (default 0.001)" },
        angleTolerance: {
            type: "number",
            description: "autoConstrain: H/V snap angle in degrees (default 5)",
        },
        name: { type: "string", description: "rectangle/polygon/offset: name for the created geometry" },
        construction: { type: "boolean", description: "rectangle: create it as construction geometry" },
    },
    required: ["action"],
};

const FACE_SELECTION_SCHEMA = { anyOf: [{ type: "integer", minimum: 0 }, { type: "string" }] };
const FACE_SET_SCHEMA = { type: "array", items: FACE_SELECTION_SCHEMA, minItems: 1 };
const EDGE_SELECTOR_SCHEMA = {
    type: "object",
    description:
        "edges query: intersect predicates to select stable edge references. Geometry is body-local in mm. Load parametric-modeling for semantics.",
    additionalProperties: false,
    properties: {
        featureIds: {
            type: "array",
            items: { type: "string" },
            minItems: 1,
            description: "Edges born at these feature ids (union); includes surviving boolean descendants.",
        },
        adjoiningFaces: {
            type: "object",
            additionalProperties: false,
            properties: {
                all: FACE_SET_SCHEMA,
                any: FACE_SET_SCHEMA,
                exact: FACE_SET_SCHEMA,
            },
            description:
                "Incident face sets: use current face indexes or tracked face ids. all=every given face, any=at least one, exact=the whole adjacent set.",
        },
        outlineOfFaces: {
            ...FACE_SET_SCHEMA,
            description: "Edges on the outer wire of any listed face (holes excluded).",
        },
        curves: {
            type: "array",
            minItems: 1,
            items: { type: "object" },
            description:
                "Persistent reference objects returned by edges. Resolve to the queried timeline topology first, then select edges on the same supporting line/circle; other curves use tracked ancestry.",
        },
        geometry: {
            type: "object",
            additionalProperties: false,
            properties: {
                kind: { type: "string", enum: ["line", "circle", "other"] },
                radius: { type: "number", exclusiveMinimum: 0, description: "Circle-edge radius." },
                cylinderRadius: {
                    type: "number",
                    exclusiveMinimum: 0,
                    description:
                        "Radius of at least one adjacent analytic cylindrical face (includes circular rims and linear seams).",
                },
                elevation: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                        axis: { type: "string", enum: ["x", "y", "z"] },
                        value: { type: "number" },
                    },
                    required: ["value"],
                    description: "Entire edge lies at this coordinate, axis z by default.",
                },
            },
        },
        tolerance: {
            type: "number",
            exclusiveMinimum: 0,
            description: "Absolute geometry tolerance in mm (default 0.000001).",
        },
    },
};

const OPS_SCHEMA = {
    type: "object",
    properties: {
        op: {
            type: "string",
            enum: [
                "sketch",
                "extrude",
                "revolve",
                "loft",
                "editLoft",
                "sweep",
                "editSweep",
                "faceSweep",
                "editFaceSweep",
                "projection",
                "fillet",
                "chamfer",
                "thicken",
                "boolean",
                "editFeature",
                "features",
                "edges",
                "editSketch",
                "sketchInfo",
                "construct",
                "editConstruction",
                "constructionInfo",
            ],
            description: "Which operation to run",
        },
        id: {
            type: "string",
            description:
                "Name for this op's result; later ops reference it. Required for sketch/extrude/revolve/loft/sweep/projection/construct.",
        },
        name: { type: "string", description: "Optional display name for the resulting node" },
        plane: {
            description:
                'Sketch plane: "XY" (default), "YZ", "ZX", { nodeId, faceIndex } to sketch on a planar face of an existing node, or { construction, member? } for a construction plane (member "XY"/"YZ"/"ZX" picks a UCS plane)',
        },
        entities: {
            type: "array",
            description:
                "Sketch geometry in sketch (u, v) coordinates: line [x1,y1,x2,y2]; circle [cx,cy,r]; arc [cx,cy,sx,sy,ex,ey] (center, start, end; counter-clockwise); point [x,y]; ellipse [cx,cy,ax,ay,bx,by] (center and two perpendicular axis ends); spline [sx,sy,ex,ey,...interior] or points: uniform Catmull-Rom, one cubic edge per pair of neighbouring points, always open; bspline points (or params [x0,y0,x1,y1,...]): ONE interpolating B-spline edge through every point, chord-length parametrization by default, periodic: true for a closed smooth curve (first point NOT repeated) — prefer it for free-form outlines. Entity ids are the 1-based position in this list. A closed profile of lines/arcs needs its segments in perimeter order, each segment starting where the previous one ends.",
            items: ENTITY_SCHEMA,
        },
        constraints: {
            type: "array",
            description:
                "Optional sketch constraints, applied after the entities. Omit entirely for a plain sketch of fixed coordinates — constraints are what makes the sketch re-solvable when a dimension changes. Point indexes: line 0=start 1=end; circle 0=center; arc 0=center 1=start 2=end; point 0; ellipse 0=center 1/2=axis ends; spline 0=start 1=end; bspline i=fit point i (PointOn with a bspline entity slides a point along it — not one of that bspline's own fit points, which lie on it already and fail with \"A B-spline's own point already lies on it\"; Tangent of a line and an open bspline holds the line along the curve's end tangent).",
            items: CONSTRAINT_SCHEMA,
        },
        actions: {
            type: "array",
            items: ACTION_SCHEMA,
            description:
                "sketch: edits applied after entities/constraints; editSketch: the edits to apply — every sketch tool (rectangle, polygon, trim, split, extend, offset, move, rotate, mirror, paste, project edges, construction toggle, auto-constrain, auto-dimension, ...)",
        },
        sketch: { type: "string", description: "The sketch op id (or an existing sketch's node id)" },
        source: {
            type: "string",
            description: "Projection: sketch or body node whose ordered whole edges are projected",
        },
        target: {
            type: "string",
            description: "Projection: parametric body holding the target trimmed face",
        },
        faceIndex: {
            type: "integer",
            minimum: 0,
            description: "Projection target face index, captured as an associative reference",
        },
        direction: {
            ...XYZ_SCHEMA,
            description:
                "Projection: fixed finite nonzero WORLD direction; positive rays only. Reverse explicitly. Partial or multiple branches fail.",
        },
        depth: { description: "Extrude distance in mm (a number or an expression)" },
        symmetric: { type: "boolean", description: "Extrude by `depth` in both directions" },
        startFace: {
            type: "object",
            properties: { nodeId: { type: "string" }, faceIndex: { type: "integer", minimum: 0 } },
            required: ["nodeId", "faceIndex"],
            description:
                "Associative starting surface, including curved walls. startOffset offsets this surface axially; distance depth separates exact translated caps.",
        },
        startOffset: { description: "Distance the extrusion starts away from the profile plane" },
        extent: {
            description:
                'Extrude only: where it ends. "distance" (default: by `depth`), "throughAll" (through the whole body it cuts/joins; direction = the sign of depth, reversed by itself when nothing lies ahead; needs body + operation), "next" or {type:"next", offset?} (automatically find the uniformly nearest complete face in an authoring-time candidate body snapshot; curved caps are exact, missing/tied/crossing/piecewise targets fail; no automatic direction reversal), or { type: "toObject", face: { nodeId, faceIndex }, offset? } (up to a face of any node, planar or curved, re-found on every rebuild so it follows the face; offset moves the end along the direction, positive = past the face). With symmetric it applies to both sides unless secondExtent is set.',
        },
        secondExtent: {
            description:
                "Extrude only, with symmetric: true: the second side's extent (same forms as extent); a distance second side uses depth.",
        },
        axis: {
            type: "object",
            description:
                "Revolve axis: { point: {x,y,z}, direction: {x,y,z} } in world coordinates, { construction, member? } for a construction axis (member X/Y/Z picks a UCS axis), or { nodeId, edgeIndex } for a linear edge of a node. Both references follow their source when it changes.",
            properties: {
                point: XYZ_SCHEMA,
                direction: XYZ_SCHEMA,
                construction: { type: "string" },
                member: { type: "string" },
                nodeId: { type: "string" },
                edgeIndex: { type: "number" },
            },
        },
        angle: { description: "Revolve angle in degrees (default 360)" },
        sections: {
            type: "array",
            items: { type: "string" },
            description:
                "Loft only: the section sketches (op ids or node ids) in loft order, at least two, each holding one closed profile without holes, or one open non-self-intersecting wire when solid:false (ordinary lofts only). All sections must be all open or all closed; no two consecutive ones on the same plane. The loft follows every sketch when it changes. Always starts a new body.",
        },
        guided: {
            type: ["object", "null"],
            properties: {
                spine: {
                    type: "object",
                    properties: {
                        nodeId: { type: "string" },
                        edgeIndexes: {
                            type: "array",
                            items: { type: "integer", minimum: 0 },
                            minItems: 1,
                            maxItems: 128,
                        },
                        edgeRefs: { type: "array", items: { type: "object" }, minItems: 1, maxItems: 128 },
                    },
                    required: ["nodeId"],
                },
                boundary: {
                    type: "object",
                    properties: {
                        nodeId: { type: "string" },
                        edgeIndexes: {
                            type: "array",
                            items: { type: "integer", minimum: 0 },
                            minItems: 1,
                            maxItems: 128,
                        },
                        edgeRefs: { type: "array", items: { type: "object" }, minItems: 1, maxItems: 128 },
                    },
                    required: ["nodeId"],
                },
            },
            required: ["spine", "boundary"],
            description:
                "Loft/editLoft: optional associative main spine and full side-boundary guide, each an open connected path from one node. Each path requires exactly one of ordered edgeIndexes or persistent edgeRefs returned by edges. Supports 2–16 planar sections and smooth C2 only; ruled/C0/C1 fail. Sections keep their authored placement and must meet both paths in strict station order. The entire boundary must lie on generated sides. editLoft guided:null clears both guides.",
        },
        solid: {
            type: "boolean",
            description:
                "Loft/sweep: solid output (default true); false = a surface. Ordinary lofts also accept open section wires with false",
        },
        section: {
            type: "object",
            properties: {
                sketchId: { type: "string" },
                profileIndex: { type: "integer", minimum: 0 },
            },
            required: ["sketchId"],
            description:
                "Sweep/editSweep/faceSweep/editFaceSweep: section sketch op id or node id. Omit profileIndex only when it has one profile. Holes are unsupported.",
        },
        path: {
            type: "object",
            properties: {
                nodeId: { type: "string" },
                edgeIndexes: {
                    type: "array",
                    items: { type: "integer", minimum: 0 },
                    minItems: 1,
                    maxItems: 256,
                },
            },
            required: ["nodeId", "edgeIndexes"],
            description:
                "Sweep/editSweep/faceSweep/editFaceSweep: path source op id or node id and connected whole-edge topology indexes in traversal order. Captures stable source ancestry when available. Sweep alone can re-match untracked sources geometrically. FaceSweep requires proven reusable source ancestry.",
        },
        roundCorner: {
            type: "boolean",
            description: "Sweep/editSweep/faceSweep/editFaceSweep: round path junctions (default false).",
        },
        support: {
            type: "object",
            properties: { nodeId: { type: "string" }, faceIndex: { type: "integer", minimum: 0 } },
            required: ["nodeId", "faceIndex"],
            additionalProperties: false,
            description:
                "FaceSweep/editFaceSweep: trimmed support face on a parametric body. The entire path must lie on this face; nearby curves are rejected.",
        },
        ruled: {
            type: "boolean",
            description: "Loft only: straight faces between sections (default smooth)",
        },
        continuity: {
            type: "string",
            enum: ["c0", "g1", "c1", "g2", "c2", "c3", "cn"],
            description: "Loft only, not ruled: surface continuity (default c2)",
        },
        body: { type: "string", description: "The body op id (or an existing body's node id)" },
        operation: {
            type: "string",
            enum: ["fuse", "cut", "common", "join"],
            description:
                "Extrude/boolean: fuse, cut or common. FaceSweep/editFaceSweep: join or cut into the named body; requires an authored section at the path start and a proven support reference.",
        },
        selector: EDGE_SELECTOR_SCHEMA,
        expectedCount: {
            type: "integer",
            minimum: 1,
            description:
                "edges query: require this many candidates; empty/ambiguous selection status explains mismatches without applying an edit.",
        },
        edgeRefs: {
            type: "array",
            description:
                "fillet/chamfer/projection: persistent reference objects returned by the edges op; use instead of edgeIndexes. Body-scoped, follows tracked topology through upstream rebuilds.",
            items: {
                type: "object",
                properties: {
                    bodyId: { type: "string" },
                    edge: {
                        type: "object",
                        properties: {
                            kind: { type: "string", enum: ["line", "circle", "other"] },
                            edgeId: { type: "string", maxLength: 4096 },
                            splitPiece: { type: "boolean" },
                            start: XYZ_SCHEMA,
                            end: XYZ_SCHEMA,
                            center: XYZ_SCHEMA,
                            axis: XYZ_SCHEMA,
                            mid: XYZ_SCHEMA,
                            radius: { type: "number" },
                            length: { type: "number" },
                        },
                        required: ["kind"],
                    },
                },
                required: ["bodyId", "edge"],
            },
        },
        edgeIndexes: {
            type: "array",
            items: { type: "number" },
            description:
                "fillet/chamfer: edge indexes at the insertion position (final shape when index is omitted). Projection: indexes into the current source edge list. Alternative to edgeRefs. edges query: optional subset at the queried position (omit for all). Query with run_parametric edges for indexes plus persistent references.",
        },
        radius: { description: "Fillet radius in mm" },
        radiusLaw: {
            type: "array",
            minItems: 2,
            maxItems: 64,
            items: {
                type: "object",
                properties: {
                    position: { type: "number", minimum: 0, maximum: 1 },
                    radius: { description: "Positive radius in millimetres, or a length expression" },
                },
                required: ["position", "radius"],
            },
            description:
                "Fillet only: smooth law along each selected edge's normalized arc length in natural curve direction. Strictly increasing positions, endpoints 0/1. One edge per tangent contour; closed contours need equal resolved endpoint radii. editFeature action setRadiusLaw replaces the law; omit it to restore constant radius.",
        },
        distance: { description: "Chamfer distance in mm" },
        thickness: {
            description:
                'Thicken only: signed wall thickness in mm (a number or an expression, e.g. "wall_t"; it re-evaluates when the variable changes). Positive grows along the face normals (outward for a solid), negative inward; never zero.',
        },
        joinType: {
            type: "string",
            enum: ["arc", "intersection"],
            description: "Thicken only, solids: how the offset walls meet at edges (default arc = rounded)",
        },
        mode: {
            type: "string",
            enum: ["skin", "pipe"],
            description: "Thicken only, solids: offset mode (default skin)",
        },
        tolerant: {
            type: "boolean",
            description:
                "Thicken only: opt-in trimmed material envelope. Closed spheres and ring tori tolerate inward cavity collapse; general solids attempt intersection trimming. Open skins and arbitrary free-form collapse remain unsupported. Default false.",
        },
        openFaceIndexes: {
            type: "array",
            items: { type: "number" },
            description:
                "Thicken only, solids: indexes into the body's current face list (findSubShapes order) of the faces to remove, opening the shell. Omit for a closed hollow solid, and always for an open shell or surface (e.g. an open loft), which becomes a solid.",
        },
        tools: {
            type: "array",
            items: { type: "string" },
            description:
                "Boolean tool nodes (op ids or node ids). They are hidden under the body, not deleted.",
        },
        consumeTools: { type: "boolean", description: "Defaults to true" },
        action: {
            type: "string",
            enum: ["setParameter", "setRadiusLaw", "rename", "suppress", "moveTo", "remove"],
            description: "editFeature: what to do with the feature",
        },
        featureId: { type: "string", description: "The feature's id, as reported by the `features` op" },
        key: { type: "string", description: 'setParameter: the parameter name, e.g. "depth"' },
        value: { description: "setParameter: the new value; suppress: true/false; rename: the new name" },
        index: {
            type: "integer",
            minimum: 0,
            description:
                "fillet/chamfer: insert before this zero-based feature index (omit to append). edges: query the input shape at this index. Edge indexes and references are resolved there. moveTo: the feature's absolute index in the list.",
        },
        definition: {
            type: "object",
            description:
                'construct/editConstruction: { kind, ...fields } — kinds plane-offset, plane-midplane, plane-angle, plane-two-edges, plane-three-points, plane-along-path, plane-tangent, plane-perpendicular, axis-analytic, axis-normal, axis-two-planes, axis-two-points, axis-edge, point-vertex, point-two-edges, point-three-planes, point-center, point-edge-plane, point-along-path, ucs. References: "XY"/"YZ"/"ZX", { datum, member? }, { nodeId, face|edge|vertex: index }, { snap, at }, { path: [...] }, { point: [x,y,z] }, { axis: { origin, direction } }, { facePoint: { nodeId, face }, point }. Lengths (distance, offset, a distance position\'s value) and angles (angle) take a number or an expression of document variables, e.g. distance: "sec_x_1 * 2". load_skill parametric-modeling for each kind\'s fields.',
        },
        node: {
            type: "string",
            description: "editConstruction/constructionInfo: the construction (op id or node id)",
        },
        displaySize: { type: "number", description: "construct/editConstruction: display size in mm" },
    },
    required: ["op"],
};

export const RUN_PARAMETRIC_PARAMETERS = {
    type: "object",
    properties: {
        ops: { type: "array", items: OPS_SCHEMA, description: "Operations, run in order" },
        responseMode: {
            type: "string",
            enum: ["full", "compact"],
            description:
                "full (default): every touched body's feature list. compact: only created/edited feature rows, removed ids, feature count and error/warning status. Explicit features/sketchInfo/edges reads remain full.",
        },
    },
    required: ["ops"],
};

export function buildParametricTools(): Tool[] {
    return [
        {
            name: "run_parametric",
            description:
                "Build a parametric body — a sketch plus an ordered feature list the user can re-edit later. Same calling shape as run_program: { ops: [...] }, ops run in order, later ops reference earlier ids, and one call is one undo step. The difference: run_program produces throwaway geometry, run_parametric produces a feature tree the user can change a dimension in afterwards, so use it whenever the model should stay editable and run_program for one-off shapes. Ops: sketch, editSketch, sketchInfo, extrude, revolve, loft, editLoft, sweep, editSweep, faceSweep, editFaceSweep, projection, fillet, chamfer, thicken, boolean, editFeature, features, edges, construct, editConstruction, constructionInfo — every sketch tool and construction-geometry tool of the app is available; load_skill parametric-modeling for the full catalog. Nothing is ever deleted: a boolean's tool nodes become hidden children of the body. Consecutive editSketch operations coalesce downstream rebuilds. Use start_parametric_job for long sketch-edit batches with live status and cancellation.",
            parameters: RUN_PARAMETRIC_PARAMETERS,
            handler: (args, signal) => runParametric(args, signal),
        },
    ];
}

export async function runParametric(
    args: Record<string, unknown>,
    signal?: AbortSignal,
    progress?: (value: ProgramProgress) => void,
    capturedDocument?: IDocument,
): Promise<string> {
    const document = capturedDocument ?? requireDocument();
    if (typeof document === "string") return document;

    const ops = (args as { ops?: unknown }).ops;
    if (!Array.isArray(ops) || ops.length === 0) {
        throw new Error('run_parametric requires a non-empty "ops" array');
    }

    const responseMode = args["responseMode"];
    if (responseMode !== undefined && responseMode !== "full" && responseMode !== "compact") {
        throw new Error('"responseMode" must be "full" or "compact"');
    }

    const parametric = await loadParametric();
    // Every sketch op goes through the constraint solver; a program of features alone never loads it.
    const kinds = new Set(ops.map((op) => (op as { op?: unknown }).op));
    if ([...kinds].some((kind) => SOLVER_OPS.has(String(kind)))) await parametric.initPlaneGcs();
    // An open sketch session keeps its own solver and would commit over an edit made
    // behind its back — close it (committing what the user drew) before editing sketches.
    if (kinds.has("editSketch") && parametric.SketchEditor.getActive()?.document === document)
        parametric.SketchEditor.exit();

    let result: ProgramResult | undefined;
    if (capturedDocument) {
        const assertIdle = () => {
            if (globalThis.app.executingCommand || Transaction.isActive(document))
                throw new Error(
                    "Finish the active command or transaction before running a parametric program",
                );
        };
        assertIdle();
        await DocumentRebuilds.settled(document);
        assertIdle();
        const releaseSnapshot = holdDocumentReadSnapshot(document);
        let owner: ReturnType<typeof DocumentMutations.hold>;
        try {
            owner = DocumentMutations.hold(document);
        } catch (error) {
            releaseSnapshot();
            throw error;
        }
        const releaseAutosave = AutosaveHolds.hold("parametric program");
        try {
            await Transaction.executeAsync(
                document,
                "run_parametric",
                async () => {
                    result = await parametric.runParametricProgramAsync(
                        document,
                        ops as ParametricOp[],
                        {
                            signal,
                            responseMode,
                            onOpFinished: noteOpDuration,
                        },
                        owner,
                        progress,
                    );
                    // No abort check here: the program checks between steps and restores its refs
                    // when it throws. A cancel arriving after it returned leaves the job completed.
                    owner.run(() => {
                        document.selection.clearSelection();
                        document.visual.update();
                    });
                },
                owner,
            );
        } finally {
            // Rollback may enqueue restoration work. Keep ownership until it has settled,
            // and release it even if waiting fails, or the document would stay held.
            try {
                await DocumentRebuilds.settled(document);
            } finally {
                releaseSnapshot();
                owner.release();
                releaseAutosave();
            }
        }
        return JSON.stringify(result);
    }
    // Synchronous by construction: the solver is initialized above, and a throw here
    // rolls the whole program back, so a half-built body never survives.
    Transaction.execute(document, "run_parametric", () => {
        // Cancellation is checked between ops; a running op is timed for the slow-op warning.
        result = parametric.runParametricProgram(document, ops as ParametricOp[], {
            signal,
            responseMode,
            onOpFinished: noteOpDuration,
        });
        document.selection.clearSelection();
        document.visual.update();
    });
    // Serialized outside the transaction on purpose: a fault here is a reporting fault,
    // and it must not discard a build that has already committed to history.
    return JSON.stringify(result);
}
