// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IEdge, type IFace, ShapeTypes, XYZ } from "@spicy3d/core";
import { matchEdgesAnchored } from "../features/edgeMatcher";
import type { EdgeRef } from "../features/edgeRef";
import { ID_COMPONENT_SEPARATOR, idsOverlap } from "../features/trackedId";
import type { ParametricBodyNode } from "../parametricBodyNode";
import type { PersistentEdgeReference } from "./parametricProgram";

export type FaceSelection = number | string;

/** Runtime query predicates, never part of a document's saved payload. Fields intersect. */
export interface EdgeSelector {
    featureIds?: string[];
    adjoiningFaces?: { all?: FaceSelection[]; any?: FaceSelection[]; exact?: FaceSelection[] };
    outlineOfFaces?: FaceSelection[];
    curves?: PersistentEdgeReference[];
    geometry?: {
        kind?: EdgeRef["kind"];
        radius?: number;
        cylinderRadius?: number;
        elevation?: { axis?: "x" | "y" | "z"; value: number };
    };
    tolerance?: number;
}

export interface EdgeSelectionReport {
    status: "matched" | "empty" | "ambiguous";
    count: number;
    message: string;
}

function fields(value: unknown, allowed: string[], name: string): void {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        throw new Error(`${name} must be an object`);
    for (const key of Object.keys(value))
        if (!allowed.includes(key)) throw new Error(`unknown ${name} field "${key}"`);
}

function nonemptyArray(value: unknown, name: string): asserts value is unknown[] {
    if (!Array.isArray(value) || value.length === 0) throw new Error(`${name} must be a non-empty array`);
}

export function validateEdgeSelector(selector: EdgeSelector): void {
    fields(
        selector,
        ["featureIds", "adjoiningFaces", "outlineOfFaces", "curves", "geometry", "tolerance"],
        "selector",
    );
    if (
        selector.tolerance !== undefined &&
        (!Number.isFinite(selector.tolerance) || selector.tolerance <= 0)
    ) {
        throw new Error("selector tolerance must be a positive finite length");
    }
    if (selector.featureIds !== undefined) {
        nonemptyArray(selector.featureIds, "featureIds");
        if (selector.featureIds.some((id) => typeof id !== "string" || id.length === 0))
            throw new Error("featureIds must contain feature ids");
    }
    if (selector.curves !== undefined) nonemptyArray(selector.curves, "curves");
    if (selector.adjoiningFaces !== undefined) {
        fields(selector.adjoiningFaces, ["all", "any", "exact"], "adjoiningFaces");
        if (Object.keys(selector.adjoiningFaces).length === 0)
            throw new Error("adjoiningFaces requires all, any or exact");
    }
    if (selector.geometry !== undefined) {
        const g = selector.geometry;
        fields(g, ["kind", "radius", "cylinderRadius", "elevation"], "geometry");
        if (Object.keys(g).length === 0) throw new Error("geometry requires a predicate");
        if (g.kind !== undefined && !["line", "circle", "other"].includes(g.kind))
            throw new Error("unknown geometry kind");
        for (const value of [g.radius, g.cylinderRadius]) {
            if (value !== undefined && (!Number.isFinite(value) || value <= 0))
                throw new Error("geometry radius must be positive and finite");
        }
        if (g.elevation !== undefined) {
            fields(g.elevation, ["axis", "value"], "elevation");
            if (
                !Number.isFinite(g.elevation.value) ||
                (g.elevation.axis !== undefined && !["x", "y", "z"].includes(g.elevation.axis))
            ) {
                throw new Error("elevation requires a finite value and axis x, y or z");
            }
        }
    }
}

/** Origins come from first appearance in timeline history, retaining each compound ancestry leaf. */
function originLeaves(
    body: ParametricBodyNode,
    featureIds: string[],
    refs: (EdgeRef | undefined)[],
): Set<string> {
    const leaves = (ids: readonly string[]) => ids.flatMap((id) => id.split(ID_COMPONENT_SEPARATOR));
    const finalIds = refs.map((ref) => ref?.edgeId ?? "");
    const origins = new Set<string>();
    for (const id of featureIds) {
        const index = body.features.findIndex((feature) => feature.id === id);
        if (index < 0) throw new Error(`unknown feature origin "${id}"`);
        if (body.features[index].suppressed) continue;
        const before = new Set(leaves(body.timelineStateAt(index)?.edgeIds ?? []));
        const after = body.timelineStateAt(index + 1)?.edgeIds ?? finalIds;
        for (const leaf of leaves(after)) if (!before.has(leaf)) origins.add(leaf);
    }
    return origins;
}

function faceIndexes(
    body: ParametricBodyNode,
    faces: IFace[],
    given: FaceSelection[],
    name: string,
): Set<number> {
    nonemptyArray(given, name);
    const selected = new Set<number>();
    for (const ref of given) {
        if (typeof ref === "number") {
            if (!Number.isInteger(ref) || ref < 0 || ref >= faces.length)
                throw new Error(`${name}: face index ${ref} is out of range`);
            selected.add(ref);
        } else if (typeof ref === "string" && ref.length > 0) {
            const indexes = body.faceIndexesOfId(ref);
            if (indexes.length === 0) throw new Error(`${name}: face id "${ref}" is missing`);
            for (const index of indexes) selected.add(index);
        } else throw new Error(`${name}: use current face indexes or tracked face ids`);
    }
    return selected;
}

/** A radius property shared with neither sphere nor torus identifies the existing analytic cylinder interface. */
function cylinderRadius(face: IFace): number | undefined {
    const surface = face.surface();
    try {
        if (
            "radius" in surface &&
            !("area" in surface) &&
            !("majorRadius" in surface) &&
            !("semiAngle" in surface)
        ) {
            const value = surface.radius;
            return typeof value === "number" && Number.isFinite(value) ? value : undefined;
        }
        return undefined;
    } finally {
        surface.dispose();
    }
}

function sameCurve(a: EdgeRef, b: EdgeRef, tolerance: number): boolean {
    if (a.kind !== b.kind) return false;
    if (a.kind === "line" && b.kind === "line") {
        const dir = new XYZ(a.end).sub(new XYZ(a.start)).normalize();
        const other = new XYZ(b.end).sub(new XYZ(b.start)).normalize();
        return (
            dir !== undefined &&
            other !== undefined &&
            dir.cross(other).length() <= tolerance &&
            new XYZ(b.start).sub(new XYZ(a.start)).cross(dir).length() <= tolerance
        );
    }
    if (a.kind === "circle" && b.kind === "circle") {
        const axis = new XYZ(a.axis).normalize();
        const other = new XYZ(b.axis).normalize();
        return (
            axis !== undefined &&
            other !== undefined &&
            axis.cross(other).length() <= tolerance &&
            new XYZ(a.center).sub(new XYZ(b.center)).length() <= tolerance &&
            Math.abs(a.radius - b.radius) <= tolerance
        );
    }
    return a.edgeId !== undefined && b.edgeId !== undefined && idsOverlap(a.edgeId, b.edgeId);
}

export function selectEdgeIndexes(
    body: ParametricBodyNode,
    edges: IEdge[],
    refs: (EdgeRef | undefined)[],
    selector: EdgeSelector,
    validatedCurves?: EdgeRef[],
): number[] {
    validateEdgeSelector(selector);
    const shape = body.shape;
    if (!shape.isOk) throw new Error(`body has no valid shape: ${shape.error}`);
    const tolerance = selector.tolerance ?? 1e-6;
    const origins =
        selector.featureIds === undefined ? undefined : originLeaves(body, selector.featureIds, refs);
    let curves: EdgeRef[] | undefined;
    if (validatedCurves !== undefined) {
        const resolved = matchEdgesAnchored(
            shape.value,
            validatedCurves,
            edges.map((_, index) => body.edgeIdAt(index) ?? ""),
        );
        if (!resolved.isOk) throw new Error(`curve selection is missing or ambiguous: ${resolved.error}`);
        curves = resolved.value.indexes.flatMap((index) => (refs[index] === undefined ? [] : [refs[index]]));
    }
    const faces = shape.value.findSubShapes(ShapeTypes.face) as IFace[];
    const outlines: IEdge[] = [];
    try {
        const adjoining = selector.adjoiningFaces;
        const all =
            adjoining?.all === undefined
                ? undefined
                : faceIndexes(body, faces, adjoining.all, "adjoiningFaces.all");
        const any =
            adjoining?.any === undefined
                ? undefined
                : faceIndexes(body, faces, adjoining.any, "adjoiningFaces.any");
        const exact =
            adjoining?.exact === undefined
                ? undefined
                : faceIndexes(body, faces, adjoining.exact, "adjoiningFaces.exact");
        if (selector.outlineOfFaces !== undefined) {
            for (const index of faceIndexes(body, faces, selector.outlineOfFaces, "outlineOfFaces")) {
                const wire = faces[index].outerWire();
                try {
                    outlines.push(...(wire.findSubShapes(ShapeTypes.edge) as IEdge[]));
                } finally {
                    wire.dispose();
                }
            }
        }
        return edges.flatMap((edge, index) => {
            const ref = refs[index];
            if (ref === undefined) return [];
            if (
                origins !== undefined &&
                !ref.edgeId?.split(ID_COMPONENT_SEPARATOR).some((leaf) => origins.has(leaf))
            )
                return [];
            if (curves !== undefined && !curves.some((curve) => sameCurve(curve, ref, tolerance))) return [];
            if (selector.outlineOfFaces !== undefined && !outlines.some((outline) => outline.isSame(edge)))
                return [];
            const g = selector.geometry;
            if (g?.kind !== undefined && ref.kind !== g.kind) return [];
            if (
                g?.radius !== undefined &&
                (ref.kind !== "circle" || Math.abs(ref.radius - g.radius) > tolerance)
            )
                return [];
            if (g?.elevation !== undefined) {
                const axis = g.elevation.axis ?? "z";
                const box = edge.geometryBoundingBox();
                if (
                    Math.abs(box.min[axis] - g.elevation.value) > tolerance ||
                    Math.abs(box.max[axis] - g.elevation.value) > tolerance
                )
                    return [];
            }
            if (
                all !== undefined ||
                any !== undefined ||
                exact !== undefined ||
                g?.cylinderRadius !== undefined
            ) {
                const ancestors = edge.findAncestor(ShapeTypes.face, shape.value) as IFace[];
                try {
                    const adjacent = new Set(
                        faces.flatMap((face, i) =>
                            ancestors.some((ancestor) => ancestor.isSame(face)) ? [i] : [],
                        ),
                    );
                    if (all !== undefined && ![...all].every((i) => adjacent.has(i))) return [];
                    if (any !== undefined && ![...any].some((i) => adjacent.has(i))) return [];
                    if (
                        exact !== undefined &&
                        (exact.size !== adjacent.size || ![...exact].every((i) => adjacent.has(i)))
                    )
                        return [];
                    if (
                        g?.cylinderRadius !== undefined &&
                        !ancestors.some((face) => {
                            const radius = cylinderRadius(face);
                            return radius !== undefined && Math.abs(radius - g.cylinderRadius!) <= tolerance;
                        })
                    )
                        return [];
                } finally {
                    for (const face of ancestors) face.dispose();
                }
            }
            return [index];
        });
    } finally {
        for (const edge of outlines) edge.dispose();
        for (const face of faces) face.dispose();
    }
}

export function describeEdgeSelection(count: number, expectedCount?: number): EdgeSelectionReport {
    if (expectedCount !== undefined && (!Number.isInteger(expectedCount) || expectedCount < 1))
        throw new Error("expectedCount must be a positive integer");
    if (count === 0)
        return {
            status: "empty",
            count,
            message:
                "No edges match all selector predicates. Inspect current geometry, feature origins and adjoining faces; relax a predicate or its tolerance.",
        };
    if (expectedCount !== undefined && count !== expectedCount)
        return {
            status: "ambiguous",
            count,
            message: `Expected ${expectedCount} edges, found ${count}. Inspect returned candidates and refine the selector before applying a corner operation.`,
        };
    return {
        status: "matched",
        count,
        message: `${count} edges match. References identify current topology and can be reused across rebuilds.`,
    };
}
