// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { lockedEntityIds, lockedGroupOf } from "../../src/sketch/lockedGroups";
import {
    ConstraintKind,
    type SketchConstraintData,
    type SketchEntityData,
} from "../../src/sketch/sketchModel";

const line = (id: number, ...params: number[]): SketchEntityData => ({ id, type: "line", params });
const lock = (id: number): SketchConstraintData => ({
    id: 100 + id,
    kind: ConstraintKind.Block,
    refs: [{ entityId: id, pointIndex: 0 }],
});

const entities: SketchEntityData[] = [
    // a 10 × 10 square
    line(1, 0, 0, 10, 0),
    line(2, 10, 0, 10, 10),
    line(3, 10, 10, 0, 10),
    line(4, 0, 10, 0, 0),
    // a hole inside it, as a circle
    { id: 5, type: "circle", params: [5, 5, 2] },
    // a separate outline further right
    line(6, 30, 0, 40, 0),
    // a free line crossing the square
    line(7, -5, 5, 15, 5),
];

test("a locked piece's drawing gathers what touches it and what lies inside it, not apart or unlocked", () => {
    const data = { entities, constraints: [1, 2, 3, 4, 5, 6].map(lock) };
    expect(lockedEntityIds(data)).toEqual(new Set([1, 2, 3, 4, 5, 6]));
    expect(lockedGroupOf(data, 1)?.sort()).toEqual([1, 2, 3, 4, 5]);
    expect(lockedGroupOf(data, 5)?.sort()).toEqual([1, 2, 3, 4, 5]);
    expect(lockedGroupOf(data, 6)).toEqual([6]);
    expect(lockedGroupOf(data, 7)).toBeUndefined();
});
