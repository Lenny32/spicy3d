// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Transaction } from "@spicy3d/core";
import type { ParametricOp, ProgramResult } from "@spicy3d/parametric";
import type { Tool } from "../llm/types";
import { requireDocument } from "./documentContext";

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
        type: { type: "string", enum: ["line", "circle", "arc", "point", "ellipse", "spline"] },
        params: { type: "array", items: { type: "number" } },
        points: {
            type: "array",
            items: { type: "array", items: { type: "number" } },
            description:
                "spline only, instead of params: the interpolation points [[u,v], ...] in curve order",
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
                "Dimension value in mm, degrees (Angle) or a ratio (Scale), or an expression naming document variables. Omit to keep the current measurement.",
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
        entity: { description: "Entity id or name (movePoint/trim/split/extend/offset)" },
        point: { type: "number", description: "movePoint: point index" },
        to: { description: "movePoint: target [u, v]; extend: the boundary entity" },
        at: {
            type: "array",
            items: { type: "number" },
            description: "trim/split: [u, v] on the piece to act on",
        },
        end: { type: "string", enum: ["start", "end"], description: "extend: which end grows (default end)" },
        distance: {
            type: "number",
            description: "offset: signed (+ = left of a line / outward of a circle)",
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

const OPS_SCHEMA = {
    type: "object",
    properties: {
        op: {
            type: "string",
            enum: [
                "sketch",
                "extrude",
                "revolve",
                "fillet",
                "chamfer",
                "boolean",
                "editFeature",
                "features",
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
                "Name for this op's result; later ops reference it. Required for sketch/extrude/revolve/construct.",
        },
        name: { type: "string", description: "Optional display name for the resulting node" },
        plane: {
            description:
                'Sketch plane: "XY" (default), "YZ", "ZX", { nodeId, faceIndex } to sketch on a planar face of an existing node, or { construction, member? } for a construction plane (member "XY"/"YZ"/"ZX" picks a UCS plane)',
        },
        entities: {
            type: "array",
            description:
                "Sketch geometry in sketch (u, v) coordinates: line [x1,y1,x2,y2]; circle [cx,cy,r]; arc [cx,cy,sx,sy,ex,ey] (center, start, end; counter-clockwise); point [x,y]; ellipse [cx,cy,ax,ay,bx,by] (center and two perpendicular axis ends); spline [sx,sy,ex,ey,...interior] or points. Entity ids are the 1-based position in this list. A closed profile needs its points in perimeter order, first point repeated as the last.",
            items: ENTITY_SCHEMA,
        },
        constraints: {
            type: "array",
            description:
                "Optional sketch constraints, applied after the entities. Omit entirely for a plain sketch of fixed coordinates — constraints are what makes the sketch re-solvable when a dimension changes. Point indexes: line 0=start 1=end; circle 0=center; arc 0=center 1=start 2=end; point 0; ellipse 0=center 1/2=axis ends; spline 0=start 1=end.",
            items: CONSTRAINT_SCHEMA,
        },
        actions: {
            type: "array",
            items: ACTION_SCHEMA,
            description:
                "sketch: edits applied after entities/constraints; editSketch: the edits to apply — every sketch tool (rectangle, polygon, trim, split, extend, offset, move, rotate, mirror, paste, project edges, construction toggle, auto-constrain, auto-dimension, ...)",
        },
        sketch: { type: "string", description: "The sketch op id (or an existing sketch's node id)" },
        depth: { description: "Extrude distance in mm (a number or an expression)" },
        symmetric: { type: "boolean", description: "Extrude by `depth` in both directions" },
        startOffset: { description: "Distance the extrusion starts away from the profile plane" },
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
        body: { type: "string", description: "The body op id (or an existing body's node id)" },
        operation: {
            type: "string",
            enum: ["fuse", "cut", "common"],
            description:
                "Extrude only: how the new geometry combines with the target body's shape. Omit to start a new body. (Revolve has no join/cut form.)",
        },
        edgeIndexes: {
            type: "array",
            items: { type: "number" },
            description:
                "Indexes into the body's current edge list (findSubShapes order). Query them with run_program first: shape.findSubShapes on the body gives refs like e#3, whose number is the index.",
        },
        radius: { description: "Fillet radius in mm" },
        distance: { description: "Chamfer distance in mm" },
        tools: {
            type: "array",
            items: { type: "string" },
            description:
                "Boolean tool nodes (op ids or node ids). They are hidden under the body, not deleted.",
        },
        consumeTools: { type: "boolean", description: "Defaults to true" },
        action: {
            type: "string",
            enum: ["setParameter", "rename", "suppress", "moveTo", "remove"],
            description: "editFeature: what to do with the feature",
        },
        featureId: { type: "string", description: "The feature's id, as reported by the `features` op" },
        key: { type: "string", description: 'setParameter: the parameter name, e.g. "depth"' },
        value: { description: "setParameter: the new value; suppress: true/false; rename: the new name" },
        index: { type: "number", description: "moveTo: the feature's absolute index in the list" },
        definition: {
            type: "object",
            description:
                'construct/editConstruction: { kind, ...fields } — kinds plane-offset, plane-midplane, plane-angle, plane-two-edges, plane-three-points, plane-along-path, plane-tangent, plane-perpendicular, axis-analytic, axis-normal, axis-two-planes, axis-two-points, axis-edge, point-vertex, point-two-edges, point-three-planes, point-center, point-edge-plane, point-along-path, ucs. References: "XY"/"YZ"/"ZX", { datum, member? }, { nodeId, face|edge|vertex: index }, { snap, at }, { path: [...] }, { point: [x,y,z] }, { axis: { origin, direction } }, { facePoint: { nodeId, face }, point }. load_skill parametric-modeling for each kind\'s fields.',
        },
        node: {
            type: "string",
            description: "editConstruction/constructionInfo: the construction (op id or node id)",
        },
        displaySize: { type: "number", description: "construct/editConstruction: display size in mm" },
    },
    required: ["op"],
};

const RUN_PARAMETRIC_PARAMETERS = {
    type: "object",
    properties: {
        ops: { type: "array", items: OPS_SCHEMA, description: "Operations, run in order" },
    },
    required: ["ops"],
};

export function buildParametricTools(): Tool[] {
    return [
        {
            name: "run_parametric",
            description:
                "Build a parametric body — a sketch plus an ordered feature list the user can re-edit later. Same calling shape as run_program: { ops: [...] }, ops run in order, later ops reference earlier ids, and one call is one undo step. The difference: run_program produces throwaway geometry, run_parametric produces a feature tree the user can change a dimension in afterwards, so use it whenever the model should stay editable and run_program for one-off shapes. Ops: sketch, editSketch, sketchInfo, extrude, revolve, fillet, chamfer, boolean, editFeature, features, construct, editConstruction, constructionInfo — every sketch tool and construction-geometry tool of the app is available; load_skill parametric-modeling for the full catalog. Nothing is ever deleted: a boolean's tool nodes become hidden children of the body.",
            parameters: RUN_PARAMETRIC_PARAMETERS,
            handler: runParametric,
        },
    ];
}

async function runParametric(args: Record<string, unknown>): Promise<string> {
    const document = requireDocument();
    if (typeof document === "string") return document;

    const ops = (args as { ops?: unknown }).ops;
    if (!Array.isArray(ops) || ops.length === 0) {
        throw new Error('run_parametric requires a non-empty "ops" array');
    }

    const parametric = await loadParametric();
    // Every sketch op goes through the constraint solver; a program of features alone never loads it.
    const kinds = new Set(ops.map((op) => (op as { op?: unknown }).op));
    if ([...kinds].some((kind) => SOLVER_OPS.has(String(kind)))) await parametric.initPlaneGcs();
    // An open sketch session keeps its own solver and would commit over an edit made
    // behind its back — close it (committing what the user drew) before editing sketches.
    if (kinds.has("editSketch")) parametric.SketchEditor.exit();

    let result: ProgramResult | undefined;
    // Synchronous by construction: the solver is initialized above, and a throw here
    // rolls the whole program back, so a half-built body never survives.
    Transaction.execute(document, "run_parametric", () => {
        result = parametric.runParametricProgram(document, ops as ParametricOp[]);
        document.selection.clearSelection();
        document.visual.update();
    });
    // Serialized outside the transaction on purpose: a fault here is a reporting fault,
    // and it must not discard a build that has already committed to history.
    return JSON.stringify(result);
}
