// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IWire, ShapeTypes, XYZ } from "@spicy3d/core";
import { createTestFactory, unwrapOk } from "./helpers";
import "./setup";

const p = (x: number, y: number, z: number) => new XYZ({ x, y, z });
const inputsOf = (pairs: number[], output: number) => [
    ...new Set(
        pairs.flatMap((value, index) => (index % 2 === 0 && value === output ? [pairs[index + 1]] : [])),
    ),
];
const factory = () => createTestFactory();
function squareWire(): IWire {
    const f = factory();
    const points = [p(-1, -1, 0), p(1, -1, 0), p(1, 1, 0), p(-1, 1, 0)];
    return unwrapOk(f.wire(points.map((a, index) => unwrapOk(f.line(a, points[(index + 1) % 4])))));
}

describe("tracked pipe-shell sweep", () => {
    test("each embind history vector is read and released exactly once", () => {
        const f = factory();
        const section = squareWire();
        const path = unwrapOk(f.wire([unwrapOk(f.line(XYZ.zero, p(0, 0, 10)))]));
        const keys = [
            "pipeFaceEdges",
            "pipeFaceVertices",
            "pipeEdgeVertices",
            "pipeStartEdges",
            "pipeEndEdges",
            "pipeStartFaces",
        ];
        const reads = new Map<string, number>();
        const releases = new Map<string, number>();
        const native = wasm.ShapeFactory.sweepTracked;
        const spy = rs.spyOn(wasm.ShapeFactory, "sweepTracked").mockImplementation((...args) => {
            const result = native(...args);
            return new Proxy(result, {
                get(target, key) {
                    const value = Reflect.get(target, key);
                    if (typeof key === "string" && keys.includes(key)) {
                        reads.set(key, (reads.get(key) ?? 0) + 1);
                        return new Proxy(value, {
                            get(vector, property) {
                                if (property === "delete")
                                    return () => {
                                        releases.set(key, (releases.get(key) ?? 0) + 1);
                                        vector.delete();
                                    };
                                const member = Reflect.get(vector, property);
                                return typeof member === "function" ? member.bind(vector) : member;
                            },
                        });
                    }
                    return typeof value === "function" ? value.bind(target) : value;
                },
            });
        });
        try {
            const result = unwrapOk(f.sweepTracked(section, path, true, false));
            expect(result.shape.volume()).toBeCloseTo(40, 6);
            for (const key of keys) {
                expect(reads.get(key)).toBe(1);
                expect(releases.get(key)).toBe(1);
            }
            result.shape.dispose();
        } finally {
            spy.mockRestore();
            section.dispose();
            path.dispose();
        }
    });
    test("a straight solid reports both section and spine face origins plus exact caps", () => {
        const f = factory();
        const section = squareWire();
        const path = unwrapOk(f.wire([unwrapOk(f.line(XYZ.zero, p(0, 0, 10)))]));
        const result = unwrapOk(f.sweepTracked(section, path, true, false));
        expect(result.shape.shapeType).toBe(ShapeTypes.solid);
        expect(result.shape.volume()).toBeCloseTo(40, 6);
        expect(result.shape.checkShape()).toBe(true);
        expect(result.pipeHistory).toBeTruthy();
        const history = result.pipeHistory!;
        expect(history.startFaces).toHaveLength(1);
        expect(result.capFaces).toHaveLength(1);
        expect(history.startFaces[0]).not.toBe(result.capFaces![0]);
        expect(history.startEdges).toHaveLength(4);
        expect(history.endEdges).toHaveLength(4);
        const caps = new Set([...history.startFaces, ...result.capFaces!]);
        for (const [index] of result.shape.findSubShapes(ShapeTypes.face).entries()) {
            if (caps.has(index)) continue;
            const origins = inputsOf(history.faceEdges, index);
            expect(origins.filter((origin) => origin < 4)).toHaveLength(1);
            expect(origins).toContain(4);
        }
        expect(history.edgeVertices.length).toBeGreaterThan(0);
    });

    test.each([false, true])("multi-segment 3D sweep keeps combined ancestry (round=%s)", (round) => {
        const f = factory();
        const path = unwrapOk(
            f.wire([unwrapOk(f.line(XYZ.zero, p(0, 0, 10))), unwrapOk(f.line(p(0, 0, 10), p(5, 5, 20)))]),
        );
        const result = unwrapOk(f.sweepTracked(squareWire(), path, true, round));
        expect(result.shape.checkShape()).toBe(true);
        expect(result.shape.volume()).toBeGreaterThan(40);
        const history = result.pipeHistory!;
        const origins = history.faceEdges.filter((_, index) => index % 2 === 1);
        expect(origins).toContain(4);
        expect(origins).toContain(5);
        expect(history.faceVertices.length + history.edgeVertices.length).toBeGreaterThan(0);
    });

    test("a closed curved path has native side and seam history without invented cap faces", () => {
        const f = factory();
        const circle = unwrapOk(f.circle(XYZ.unitZ, XYZ.zero, 10));
        const path = unwrapOk(f.wire([circle]));
        const { point: start, vec } = circle.curve.d1(circle.curve.firstParameter());
        expect(start).not.toBeUndefined();
        if (!start) throw new Error("Circle has no initial point");
        const tangent = vec.normalize();
        expect(tangent).not.toBeUndefined();
        if (!tangent) throw new Error("Circle has no initial tangent");
        const section = unwrapOk(f.wire([unwrapOk(f.circle(tangent, start, 1))]));
        const result = unwrapOk(f.sweepTracked(section, path, true, false));
        expect(result.shape.checkShape()).toBe(true);
        expect(result.shape.volume()).toBeCloseTo(20 * Math.PI ** 2, 4);
        expect(result.capFaces).toEqual([]);
        expect(result.pipeHistory!.startFaces).toEqual([]);
        expect(inputsOf(result.pipeHistory!.faceEdges, 0)).toEqual(expect.arrayContaining([0, 1]));
        expect(result.pipeHistory!.startEdges.length).toBeGreaterThan(0);
        expect(unwrapOk(result.shape.checkSelfIntersection!())).toBe(true);
    });

    test("an open sweep remains a shell and an open section cannot silently produce a solid", () => {
        const f = factory();
        const path = unwrapOk(f.wire([unwrapOk(f.line(XYZ.zero, p(0, 0, 10)))]));
        const shell = unwrapOk(f.sweepTracked(squareWire(), path, false, false));
        expect(shell.shape.shapeType).toBe(ShapeTypes.shell);
        expect(shell.shape.checkShape()).toBe(true);
        expect(shell.pipeHistory!.startFaces).toEqual([]);
        expect(shell.capFaces).toEqual([]);
        const open = unwrapOk(f.wire([unwrapOk(f.line(p(-1, 0, 0), p(1, 0, 0)))]));
        const invalid = f.sweepTracked(open, path, true, false);
        expect(invalid.isOk).toBe(false);
        expect(invalid.error).toMatch(/solid|non-planar profile/);
    });
});
