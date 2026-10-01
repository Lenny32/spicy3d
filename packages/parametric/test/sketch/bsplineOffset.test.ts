// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Plane } from "@spicy3d/core";
import {
    bsplineDistance,
    bsplinePointAt,
    entityBSpline,
    evaluateBSpline,
    sampleBSpline,
} from "../../src/sketch/bsplineGeometry";
import { bsplineOffsetSide } from "../../src/sketch/bsplineOffset";
import { defineControlBSpline } from "../../src/sketch/controlBSplineGeometry";
import { offsetCurve, trimCurve } from "../../src/sketch/geometryEditing";
import type { SketchEntityData } from "../../src/sketch/sketchModel";
import { SketchSolver } from "../../src/sketch/solver";
import "./setup";

const footprint = (reverse = false): SketchEntityData => {
    const points = Array.from({ length: 64 }, (_, i) => {
        const angle = (2 * Math.PI * i) / 64;
        return [30 * Math.cos(angle), 50 * Math.sin(angle)];
    });
    return { id: 1, type: "bspline", params: (reverse ? points.reverse() : points).flat(), periodic: true };
};

test.each([false, true])("periodic footprint offset is outward for winding reversed=%s", (reverse) => {
    const source = footprint(reverse);
    const saved = structuredClone(source);
    const result = offsetCurve(source, 2.1);
    expect(result.isOk).toBe(true);
    expect(source).toEqual(saved);
    expect(result.value.copy).toBe(true);
    const copy = result.value.pieces[0];
    expect(copy.periodic).toBe(true);
    const curve = entityBSpline(copy.params, copy);
    const original = entityBSpline(source.params, source);
    const samples = sampleBSpline(curve, 2);
    expect(samples[0]).toEqual(samples.at(-1));
    for (const p of samples) expect(bsplineDistance(original, p)).toBeCloseTo(2.1, 2);
    expect(bsplinePointAt(curve, 0)[0] - source.params[0]).toBeGreaterThan(1.9);
    expect(bsplineOffsetSide(source, [40, 0])).toBe(1);
    expect(bsplineOffsetSide(source, [0, 0])).toBe(-1);
});

test.each([2, -2])("open B-spline offset follows the normal by %s", (distance) => {
    const source: SketchEntityData = {
        id: 1,
        type: "bspline",
        params: [0, 0, 5, 3, 10, 0],
        construction: true,
    };
    const result = offsetCurve(source, distance);
    expect(result.isOk).toBe(true);
    const copy = result.value.pieces[0];
    expect(copy.construction).toBe(true);
    expect(copy.periodic).toBe(false);
    const [p, d] = evaluateBSpline(entityBSpline(source.params, source), 0);
    const length = Math.hypot(...d);
    expect(copy.params[0]).toBeCloseTo(p[0] - (distance * d[1]) / length, 8);
    expect(copy.params[1]).toBeCloseTo(p[1] + (distance * d[0]) / length, 8);
    const offset = entityBSpline(copy.params, copy);
    for (const point of sampleBSpline(offset, 2).slice(1, -1)) {
        expect(bsplineDistance(entityBSpline(source.params, source), point)).toBeCloseTo(
            Math.abs(distance),
            2,
        );
    }
    expect(bsplineOffsetSide(source, [5, 10])).toBe(1);
    expect(bsplineOffsetSide(source, [5, -10])).toBe(-1);
    expect(trimCurve(source, [], [5, 3]).isOk).toBe(false);
});

test("control NURBS offset becomes a fit curve without inheriting source weights/knots", () => {
    const definition = defineControlBSpline(
        [
            [10, 0],
            [10, 10],
            [0, 10],
        ],
        { degree: 2, weights: [1, Math.SQRT1_2, 1] },
    );
    expect(definition.isOk).toBe(true);
    const source: SketchEntityData = {
        id: 1,
        type: "bspline",
        params: [10, 0, 10, 10, 0, 10],
        control: definition.value,
    };
    const result = offsetCurve(source, -2);
    expect(result.isOk).toBe(true);
    const copy = result.value.pieces[0];
    expect(copy.control).toBeUndefined();
    for (const p of sampleBSpline(entityBSpline(copy.params, copy), 3)) {
        expect(Math.hypot(...p)).toBeCloseTo(12, 2);
    }
});

test("offsets fit curves with more points than half the fit budget", () => {
    const points = Array.from({ length: 300 }, (_, i) => {
        const angle = (2 * Math.PI * i) / 300;
        return [30 * Math.cos(angle), 50 * Math.sin(angle)];
    });
    const source: SketchEntityData = { id: 1, type: "bspline", params: points.flat(), periodic: true };
    const result = offsetCurve(source, 1);
    expect(result.isOk).toBe(true);
    expect(result.value.pieces[0].params.length / 2).toBeGreaterThanOrEqual(300);
});

test.each([
    0,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    -30,
])("refuses invalid/collapsed periodic offset %s", (distance) => {
    expect(offsetCurve(footprint(), distance).isOk).toBe(false);
});

test("refuses crossing offsets and malformed source geometry", () => {
    const crossing: SketchEntityData = { id: 1, type: "bspline", params: [0, 0, 10, 10, 0, 10, 10, 0] };
    const offset = offsetCurve(crossing, 0.01);
    expect(offset.isOk).toBe(false);
    expect(offset.error).toContain("self-intersect");
    expect(offsetCurve({ ...crossing, params: [0, 0, Number.NaN, 1] }, 1).isOk).toBe(false);
});

test("solver applies a B-spline copy with a fresh id and unchanged source", () => {
    const source = footprint();
    const solver = new SketchSolver(Plane.XY, { entities: [source], constraints: [] });
    try {
        const edit = offsetCurve(solver.entity(1)!, 2);
        expect(edit.isOk).toBe(true);
        const applied = solver.applyGeometryEdit(edit.value);
        expect(applied.isOk).toBe(true);
        const id = applied.value.entityIds[0];
        expect(id).not.toBe(1);
        expect(applied.value.removedConstraints).toEqual([]);
        expect(solver.entity(1)?.params).toEqual(source.params);
        expect(solver.entity(id)?.type).toBe("bspline");
        const reloaded = new SketchSolver(Plane.XY, solver.toData());
        try {
            expect(reloaded.entity(id)).toEqual(solver.entity(id));
        } finally {
            reloaded.dispose();
        }
    } finally {
        solver.dispose();
    }
});
