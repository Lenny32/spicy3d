// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Plane } from "@spicy3d/core";
import { ellipseParams } from "../../src/sketch/commands/sketchEllipse";
import { addPolygon, polygonVertices } from "../../src/sketch/commands/sketchPolygon";
import { ConstraintKind, ellipsePoint, shapeEntityIds } from "../../src/sketch/sketchModel";
import { SketchSolver } from "../../src/sketch/solver";
import "./setup";

describe("geometry foundations", () => {
    let solver: SketchSolver;
    beforeEach(() => {
        solver = new SketchSolver(Plane.XY);
    });
    afterEach(() => {
        solver.dispose();
    });

    test.each([3, 4, 6, 11])("inscribed %i-gon remains regular when its radius changes", (sides) => {
        checkPolygon(sides, true);
    });

    test.each([3, 4, 6, 11])("circumscribed %i-gon remains regular when its radius changes", (sides) => {
        checkPolygon(sides, false);
    });

    function checkPolygon(sides: number, inscribed: boolean): void {
        const result = addPolygon(solver, [5, 7], [15, 7], sides, inscribed);
        expect(result.isOk).toBe(true);
        const { circle, edges } = result.value;
        expect(solver.dofs()).toBe(4);
        expect(shapeEntityIds(solver.toData())).toEqual(edges);
        solver.addConstraint({
            kind: ConstraintKind.Fix,
            refs: [{ entityId: circle, pointIndex: 0 }],
            datums: [5, 7],
        });
        const radius = solver.addConstraint({
            kind: ConstraintKind.Radius,
            refs: [{ entityId: circle, pointIndex: 0 }],
            datum: 10,
        });
        solver.setDatum(radius, 14);
        expect(solver.solve(true).result).toMatch(/^Ok/);
        const expectedRadius = inscribed ? 14 : 14 / Math.cos(Math.PI / sides);
        const expectedLength = 2 * expectedRadius * Math.sin(Math.PI / sides);
        for (const [i, id] of edges.entries()) {
            const [x1, y1, x2, y2] = solver.entity(id)!.params;
            expect(Math.hypot(x1 - 5, y1 - 7)).toBeCloseTo(expectedRadius, 5);
            expect(Math.hypot(x2 - x1, y2 - y1)).toBeCloseTo(expectedLength, 5);
            const next = solver.pointOf({ entityId: edges[(i + 1) % sides], pointIndex: 0 });
            expect(x2).toBeCloseTo(next[0], 5);
            expect(y2).toBeCloseTo(next[1], 5);
        }
        const data = solver.toData();
        solver.reset(data);
        expect(solver.toData()).toEqual(data);
        expect(solver.entity(circle)?.construction).toBe(true);
        expect(solver.solve(true).result).toMatch(/^Ok/);
    }

    test.each([
        2,
        3.5,
        Number.NaN,
        Number.POSITIVE_INFINITY,
    ])("rejects invalid polygon side count %s without mutation", (sides) => {
        expect(addPolygon(solver, [0, 0], [10, 0], sides).isOk).toBe(false);
        expect(solver.entities()).toEqual([]);
    });

    test("rejects a zero polygon radius", () => {
        expect(polygonVertices([1, 2], [1, 2], 6, true).isOk).toBe(false);
    });

    test("standalone point binds to line endpoints and survives serialization", () => {
        const point = solver.addPoint(4, 5);
        expect(solver.dofs()).toBe(2);
        const line = solver.addLine(7, 8, 12, 8);
        solver.addConstraint({
            kind: ConstraintKind.Fix,
            refs: [{ entityId: point, pointIndex: 0 }],
            datums: [4, 5],
        });
        solver.addConstraint({
            kind: ConstraintKind.P2PCoincident,
            refs: [
                { entityId: point, pointIndex: 0 },
                { entityId: line, pointIndex: 0 },
            ],
        });
        expect(solver.solve(true).result).toMatch(/^Ok/);
        const endpoint = solver.pointOf({ entityId: line, pointIndex: 0 });
        expect(endpoint[0]).toBeCloseTo(4, 6);
        expect(endpoint[1]).toBeCloseTo(5, 6);
        expect(shapeEntityIds(solver.toData())).toEqual([line]);
        const data = solver.toData();
        solver.reset(data);
        expect(solver.toData()).toEqual(data);
        solver.removeEntity(point);
        expect(solver.toData().constraints).toEqual([]);
    });

    test.each([false, true])("ellipse input mode foci=%s produces the same exact axes", (foci) => {
        const params = foci
            ? ellipseParams([-4, 0], [4, 0], [0, 3], true)
            : ellipseParams([0, 0], [5, 0], [0, 3]);
        expect(params.isOk).toBe(true);
        expect(params.value).toEqual([0, 0, 5, 0, 0, 3]);
        const id = solver.addEllipse(...params.value);
        expect(solver.dofs()).toBe(5);
        const refs = [0, 1, 2].map((pointIndex) => ({ entityId: id, pointIndex }));
        solver.addConstraint({ kind: ConstraintKind.Fix, refs: [refs[0]], datums: [0, 0] });
        solver.addConstraint({ kind: ConstraintKind.P2PDistance, refs: [refs[0], refs[1]], datum: 8 });
        solver.addConstraint({ kind: ConstraintKind.P2PDistance, refs: [refs[0], refs[2]], datum: 2 });
        expect(solver.solve(true).result).toMatch(/^Ok/);
        const [cx, cy, ax, ay, bx, by] = solver.entity(id)!.params;
        expect(Math.hypot(ax - cx, ay - cy)).toBeCloseTo(8, 6);
        expect(Math.hypot(bx - cx, by - cy)).toBeCloseTo(2, 6);
        expect((ax - cx) * (bx - cx) + (ay - cy) * (by - cy)).toBeCloseTo(0, 6);
        const data = solver.toData();
        solver.reset(data);
        expect(solver.toData()).toEqual(data);
        expect(solver.solve(true).result).toMatch(/^Ok/);
    });

    test("center/major-axis input passes through an arbitrary rim point", () => {
        const params = ellipseParams([2, 3], [7, 3], [5, 5.4]);
        expect(params.isOk).toBe(true);
        const point = ellipsePoint(params.value, Math.acos(3 / 5));
        expect(point[0]).toBeCloseTo(5, 8);
        expect(point[1]).toBeCloseTo(5.4, 8);
    });

    test.each([
        [[0, 0], [0, 0], [0, 2], false],
        [[0, 0], [5, 0], [5, 0], false],
        [[-4, 0], [4, 0], [0, 0], true],
    ] as const)("rejects degenerate ellipse input %j %j %j", (a, b, c, foci) => {
        expect(ellipseParams([...a], [...b], [...c], foci).isOk).toBe(false);
    });
});
