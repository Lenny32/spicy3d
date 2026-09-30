// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IEdge, Precision, XYZ } from "@spicy3d/core";
import fc from "fast-check";
import { groupConnected, hasBranchVertex } from "../src/features/profileGeometry";

interface CountingEdge extends IEdge {
    readonly name: string;
    readonly queries: () => number;
}

function edge(name: string, start: [number, number], end: [number, number]): CountingEdge {
    const a = new XYZ({ x: start[0], y: start[1], z: 0 });
    const b = new XYZ({ x: end[0], y: end[1], z: 0 });
    let queries = 0;
    return {
        name,
        queries: () => queries,
        startPoint: () => {
            queries++;
            return a;
        },
        endPoint: () => {
            queries++;
            return b;
        },
    } as unknown as CountingEdge;
}

/** The grouping as it was before the grid index — the order every profile index depends on. */
function referenceGroupConnected(edges: IEdge[]): IEdge[][] {
    const coincides = (a: XYZ, b: XYZ) => a.distanceTo(b) < Precision.Distance;
    const ends = (e: IEdge) => [e.startPoint(), e.endPoint()];
    const touches = (group: IEdge[], e: IEdge) =>
        group.some((x) => ends(x).some((a) => ends(e).some((b) => coincides(a, b))));
    const remaining = [...edges];
    const groups: IEdge[][] = [];
    while (remaining.length > 0) {
        const group = [remaining.shift()!];
        let grew = true;
        while (grew) {
            grew = false;
            for (let i = remaining.length - 1; i >= 0; i--) {
                if (touches(group, remaining[i])) {
                    group.push(remaining.splice(i, 1)[0]);
                    grew = true;
                }
            }
        }
        groups.push(group);
    }
    return groups;
}

function names(groups: IEdge[][]): string[][] {
    return groups.map((group) => group.map((e) => (e as CountingEdge).name));
}

function rectangle(prefix: string, x: number, y: number, size: number): CountingEdge[] {
    return [
        edge(`${prefix}0`, [x, y], [x + size, y]),
        edge(`${prefix}1`, [x + size, y], [x + size, y + size]),
        edge(`${prefix}2`, [x + size, y + size], [x, y + size]),
        edge(`${prefix}3`, [x, y + size], [x, y]),
    ];
}

describe("groupConnected", () => {
    test("groups follow the lowest remaining edge and keep the historical in-group order", () => {
        // Two rectangles interleaved in entity order, plus a divider hanging off the
        // first one's corner and a lone segment.
        const a = rectangle("a", 0, 0, 10);
        const b = rectangle("b", 20, 0, 10);
        const divider = edge("d", [10, 10], [15, 15]);
        const lone = edge("l", [50, 50], [60, 50]);
        const edges = [a[2], b[0], a[0], divider, b[3], a[3], lone, b[1], a[1], b[2]];

        expect(names(groupConnected(edges))).toEqual([
            ["a2", "a1", "a3", "d", "a0"],
            ["b0", "b1", "b3", "b2"],
            ["l"],
        ]);
        expect(names(groupConnected(edges))).toEqual(names(referenceGroupConnected(edges)));
    });

    test("an ascending chain comes out in chain order, one edge per scan pass", () => {
        const chain = Array.from({ length: 6 }, (_, i) => edge(`c${i}`, [i, 0], [i + 1, 0]));
        expect(names(groupConnected(chain))).toEqual([["c0", "c1", "c2", "c3", "c4", "c5"]]);
    });

    test("endpoints a hair apart (below Precision.Distance) still connect across grid cells", () => {
        const offset = Precision.Distance / 2;
        const first = edge("p", [0, 0], [1, 0]);
        // Straddles a grid cell boundary on the x axis.
        const second = edge("q", [1 + offset, 0], [2, 0]);
        const apart = edge("r", [2 + 2 * Precision.Distance, 0], [3, 0]);
        expect(names(groupConnected([first, second, apart]))).toEqual([["p", "q"], ["r"]]);
    });

    test("reads each edge's endpoints once, however many edges there are", () => {
        const edges = Array.from({ length: 30 }, (_, i) => rectangle(`r${i}_`, i * 20, 0, 10)).flat();
        const groups = groupConnected(edges);
        expect(groups).toHaveLength(30);
        expect(edges.map((e) => e.queries())).toEqual(edges.map(() => 2));
    });

    test("matches the historical grouping on random sketches", () => {
        const coordinate = fc.integer({ min: 0, max: 4 });
        const segment = fc.tuple(coordinate, coordinate, coordinate, coordinate);
        fc.assert(
            fc.property(fc.array(segment, { maxLength: 24 }), (segments) => {
                const edges = segments.map(([x1, y1, x2, y2], i) => edge(`${i}`, [x1, y1], [x2, y2]));
                expect(names(groupConnected(edges))).toEqual(names(referenceGroupConnected(edges)));
            }),
            { numRuns: 300, seed: 47 },
        );
    });
});

describe("hasBranchVertex", () => {
    test("a simple loop has no branch vertex", () => {
        expect(hasBranchVertex(rectangle("a", 0, 0, 10))).toBe(false);
    });

    test("three endpoints meeting at a corner are a branch vertex", () => {
        expect(hasBranchVertex([...rectangle("a", 0, 0, 10), edge("d", [10, 10], [15, 15])])).toBe(true);
    });

    test("a zero-length edge doubles its point, making a branch with one neighbour", () => {
        expect(hasBranchVertex([edge("z", [0, 0], [0, 0]), edge("n", [0, 0], [1, 0])])).toBe(true);
    });
});
