// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { LENGTH_UNITS, Plane, Result } from "@spicy3d/core";
import { createMockApplication, MockShape, TestDocument } from "@spicy3d/core/test-utils";
import { offsetCurve } from "../../src/sketch/geometryEditing";
import { ConstraintKind, type SketchData, type SketchEntityData } from "../../src/sketch/sketchModel";
import { SketchNode } from "../../src/sketch/sketchNode";
import { SketchSolver } from "../../src/sketch/solver";
import { copySketchSelection } from "../../src/sketch/utilityOperations";
import "./setup";

const scope = (value: number) => new Map([["gap", { value, unit: LENGTH_UNITS }]]);
function linked(source: SketchEntityData): SketchData {
    const result = offsetCurve(source, 2);
    expect(result.isOk).toBe(true);
    return {
        entities: [source, { ...result.value.pieces[0], id: 20 }],
        constraints: [
            {
                id: 30,
                kind: ConstraintKind.Offset,
                refs: [source.id, 20].map((entityId) => ({ entityId, pointIndex: 0 })),
                datum: "gap",
            },
        ],
    };
}
const sources: SketchEntityData[] = [
    { id: 10, type: "line", params: [0, 0, 10, 0] },
    { id: 10, type: "circle", params: [0, 0, 10] },
    { id: 10, type: "arc", params: [0, 0, 10, 0, 0, 10] },
    { id: 10, type: "bspline", params: [0, 0, 5, 1, 10, 0] },
    { id: 10, type: "bspline", periodic: true, params: [10, 0, 0, 10, -10, 0, 0, -10] },
    {
        id: 10,
        type: "bspline",
        params: [10, 0, 10, 10, 0, 10],
        control: {
            degree: 2,
            knots: [0, 1],
            multiplicities: [3, 3],
            weights: [1, Math.SQRT1_2, 1],
        },
    },
];

test.each(
    sources,
)("$type (periodic=$periodic) follows source and expression, survives reload, and detaches", (source) => {
    const solver = new SketchSolver(Plane.XY, linked(source), scope(2));
    try {
        expect(solver.entities()).toHaveLength(2);
        expect(solver.isFixed(20)).toBe(true);
        const last = solver.entity(20)!;
        expect(last.derivation).toBe("offset");
        expect(() => solver.setPointPosition({ entityId: 20, pointIndex: 0 }, 1, 1)).toThrow(/Detach/);
        solver.setPointPosition({ entityId: 10, pointIndex: 0 }, source.params[0] + 1, source.params[1]);
        solver.setScope(scope(3));
        solver.solve(false);
        expect(solver.entity(20)).toEqual(last);
        expect(solver.solve(true).result).toMatch(/^Ok/);
        const expected = offsetCurve(solver.entity(10)!, 3);
        expect(expected.isOk).toBe(true);
        expect(solver.entity(20)!.params).toEqual(expected.value.pieces[0].params);
        expect(solver.entity(20)!.params.length).toBeLessThanOrEqual(1024);
        const saved = solver.toData();
        expect(saved.constraints[0].datum).toBe("gap");
        const restored = new SketchSolver(Plane.XY, saved, scope(3));
        try {
            expect(restored.toData()).toEqual(saved);
        } finally {
            restored.dispose();
        }
        solver.removeConstraint(30);
        expect(solver.isFixed(20)).toBe(false);
        expect(solver.entity(20)!.derivation).toBeUndefined();
        const plain = solver.entity(20)!;
        solver.setScope(scope(4));
        solver.solve(true);
        expect(solver.entity(20)).toEqual(plain);
    } finally {
        solver.dispose();
    }
});

test("failed regeneration retains last good target and reports the relation, then recovers", () => {
    const solver = new SketchSolver(Plane.XY, linked(sources[1]), scope(2));
    try {
        const last = solver.entity(20);
        solver.setScope(scope(-12));
        expect(solver.solve(true).result).toBe("Unsolved constraints");
        expect(solver.entity(20)).toEqual(last);
        expect(solver.datumErrors.get(30)).toMatch(/Offset constraint 30:.*collapse/);
        solver.setScope(new Map());
        solver.solve(true);
        expect(solver.datumErrors.get(30)).toContain("Unknown identifier");
        expect(solver.entity(20)).toEqual(last);
        solver.setScope(scope(4));
        expect(solver.solve(true).result).toMatch(/^Ok/);
        expect(solver.entity(20)!.params).toEqual([0, 0, 14]);
        expect(solver.datumErrors.size).toBe(0);
        expect(solver.setDatumSource(30, -20).isOk).toBe(false);
        expect(solver.toData().constraints[0].datum).toBe("gap");
    } finally {
        solver.dispose();
    }
});

test("deleting source detaches target without dangling references", () => {
    const solver = new SketchSolver(Plane.XY, linked(sources[0]), scope(2));
    try {
        const last = solver.entity(20)!.params;
        expect(solver.removeEntity(10)).toEqual([30]);
        expect(solver.toData().constraints).toEqual([]);
        expect(solver.entity(20)!.params).toEqual(last);
        expect(solver.entity(20)!.derivation).toBeUndefined();
        solver.setPointPosition({ entityId: 20, pointIndex: 0 }, 3, 4);
        expect(solver.entity(20)!.params.slice(0, 2)).toEqual([3, 4]);
    } finally {
        solver.dispose();
    }
});

test.each([
    "mirror",
    "paste",
    "copy",
])("%s detaches transformed geometry while originals survive copying", (kind) => {
    const solver = new SketchSolver(Plane.XY, linked(sources[0]), scope(2));
    try {
        const clipboard = copySketchSelection(solver.toData(), [10, 20]);
        expect(clipboard.isOk).toBe(true);
        const transform =
            kind === "rotate"
                ? { kind: "rotate" as const, center: [0, 0] as [number, number], angle: 1 }
                : kind === "mirror"
                  ? { kind: "mirror" as const, axis: { id: -2, type: "line" as const, params: [0, 0, 1, 0] } }
                  : { kind: "move" as const, delta: [3, 4] as [number, number] };
        const copy = kind === "copy";
        const result = solver.applyTransform(
            [10, 20],
            transform,
            kind === "paste" ? clipboard.value : undefined,
            copy,
        );
        expect(result.isOk).toBe(true);
        const duplicate = kind === "paste" || copy;
        expect(solver.toData().constraints.filter((c) => c.kind === ConstraintKind.Offset)).toHaveLength(
            duplicate ? 1 : 0,
        );
        for (const id of result.value) expect(solver.entity(id)!.derivation).toBeUndefined();
    } finally {
        solver.dispose();
    }
});

test("rejects chains, missing sources and extra target constraints by relation id", () => {
    const solver = new SketchSolver(Plane.XY, linked(sources[0]), scope(2));
    try {
        expect(() => solver.validateOffsetSource(20)).toThrow(/chains/);
        expect(() =>
            solver.addConstraint({
                kind: ConstraintKind.Horizontal,
                refs: [0, 1].map((pointIndex) => ({ entityId: 20, pointIndex })),
            }),
        ).toThrow(/Offset constraint 30/);
    } finally {
        solver.dispose();
    }
    const data = linked(sources[0]);
    data.entities.shift();
    expect(() => new SketchSolver(Plane.XY, data, scope(2))).toThrow(/Offset constraint 30:.*missing/);
});

test("64-point periodic source produces a bounded fixed target without extra native curve freedom", () => {
    const source: SketchEntityData = {
        id: 10,
        type: "bspline",
        periodic: true,
        params: Array.from({ length: 64 }, (_, i) => {
            const angle = (2 * Math.PI * i) / 64;
            return [30 * Math.cos(angle), 50 * Math.sin(angle)];
        }).flat(),
    };
    const solver = new SketchSolver(Plane.XY, linked(source), scope(2));
    try {
        expect(solver.solve(true).result).toMatch(/^Ok/);
        expect(solver.dofs()).toBe(128);
        expect(solver.entity(20)!.params.length).toBeLessThanOrEqual(1024);
        const sourceBefore = solver.entity(10);
        expect(solver.removeEntity(20)).toEqual([30]);
        expect(solver.toData().constraints).toEqual([]);
        expect(solver.entity(10)).toEqual(sourceBefore);
        expect(solver.solve(true).result).toMatch(/^Ok/);
    } finally {
        solver.dispose();
    }
});

test("a failed multi-offset pass publishes no partial targets", () => {
    const data = linked(sources[1]);
    data.entities.push({ id: 21, type: "circle", params: [0, 0, 12] });
    data.constraints.push({
        id: 31,
        kind: ConstraintKind.Offset,
        refs: [10, 21].map((entityId) => ({ entityId, pointIndex: 0 })),
        datum: "bad",
    });
    const solver = new SketchSolver(
        Plane.XY,
        data,
        new Map([
            ["gap", { value: 2, unit: LENGTH_UNITS }],
            ["bad", { value: 2, unit: LENGTH_UNITS }],
        ]),
    );
    try {
        const targets = [solver.entity(20), solver.entity(21)];
        solver.setScope(
            new Map([
                ["gap", { value: 4, unit: LENGTH_UNITS }],
                ["bad", { value: -20, unit: LENGTH_UNITS }],
            ]),
        );
        expect(solver.solve(true).result).toBe("Unsolved constraints");
        expect([solver.entity(20), solver.entity(21)]).toEqual(targets);
        expect(solver.datumErrors.get(31)).toContain("Offset constraint 31");
        expect(solver.datumErrors.has(30)).toBe(false);
    } finally {
        solver.dispose();
    }
});

test.each([
    ["move", [10]],
    ["move", [10, 20]],
    ["rotate", [10]],
    ["rotate", [10, 20]],
] as const)("%s in place keeps the offset for selection %j", (kind, ids) => {
    const solver = new SketchSolver(Plane.XY, linked(sources[0]), scope(2));
    try {
        const transform =
            kind === "move"
                ? { kind, delta: [3, 4] as [number, number] }
                : { kind, center: [0, 0] as [number, number], angle: Math.PI / 2 };
        const result = solver.applyTransform(ids, transform);
        expect(result.isOk).toBe(true);
        expect(solver.toData().constraints).toEqual(linked(sources[0]).constraints);
        const expected = offsetCurve(solver.entity(10)!, 2);
        expect(expected.isOk).toBe(true);
        expect(solver.entity(20)!.params).toEqual(expected.value.pieces[0].params);
        expect(solver.entity(20)!.derivation).toBe("offset");
        expect(solver.solve(true).result).toMatch(/^Ok/);
    } finally {
        solver.dispose();
    }
});

test("fork and reset retry failed offsets without replacing last good targets", () => {
    const solver = new SketchSolver(Plane.XY, linked(sources[1]), scope(-50));
    const fork = solver.fork();
    try {
        expect(fork.entity(20)!.params).toEqual([0, 0, 12]);
        expect([...fork.offsetErrors.values()]).toEqual([...solver.offsetErrors.values()]);
        fork.reset(fork.toData());
        expect(fork.entity(20)!.params).toEqual([0, 0, 12]);
        expect(fork.offsetErrors.get(30)).toMatch(/Offset constraint 30:.*collapse/);
        fork.setScope(scope(3));
        expect(fork.solve(true).result).toMatch(/^Ok/);
        expect(fork.offsetErrors.size).toBe(0);
        expect(fork.entity(20)!.params).toEqual([0, 0, 13]);
    } finally {
        fork.dispose();
        solver.dispose();
    }
});

test.each([-1, -2, -3])("datum source %s reports an editable-curve error", (id) => {
    const solver = new SketchSolver(Plane.XY);
    try {
        expect(() => solver.validateOffsetSource(id)).toThrow("The source must be an editable sketch curve");
    } finally {
        solver.dispose();
    }
});

test.each([false, true])("unresolved non-offset datum still builds (offset=%s)", (withOffset) => {
    const doc = new TestDocument({ application: createMockApplication() });
    const data = withOffset ? linked(sources[1]) : { entities: [sources[1]], constraints: [] };
    if (withOffset) data.constraints[0].datum = 2;
    data.constraints.push({
        id: 40,
        kind: ConstraintKind.Radius,
        refs: [{ entityId: 10, pointIndex: 0 }],
        datum: "missing",
    });
    const previous = Object.getOwnPropertyDescriptor(globalThis, "shapeFactory");
    rs.stubGlobal("shapeFactory", {
        circle: () => Result.ok(new MockShape()),
        combine: () => Result.ok(new MockShape()),
    });
    try {
        const node = new SketchNode({ document: doc, plane: Plane.XY, data });
        doc.modelManager.addNode(node);
        expect(node.shape.isOk).toBe(true);
        expect(node.warningCount).toBe(0);
        doc.variables.setItems([{ id: "other", name: "other", expression: "3", type: "length" }]);
        expect(node.shape.isOk).toBe(true);
        expect(node.warningCount).toBe(0);
        const solver = node.createSolver();
        try {
            expect(solver.datumErrors.get(40)).toContain("Unknown identifier");
            expect(solver.offsetErrors.size).toBe(0);
        } finally {
            solver.dispose();
        }
    } finally {
        rs.unstubAllGlobals();
        if (previous) Object.defineProperty(globalThis, "shapeFactory", previous);
        doc.dispose();
    }
});

test("external offset source reports an editable-curve error", () => {
    const solver = new SketchSolver(Plane.XY);
    try {
        solver.addExternalEntity({
            entityId: -100,
            nodeId: "source",
            role: "reference",
            edge: { kind: "line", start: { x: 0, y: 0, z: 0 }, end: { x: 10, y: 0, z: 0 } },
            snapshot: [0, 0, 10, 0],
            type: "line",
        });
        expect(() => solver.validateOffsetSource(-100)).toThrow(
            "The source must be an editable sketch curve",
        );
    } finally {
        solver.dispose();
    }
});

test("moving only an offset target is refused without modifying the relation or geometry", () => {
    const solver = new SketchSolver(Plane.XY, linked(sources[0]), scope(2));
    try {
        const before = solver.toData();
        const result = solver.applyTransform([20], { kind: "move", delta: [3, 4] });
        expect(result.isOk).toBe(false);
        expect(result.error).toContain("Detach the offset relation");
        expect(solver.toData()).toEqual(before);
    } finally {
        solver.dispose();
    }
});
