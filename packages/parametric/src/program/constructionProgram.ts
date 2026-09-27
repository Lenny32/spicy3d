// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type ConstructionDefinition,
    type ConstructionGeometry,
    ConstructionNode,
    type ConstructionRef,
    captureConstructionRef,
    captureFacePointRef,
    DocumentConstructionResolver,
    evaluateConstruction,
    type IDocument,
    type IFace,
    type INode,
    type IShape,
    resolveConstructionRef,
    ShapeNode,
    ShapeTypes,
    validateConstructionDefinition,
    XYZ,
} from "@spicy3d/core";

/**
 * Construction geometry (reference planes, axes, points and coordinate systems) for a
 * parametric program. A definition is the same `ConstructionDefinition` the interactive
 * Construct tools store; only its references are written in a friendlier form and
 * captured here the way the tools capture a pick, so the node is associative exactly
 * like a hand-built one.
 */

export interface ConstructionProgramHost {
    readonly document: IDocument;
    resolveNode(ref: unknown, what: string): INode;
}

/** Definition fields holding a reference; everything else is a number or an option. */
const REF_FIELDS = [
    "source",
    "toPoint",
    "first",
    "second",
    "third",
    "baseline",
    "axis",
    "path",
    "face",
    "contact",
    "orientation",
    "edge",
    "vertex",
    "plane",
    "origin",
] as const;

const SHAPE_KEYS = ["face", "edge", "vertex"] as const;

/**
 * A reference in its friendly form:
 * - `"XY" | "YZ" | "ZX"` — a global origin plane;
 * - `{ datum, member? }` — a construction node (op id or node id), `member` picks a UCS plane or axis;
 * - `{ nodeId, face | edge | vertex: index }` — a sub-shape of a node (findSubShapes order);
 * - `{ snap: <ref>, at: "start" | "end" | "middle" | "center" }` — a point on an edge;
 * - `{ path: [<edge refs>], reversed?, branch? }` — a chain of edges;
 * - `{ point: [x, y, z] }` / `{ axis: { origin, direction } }` — fixed geometry;
 * - `{ facePoint: { nodeId, face }, point: [x, y, z] }` — a point on a face, kept in face (u, v);
 * - any stored `ConstructionRef` (has `kind`) passes through unchanged.
 */
export function toConstructionRef(host: ConstructionProgramHost, value: unknown): ConstructionRef {
    if (value === "XY" || value === "YZ" || value === "ZX") return { kind: "origin-plane", plane: value };
    if (value === null || typeof value !== "object") {
        throw new Error(`not a construction reference: ${JSON.stringify(value)}`);
    }
    const spec = value as Record<string, unknown>;
    if (typeof spec["kind"] === "string") return spec as unknown as ConstructionRef;
    if (spec["datum"] !== undefined) {
        const node = host.resolveNode(spec["datum"], "construction datum");
        if (!(node instanceof ConstructionNode))
            throw new Error(`"${String(spec["datum"])}" is not a construction node`);
        const member = spec["member"];
        return {
            kind: "datum",
            nodeId: node.id,
            ...(member === undefined ? {} : { member: member as "XY" | "YZ" | "ZX" | "X" | "Y" | "Z" }),
        };
    }
    if (spec["snap"] !== undefined) {
        const at = spec["at"];
        if (at !== "start" && at !== "end" && at !== "middle" && at !== "center") {
            throw new Error('a snap reference needs "at": "start" | "end" | "middle" | "center"');
        }
        return { kind: "snap", source: toConstructionRef(host, spec["snap"]), snap: at };
    }
    if (Array.isArray(spec["path"])) {
        return {
            kind: "path",
            segments: spec["path"].map((segment) => toConstructionRef(host, segment)),
            ...(spec["reversed"] === true ? { reversed: true } : {}),
            ...(typeof spec["branch"] === "number" ? { branch: spec["branch"] } : {}),
        };
    }
    if (spec["facePoint"] !== undefined) {
        const face = spec["facePoint"] as Record<string, unknown>;
        const { node, shape } = subShape(host, face["nodeId"], "face", face["face"]);
        const point = xyz(spec["point"], "point");
        const ref = captureFacePointRef(host.document, node, shape as IFace, point);
        if (!ref.isOk) throw new Error(ref.error);
        return ref.value;
    }
    if (spec["point"] !== undefined) {
        return { kind: "fixed", geometry: { kind: "point", point: xyz(spec["point"], "point") } };
    }
    if (spec["axis"] !== undefined) {
        const axis = spec["axis"] as Record<string, unknown>;
        const direction = xyz(axis["direction"], "axis.direction");
        if (direction.length() < 1e-12) throw new Error('"axis.direction" must be non-zero');
        return {
            kind: "fixed",
            geometry: { kind: "axis", origin: xyz(axis["origin"] ?? [0, 0, 0], "axis.origin"), direction },
        };
    }
    const key = SHAPE_KEYS.find((k) => spec[k] !== undefined);
    if (spec["nodeId"] !== undefined && key !== undefined) {
        const { node, shape } = subShape(host, spec["nodeId"], key, spec[key]);
        const ref = captureConstructionRef(host.document, node, shape);
        if (!ref.isOk) throw new Error(ref.error);
        return ref.value;
    }
    throw new Error(`not a construction reference: ${JSON.stringify(value)}`);
}

function subShape(
    host: ConstructionProgramHost,
    nodeRef: unknown,
    type: (typeof SHAPE_KEYS)[number],
    index: unknown,
): { node: INode; shape: IShape } {
    const node = host.resolveNode(nodeRef, "reference node");
    if (!(node instanceof ShapeNode) || !node.shape.isOk) {
        throw new Error(`node "${String(nodeRef)}" has no valid shape to reference`);
    }
    const shapeType =
        type === "face" ? ShapeTypes.face : type === "edge" ? ShapeTypes.edge : ShapeTypes.vertex;
    const shapes = node.shape.value.findSubShapes(shapeType);
    const shape = typeof index === "number" ? shapes[index] : undefined;
    if (shape === undefined) {
        throw new Error(
            `${type} ${String(index)} is out of range on "${String(nodeRef)}" (0..${shapes.length - 1})`,
        );
    }
    return { node, shape };
}

function xyz(value: unknown, what: string): XYZ {
    const v = Array.isArray(value)
        ? { x: value[0], y: value[1], z: value[2] }
        : (value as Record<string, unknown>);
    if (
        v === null ||
        typeof v !== "object" ||
        ![v.x, v.y, v.z].every((n) => typeof n === "number" && Number.isFinite(n))
    ) {
        throw new Error(`"${what}" must be [x, y, z] or {x, y, z} with finite numbers`);
    }
    return new XYZ({ x: v.x as number, y: v.y as number, z: v.z as number });
}

/** A definition with its references captured; validated and evaluated before anything is stored. */
export function toConstructionDefinition(
    host: ConstructionProgramHost,
    value: unknown,
    nodeId: string,
): ConstructionDefinition {
    if (
        value === null ||
        typeof value !== "object" ||
        typeof (value as { kind?: unknown }).kind !== "string"
    ) {
        throw new Error('"definition" must be an object with a "kind"');
    }
    const definition: Record<string, unknown> = { ...(value as Record<string, unknown>) };
    for (const field of REF_FIELDS) {
        if (definition[field] !== undefined) definition[field] = toConstructionRef(host, definition[field]);
    }
    const position = definition["position"] as Record<string, unknown> | undefined;
    if (position?.["kind"] === "to-point") {
        definition["position"] = { ...position, point: toConstructionRef(host, position["point"]) };
    }
    const result = definition as unknown as ConstructionDefinition;
    const valid = validateConstructionDefinition(host.document, nodeId, result);
    if (!valid.isOk) throw new Error(valid.error);
    const resolver = new DocumentConstructionResolver(host.document);
    try {
        const evaluated = evaluateConstruction(result, resolver);
        if (!evaluated.isOk) throw new Error(`the construction does not evaluate: ${evaluated.error}`);
    } finally {
        resolver.dispose();
    }
    return result;
}

/** A construction's resolved geometry as plain numbers. */
export function describeConstructionGeometry(geometry: ConstructionGeometry): Record<string, unknown> {
    const v = (p: { x: number; y: number; z: number }) => [p.x, p.y, p.z];
    switch (geometry.kind) {
        case "plane":
            return {
                kind: "plane",
                origin: v(geometry.plane.origin),
                normal: v(geometry.plane.normal),
                xvec: v(geometry.plane.xvec),
            };
        case "axis":
            return { kind: "axis", origin: v(geometry.origin), direction: v(geometry.direction) };
        case "point":
            return { kind: "point", point: v(geometry.point) };
        default:
            return {
                kind: "ucs",
                origin: v(geometry.origin),
                x: v(geometry.x),
                y: v(geometry.y),
                z: v(geometry.z),
            };
    }
}

/**
 * A construction plane (or a UCS plane) for a sketch: `{ construction, member? }`.
 * The sketch stores the reference, so it follows the construction when it moves.
 */
export function resolveConstructionPlaneRef(
    host: ConstructionProgramHost,
    spec: { construction: unknown; member?: "XY" | "YZ" | "ZX" },
): { ref: ConstructionRef; plane: import("@spicy3d/core").Plane } {
    const ref = datumRef(host, spec.construction, spec.member ?? "XY");
    const resolved = resolveConstructionRef(host.document, ref);
    if (!resolved.isOk) throw new Error(resolved.error);
    if (resolved.value.kind !== "plane") throw new Error("the construction is not a plane (or a UCS)");
    return { ref, plane: resolved.value.plane };
}

/** A construction axis (or a UCS axis) for a revolve: `{ construction, member? }`. */
export function resolveConstructionAxisRef(
    host: ConstructionProgramHost,
    spec: { construction: unknown; member?: "X" | "Y" | "Z" },
): { ref: ConstructionRef; point: XYZ; direction: XYZ } {
    const ref = datumRef(host, spec.construction, spec.member ?? "Z");
    const resolved = resolveConstructionRef(host.document, ref);
    if (!resolved.isOk) throw new Error(resolved.error);
    if (resolved.value.kind !== "axis") throw new Error("the construction is not an axis (or a UCS)");
    return { ref, point: resolved.value.origin, direction: resolved.value.direction };
}

/** A datum ref to a construction node; the member only applies to a UCS, as in the editor. */
function datumRef(host: ConstructionProgramHost, value: unknown, member: string): ConstructionRef {
    const node = host.resolveNode(value, "construction");
    if (!(node instanceof ConstructionNode)) throw new Error(`"${String(value)}" is not a construction node`);
    return {
        kind: "datum",
        nodeId: node.id,
        ...(node.definition.kind === "ucs" ? { member: member as "XY" | "YZ" | "ZX" | "X" | "Y" | "Z" } : {}),
    };
}
