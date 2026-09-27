// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import { Plane } from "@spicy3d/core";
import { loadDocumentFixtures } from "@spicy3d/core/test-utils";
import {
    randomSketchIds,
    SKETCH_ID_SPACE,
    type SketchIdAllocator,
    sequentialSketchIds,
} from "../../src/sketch/sketchIds";
import {
    ConstraintKind,
    type ExternalRefData,
    FIRST_EXTERNAL_ENTITY_ID,
    type SketchData,
} from "../../src/sketch/sketchModel";
import { SketchSolver } from "../../src/sketch/solver";
import { transformSketchSelection } from "../../src/sketch/utilityOperations";
import "./setup";

const EXTERNAL: ExternalRefData = {
    entityId: -100,
    nodeId: "src",
    edge: { kind: "line", start: { x: 0, y: 0, z: 0 }, end: { x: 10, y: 0, z: 0 } },
    role: "reference",
    snapshot: [0, 0, 10, 0],
    type: "line",
};

/** A saved sketch both "devices" start from: the fixture rectangle plus one projected edge. */
function baseSketch(): SketchData {
    return {
        entities: [
            { id: 1, type: "line", params: [0, 0, 40, 0] },
            { id: 2, type: "line", params: [40, 0, 40, 20] },
            { id: 3, type: "line", params: [40, 20, 0, 20] },
            { id: 4, type: "line", params: [0, 20, 0, 0] },
        ],
        constraints: [
            {
                id: 1,
                kind: ConstraintKind.P2PCoincident,
                refs: [
                    { entityId: 1, pointIndex: 1 },
                    { entityId: 2, pointIndex: 0 },
                ],
            },
        ],
        externalRefs: [{ ...EXTERNAL }],
    };
}

interface Added {
    entities: number[];
    constraints: number[];
    externals: number[];
}

/** One device's offline session on the base: lines, constraints, a projected edge and a pasted copy. */
function editOnDevice(ids: SketchIdAllocator): Added {
    const base = baseSketch();
    const solver = new SketchSolver(Plane.XY, base, undefined, ids);
    try {
        for (let i = 0; i < 30; i++) {
            const line = solver.addLine(i, 30, i + 1, 31);
            solver.addConstraint({
                kind: ConstraintKind.Horizontal,
                refs: [
                    { entityId: line, pointIndex: 0 },
                    { entityId: line, pointIndex: 1 },
                ],
            });
        }
        const external = solver.allocateExternalEntityId();
        solver.addExternalEntity({ ...EXTERNAL, entityId: external, snapshot: [0, 5, 10, 5] });
        const pasted = transformSketchSelection(
            solver.toData(),
            [1, 2],
            { kind: "move", delta: [0, 50] },
            undefined,
            true,
            ids,
        );
        expect(pasted.isOk).toBe(true);
        const data = pasted.value.data;
        const baseEntities = new Set(base.entities.map((e) => e.id));
        const baseConstraints = new Set(base.constraints.map((c) => c.id));
        return {
            entities: data.entities.map((e) => e.id).filter((id) => !baseEntities.has(id)),
            constraints: data.constraints.map((c) => c.id).filter((id) => !baseConstraints.has(id)),
            externals: (data.externalRefs ?? [])
                .map((r) => r.entityId)
                .filter((id) => id !== EXTERNAL.entityId),
        };
    } finally {
        solver.dispose();
    }
}

describe("random sketch ids", () => {
    test.each([
        "entity",
        "constraint",
    ] as const)("%s ids are positive safe integers within the id space", (kind) => {
        for (let i = 0; i < 1000; i++) {
            const id = randomSketchIds.next(kind, () => false);
            expect(Number.isSafeInteger(id)).toBe(true);
            expect(id).toBeGreaterThanOrEqual(1);
            expect(id).toBeLessThanOrEqual(SKETCH_ID_SPACE);
        }
    });

    test("external ids stay below the reserved external boundary", () => {
        for (let i = 0; i < 1000; i++) {
            const id = randomSketchIds.next("external", () => false);
            expect(Number.isSafeInteger(id)).toBe(true);
            expect(id).toBeLessThan(FIRST_EXTERNAL_ENTITY_ID);
            expect(id).toBeGreaterThanOrEqual(FIRST_EXTERNAL_ENTITY_ID - SKETCH_ID_SPACE);
        }
    });

    test("an id already taken is drawn again", () => {
        const draws = [0, 0, 0.5];
        const random = rs.spyOn(Math, "random").mockImplementation(() => draws.shift() ?? 0.25);
        try {
            // the first two draws give id 1, which the sketch already holds
            const id = randomSketchIds.next("entity", (candidate) => candidate === 1);
            expect(id).toBe(SKETCH_ID_SPACE / 2 + 1);
            expect(random).toHaveBeenCalledTimes(3);
        } finally {
            random.mockRestore();
        }
    });

    test("two devices editing the same saved sketch never allocate the same id", () => {
        const a = editOnDevice(randomSketchIds);
        const b = editOnDevice(randomSketchIds);
        const base = baseSketch();
        for (const [ours, theirs, existing] of [
            [a.entities, b.entities, base.entities.map((e) => e.id)],
            [a.constraints, b.constraints, base.constraints.map((c) => c.id)],
            [a.externals, b.externals, [EXTERNAL.entityId]],
        ]) {
            expect(ours.length).toBeGreaterThan(0);
            expect(theirs).toHaveLength(ours.length);
            const all = [...existing, ...ours, ...theirs];
            expect(new Set(all).size).toBe(all.length);
        }
    });

    test("the counting allocator is what collides — the case random ids exist for", () => {
        const a = editOnDevice(sequentialSketchIds());
        const b = editOnDevice(sequentialSketchIds());
        expect(a.entities).toEqual(b.entities);
    });
});

describe("sequential sketch ids", () => {
    test("each kind counts on its own and skips taken ids", () => {
        const ids = sequentialSketchIds();
        const taken = new Set([1, 2, -100]);
        expect(ids.next("entity", (id) => taken.has(id))).toBe(3);
        expect(ids.next("entity", (id) => taken.has(id))).toBe(4);
        expect(ids.next("constraint", () => false)).toBe(1);
        expect(ids.next("external", (id) => taken.has(id))).toBe(-101);
        expect(ids.next("external", () => false)).toBe(-102);
    });
});

describe("existing documents", () => {
    test("every stored sketch round-trips through the solver unchanged, whatever the allocator", () => {
        const sketches = loadDocumentFixtures().flatMap((fixture) =>
            (fixture.data["models"].nodes as { __cla$$__: string; dataJson?: string }[])
                .filter((node) => node.__cla$$__ === "SketchNode")
                .map((node) => JSON.parse(node.dataJson!) as SketchData),
        );
        expect(sketches.length).toBeGreaterThan(0);
        for (const data of sketches) {
            const solver = new SketchSolver(Plane.XY, data, undefined, randomSketchIds);
            try {
                expect(solver.toData()).toEqual(data);
            } finally {
                solver.dispose();
            }
        }
    });
});
