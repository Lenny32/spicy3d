// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import { LENGTH_UNITS, Plane } from "@spicy3d/core";
import * as ownership from "../../src/sketch/associativeOffset";
import { ConstraintKind, type SketchData } from "../../src/sketch/sketchModel";
import { SketchSolver } from "../../src/sketch/solver";
import "./setup";

const scope = (value: number) => new Map([["gap", { value, unit: LENGTH_UNITS }]]);
const ref = (entityId: number, pointIndex: number) => ({ entityId, pointIndex });

test("bulk loading validates offset ownership once rather than once per constraint", () => {
    const data: SketchData = { entities: [], constraints: [] };
    for (let i = 1; i <= 150; i++) {
        data.entities.push({ id: i, type: "line", params: [i - 1, 0, i, 0] });
        data.constraints.push({ id: i, kind: ConstraintKind.Horizontal, refs: [ref(i, 0), ref(i, 1)] });
        data.constraints.push({
            id: i + 150,
            kind: ConstraintKind.P2PDistance,
            refs: [ref(i, 0), ref(i, 1)],
            datum: 1,
        });
    }
    data.entities.push({ id: 151, type: "line", params: [0, 2, 1, 2] });
    data.constraints.push({
        id: 301,
        kind: ConstraintKind.Offset,
        refs: [ref(1, 0), ref(151, 0)],
        datum: "gap",
    });
    const validation = rs.spyOn(ownership, "validateOffsetRelations");
    let solver: SketchSolver | undefined;
    try {
        solver = new SketchSolver(Plane.XY, data, scope(2));
        const calls = validation.mock.calls.length;
        for (const gap of [3, 5, 1, 4, 2]) {
            solver.setScope(scope(gap));
            expect(solver.solve(true).result).toMatch(/^Ok/);
        }
        expect(calls).toBe(1);
        expect(validation).toHaveBeenCalledTimes(6);
        // Interactive constraints still validate ownership after the bulk-load flag clears.
        const before = solver.toData();
        expect(() =>
            solver!.addConstraint({
                kind: ConstraintKind.P2PDistance,
                refs: [ref(151, 0), ref(151, 1)],
                datum: 1,
            }),
        ).toThrow(/Detach/);
        expect(validation).toHaveBeenCalledTimes(7);
        expect(solver.toData()).toEqual(before);
    } finally {
        solver?.dispose();
        validation.mockRestore();
    }
});
