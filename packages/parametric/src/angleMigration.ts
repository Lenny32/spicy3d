// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    ANGLE_UNITS,
    EMPTY_SCOPE,
    evaluateVariables,
    resolveUnitSpec,
    type Scope,
    type Serialized,
} from "@spicy3d/core";
import type { SketchData, SketchPointRef } from "./sketch/sketchModel";

// Persisted IDs, kept here so migrations never import the PlaneGCS/WASM runtime.
const ANGLE_KIND = 9;
const ORIGIN = -1;
const X_AXIS = -2;
const Y_AXIS = -3;

function point(data: SketchData, ref: SketchPointRef): [number, number] | undefined {
    if (!ref || !Number.isInteger(ref.pointIndex) || ref.pointIndex < 0) return undefined;
    if (ref.entityId === ORIGIN) return [0, 0];
    if (ref.entityId === X_AXIS) return ref.pointIndex === 0 ? [0, 0] : [1, 0];
    if (ref.entityId === Y_AXIS) return ref.pointIndex === 0 ? [0, 0] : [0, 1];
    const entity = (Array.isArray(data.entities) ? data.entities : []).find(
        (item) => item?.id === ref.entityId,
    );
    const params =
        entity?.params ??
        (Array.isArray(data.externalRefs) ? data.externalRefs : []).find(
            (item) => item?.entityId === ref.entityId,
        )?.snapshot;
    if (!Array.isArray(params)) return undefined;
    const offset = ref.pointIndex * 2;
    const x = params[offset],
        y = params[offset + 1];
    return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : undefined;
}

/** Pure v4 → v5 payload migration: recover the old load-time side once, from stored geometry. */
export function migrateAngleSides(data: SketchData, scope: Scope): SketchData {
    const migrated = structuredClone(data);
    if (!Array.isArray(migrated.constraints)) return migrated;
    for (const constraint of migrated.constraints) {
        if (!constraint || constraint.kind !== ANGLE_KIND || constraint.angleSide !== undefined) continue;
        constraint.angleSide = 1;
        const datum = constraint.datum;
        let value: number;
        if (typeof datum === "number") value = datum;
        else if (typeof datum === "string") {
            const resolved = resolveUnitSpec(datum, scope, ANGLE_UNITS);
            if (!resolved.isOk) continue;
            value = (resolved.value * Math.PI) / 180;
        } else continue;
        if (!(value > 0) || !Array.isArray(constraint.refs) || constraint.refs.length !== 4) continue;
        const points = constraint.refs.map((ref) => point(migrated, ref));
        if (points.some((item) => item === undefined)) continue;
        const [a, b, c, d] = points as [number, number][];
        const dx = b[0] - a[0],
            dy = b[1] - a[1];
        const ex = d[0] - c[0],
            ey = d[1] - c[1];
        if (Math.hypot(dx, dy) < 1e-12 || Math.hypot(ex, ey) < 1e-12) continue;
        const sweep = Math.atan2(dx * ey - dy * ex, dx * ex + dy * ey);
        if (
            Math.abs(Math.abs(sweep) - Math.abs(value)) < 1e-7 &&
            Math.abs(Math.sin(sweep)) > 1e-8 &&
            sweep < 0
        ) {
            constraint.angleSide = -1;
        }
    }
    return migrated;
}

/** Total over malformed/unknown nodes: leave unreadable payloads for the normal loader to report. */
export function migrateSketchAngles(document: Serialized): Serialized {
    let scope = EMPTY_SCOPE;
    if (Array.isArray(document["variables"])) scope = evaluateVariables(document["variables"]).scope;
    const models = document["models"];
    const nodes: Serialized[] = Array.isArray(models?.nodes) ? [...models.nodes] : [];
    // Component definitions also serialize their own nodes, outside the document tree.
    for (const component of Array.isArray(models?.components) ? models.components : []) {
        if (Array.isArray(component?.nodes)) nodes.push(...component.nodes);
    }
    for (const node of nodes) {
        if (node?.__cla$$__ !== "SketchNode" || typeof node["dataJson"] !== "string") continue;
        let data: SketchData;
        try {
            data = JSON.parse(node["dataJson"]);
        } catch {
            continue;
        }
        if (!data || typeof data !== "object" || !Array.isArray(data.constraints)) continue;
        if (
            !data.constraints.some(
                (constraint) => constraint?.kind === ANGLE_KIND && constraint.angleSide === undefined,
            )
        )
            continue;
        node["dataJson"] = JSON.stringify(migrateAngleSides(data, scope));
    }
    return document;
}
