// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { LENGTH_UNITS, Plane, type Result } from "@spicy3d/core";
import { directedDistanceDimension } from "../../src/sketch/editor/dimensionLayout";
import {
    arcAngles,
    ConstraintKind,
    type SketchData,
    type SketchEntityData,
} from "../../src/sketch/sketchModel";
import { SketchSolver } from "../../src/sketch/solver";
import {
    copySketchSelection,
    transformEntity,
    transformSketchSelection,
} from "../../src/sketch/utilityOperations";
import "./setup";

test.each([
    ConstraintKind.HorizontalDistance,
    ConstraintKind.VerticalDistance,
])("transformed projected dimension %s retains its driving expression, survives paste, and removes cleanly", (kind) => {
    const scope = new Map([["length", { value: 3, unit: LENGTH_UNITS }]]);
    const geometry: SketchEntityData = {
        id: 1,
        type: "line",
        params: kind === ConstraintKind.HorizontalDistance ? [0, 0, 3, 0] : [0, 0, 0, 3],
    };
    const solver = new SketchSolver(
        Plane.XY,
        {
            entities: [geometry],
            constraints: [
                {
                    id: 1,
                    kind,
                    refs: [
                        { entityId: 1, pointIndex: 0 },
                        { entityId: 1, pointIndex: 1 },
                    ],
                    datum: "length",
                },
                {
                    id: 2,
                    kind: ConstraintKind.Fix,
                    refs: [{ entityId: 1, pointIndex: 0 }],
                    datums: [0, 0],
                },
            ],
        },
        scope,
    );
    try {
        ok(solver.applyTransform([1], { kind: "rotate", center: [0, 0], angle: Math.PI / 4 }));
        expect(solver.solve(true).result.startsWith("Ok")).toBe(true);
        near(
            solver.entity(1)!.params,
            transformEntity(geometry, { kind: "rotate", center: [0, 0], angle: Math.PI / 4 }).params,
        );
        const saved = solver.toData();
        expect(saved.constraints.find((c) => c.id === 1)!.datum).toBe("length");
        const clipboard = ok(copySketchSelection(saved, [1]));
        expect(clipboard.constraints).toHaveLength(2);
        const ids = ok(solver.applyTransform([], { kind: "move", delta: [10, 0] }, clipboard));
        expect(solver.solve(true).result.startsWith("Ok")).toBe(true);
        solver.setScope(new Map([["length", { value: 6, unit: LENGTH_UNITS }]]));
        expect(solver.solve(true).result.startsWith("Ok")).toBe(true);
        const direction = saved.constraints.find((c) => c.id === 1)!.direction!;
        for (const id of [1, ...ids]) {
            const p = solver.entity(id)!.params;
            expect((p[2] - p[0]) * direction[0] + (p[3] - p[1]) * direction[1]).toBeCloseTo(6, 6);
        }
        solver.removeConstraint(1);
        expect(solver.toData().constraints.some((c) => c.id === 1)).toBe(false);
        expect(solver.solve(true).result.startsWith("Ok")).toBe(true);
        solver.removeEntity(ids[0]);
        expect(solver.toData().constraints).toHaveLength(1);
        expect(solver.dofs()).toBe(2);
    } finally {
        solver.dispose();
    }
});

test("fixed coordinate expressions stay live after transformation", () => {
    const scope = new Map([["x", { value: 2, unit: LENGTH_UNITS }]]);
    const solver = new SketchSolver(
        Plane.XY,
        {
            entities: [{ id: 1, type: "point", params: [2, 3] }],
            constraints: [
                { id: 1, kind: ConstraintKind.Fix, refs: [{ entityId: 1, pointIndex: 0 }], datums: ["x", 3] },
            ],
        },
        scope,
    );
    try {
        ok(solver.applyTransform([1], { kind: "rotate", center: [0, 0], angle: Math.PI / 2 }));
        expect([...solver.datumErrors.values()]).toEqual([]);
        expect(solver.solve(true).result.startsWith("Ok")).toBe(true);
        near(solver.entity(1)!.params, [-3, 2]);
        solver.setScope(new Map([["x", { value: 7, unit: LENGTH_UNITS }]]));
        expect(solver.datumErrors.size).toBe(0);
        expect(solver.solve(true).result.startsWith("Ok")).toBe(true);
        near(solver.entity(1)!.params, [-3, 7]);
    } finally {
        solver.dispose();
    }
});

test("projected dimension layout follows its transformed measurement direction", () => {
    const geometry = directedDistanceDimension([0, 0], [0, 10], [0, 1], 20, 1);
    expect(geometry).not.toBeUndefined();
    expect(geometry!.textPosition[0]).toBeLessThan(0);
    expect(geometry!.textPosition[1]).toBeCloseTo(5, 6);
    expect(
        geometry!.segments.some(([x1, y1, x2, y2]) => x1 === -20 && x2 === -20 && y1 === 0 && y2 === 10),
    ).toBe(true);
});

const line: SketchEntityData = { id: 1, type: "line", params: [1, 2, 4, 2] };
const axis: SketchEntityData = { id: 3, type: "line", params: [0, -10, 0, 10], construction: true };
const data: SketchData = {
    entities: [line, { id: 2, type: "circle", params: [4, 2, 2] }, axis],
    constraints: [
        {
            id: 1,
            kind: ConstraintKind.P2PCoincident,
            refs: [
                { entityId: 1, pointIndex: 1 },
                { entityId: 2, pointIndex: 0 },
            ],
        },
        {
            id: 2,
            kind: ConstraintKind.Horizontal,
            refs: [
                { entityId: 1, pointIndex: 0 },
                { entityId: 1, pointIndex: 1 },
            ],
        },
        { id: 3, kind: ConstraintKind.Fix, refs: [{ entityId: 1, pointIndex: 0 }], datums: [1, 2] },
        { id: 4, kind: ConstraintKind.Radius, refs: [{ entityId: 2, pointIndex: 0 }], datum: 2 },
    ],
};

test("mirrored copies follow later source edits through symmetry", () => {
    const solver = new SketchSolver(Plane.XY, data);
    try {
        // Pin the axis so a source edit moves the mirror, rather than the axis itself.
        solver.addConstraint({
            kind: ConstraintKind.Fix,
            refs: [{ entityId: 3, pointIndex: 0 }],
            datums: [0, -10],
        });
        solver.addConstraint({
            kind: ConstraintKind.Fix,
            refs: [{ entityId: 3, pointIndex: 1 }],
            datums: [0, 10],
        });
        const ids = ok(solver.applyTransform([1, 2], { kind: "mirror", axis }, undefined, true));
        expect(solver.solve(true).result.startsWith("Ok")).toBe(true);
        solver.removeConstraint(3);
        solver.addConstraint({
            kind: ConstraintKind.Fix,
            refs: [{ entityId: 1, pointIndex: 0 }],
            datums: [5, 3],
        });
        expect(solver.solve(true).result.startsWith("Ok")).toBe(true);
        const original = solver.entity(1)!.params;
        near(solver.entity(ids[0])!.params, [-original[0], original[1], -original[2], original[3]]);
        expect(original[0]).toBeCloseTo(5, 6);
    } finally {
        solver.dispose();
    }
});
function ok<T>(result: Result<T>): T {
    expect(result.isOk).toBe(true);
    return result.value;
}
function near(actual: number[], expected: number[]): void {
    expect(actual).toHaveLength(expected.length);
    actual.forEach((value, i) => {
        expect(value).toBeCloseTo(expected[i], 6);
    });
}

test.each<SketchEntityData>([
    line,
    { id: 2, type: "circle", params: [1, 2, 3] },
    { id: 3, type: "arc", params: [1, 2, 4, 2, 1, 5] },
    { id: 4, type: "ellipse", params: [1, 2, 4, 2, 1, 4], construction: true },
    { id: 5, type: "point", params: [1, 2] },
    { id: 6, type: "spline", params: [1, 2, 5, 6, 3, 4] },
])("translates and rotates every coordinate of $type", (entity) => {
    const moved = transformEntity(entity, { kind: "move", delta: [10, -5] });
    const rotated = transformEntity(entity, { kind: "rotate", center: [1, 2], angle: Math.PI / 2 });
    const count = entity.type === "circle" ? 2 : entity.params.length;
    for (let i = 0; i < count; i += 2) {
        near(moved.params.slice(i, i + 2), [entity.params[i] + 10, entity.params[i + 1] - 5]);
        near(rotated.params.slice(i, i + 2), [3 - entity.params[i + 1], 1 + entity.params[i]]);
    }
    if (entity.type === "circle") expect(moved.params[2]).toBe(3);
    expect(moved.construction).toBe(entity.construction);
});

test("reflection swaps arc endpoint roles and preserves its sweep", () => {
    const arc: SketchEntityData = { id: 1, type: "arc", params: [2, 1, 5, 1, 2, 4] };
    const reflected = transformEntity(arc, { kind: "mirror", axis });
    near(reflected.params, [-2, 1, -2, 4, -5, 1]);
    expect(arcAngles(reflected.params)[1]).toBeCloseTo(arcAngles(arc.params)[1], 8);
    const proposal = ok(
        transformSketchSelection(
            { entities: [arc, axis], constraints: [] },
            [1],
            { kind: "mirror", axis },
            undefined,
            true,
        ),
    );
    expect(proposal.data.constraints[1].refs[1]).toEqual({ entityId: 4, pointIndex: 2 });
});

test("clipboard is detached, keeps only internal constraints and pastes with monotonic IDs", () => {
    const clipboard = ok(copySketchSelection(data, [1, 2]));
    clipboard.entities[0].params[0] = 100;
    expect(data.entities[0].params[0]).toBe(1);
    const clean = ok(copySketchSelection(data, [1, 2]));
    expect(ok(copySketchSelection(data, [2])).constraints.map((c) => c.id)).toEqual([4]);
    const pasted = ok(
        transformSketchSelection(
            { entities: [], constraints: [], entityIdSeq: 50 },
            [],
            { kind: "move", delta: [10, 20] },
            clean,
        ),
    );
    expect(pasted.ids).toEqual([50, 51]);
    expect(pasted.data.entityIdSeq).toBe(52);
    expect(pasted.data.constraints[0].refs.map((r) => r.entityId)).toEqual([50, 51]);
    expect(pasted.data.constraints[2].datums).toEqual([11, 22]);
    near(pasted.data.entities[0].params, [11, 22, 14, 22]);
});

test.each([
    "move",
    "rotate",
    "mirror",
] as const)("%s survives the real solver with internal relationships", (kind) => {
    const solver = new SketchSolver(Plane.XY, data);
    try {
        const transform =
            kind === "move"
                ? { kind, delta: [10, 20] as [number, number] }
                : kind === "rotate"
                  ? { kind, center: [0, 0] as [number, number], angle: Math.PI / 4 }
                  : { kind, axis };
        ok(solver.applyTransform([1, 2], transform, undefined, kind === "mirror"));
        const before = solver.entities();
        expect(solver.solve(true).result.startsWith("Ok")).toBe(true);
        for (const entity of before) near(solver.entity(entity.id)!.params, entity.params);
        if (kind === "mirror")
            expect(
                solver.toData().constraints.filter((c) => c.kind === ConstraintKind.Symmetric),
            ).toHaveLength(3);
    } finally {
        solver.dispose();
    }
});

test("move detaches external relationships and rejects invalid transforms without mutation", () => {
    const solver = new SketchSolver(Plane.XY, data);
    try {
        ok(solver.applyTransform([2], { kind: "move", delta: [5, 0] }));
        expect(solver.toData().constraints.map((c) => c.id)).toEqual([2, 3, 4]);
        near(solver.entity(1)!.params, line.params);
        const before = solver.toData();
        expect(solver.applyTransform([2], { kind: "move", delta: [NaN, 0] }).isOk).toBe(false);
        expect(
            solver.applyTransform([2], { kind: "mirror", axis: { ...axis, params: [0, 0, 0, 0] } }).isOk,
        ).toBe(false);
        expect(solver.toData()).toEqual(before);
    } finally {
        solver.dispose();
    }
});
