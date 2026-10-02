// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    assembleManifest,
    decodeDocumentFile,
    encodeDocumentFile,
    LENGTH_UNITS,
    mergeDocuments,
    Plane,
    resolveMerge,
    type Serialized,
    splitManifest,
} from "@spicy3d/core";
import { loadDocumentFixtures } from "@spicy3d/core/test-utils";
import "@spicy3d/app";
import "@spicy3d/parametric";
import "@spicy3d/wasm";
import { validateOffsetRelations } from "../../parametric/src/sketch/associativeOffset";
import type { SketchData } from "../../parametric/src/sketch/sketchModel";
import { SketchSolver } from "../../parametric/src/sketch/solver";
import "../../parametric/test/sketch/setup";

function fixture(): Serialized {
    const found = loadDocumentFixtures().find((entry) => entry.name === "v2/sketch6-associative-offset.json");
    expect(found).not.toBeUndefined();
    return structuredClone(found!.data);
}
function node(doc: Serialized): Serialized {
    return doc["models"].nodes[1];
}
function data(doc: Serialized): SketchData {
    return JSON.parse(node(doc)["dataJson"]);
}
function edit(doc: Serialized, change: (payload: SketchData) => void): Serialized {
    const result = structuredClone(doc),
        payload = data(result);
    change(payload);
    node(result)["dataJson"] = JSON.stringify(payload);
    return result;
}
const scope = new Map([["gap", { value: 2, unit: LENGTH_UNITS }]]);

test.each([
    false,
    true,
])("source and distance merge independently (manifest=%s), then regenerate", async (manifest) => {
    const base = fixture();
    const ours = edit(base, (p) => {
        p.entities[0].params[2] = 14;
        p.entities[1].params[2] = 16;
    });
    const theirs = edit(base, (p) => {
        p.constraints[0].datum = "gap + 1 mm";
        p.entities[1].params[2] = 13;
    });
    const documents = [base, ours, theirs];
    const snapshots = await Promise.all(documents.map((doc) => splitManifest(doc)));
    const inputs = manifest ? snapshots.map((snapshot) => snapshot.manifest) : documents;
    const merged = mergeDocuments(inputs[0], inputs[1], inputs[2]);
    expect(merged.isOk).toBe(true);
    expect(merged.value.conflicts).toEqual([]);
    const blobs = new Map(snapshots.flatMap((snapshot) => [...snapshot.blobs]));
    const assembled = assembleManifest(merged.value.merged, (sha) => blobs.get(sha));
    expect(assembled.isOk).toBe(true);
    const result = assembled.value;
    const solver = new SketchSolver(Plane.XY, data(result), scope);
    try {
        expect(solver.solve(true).result).toMatch(/^Ok/);
        expect(solver.entity(91827364555)!.params).toEqual([0, 0, 17]);
        expect(solver.toData().constraints[0].datum).toBe("gap + 1 mm");
    } finally {
        solver.dispose();
    }
});

test("source deletion versus offset distance edit conflicts by ids and cannot keep a dangling link", () => {
    const base = fixture();
    const ours = edit(base, (p) => {
        p.entities.shift();
        p.constraints = [];
        delete p.entities[0].derivation;
    });
    const theirs = edit(base, (p) => {
        p.constraints[0].datum = 3;
        p.entities[1].params[2] = 13;
    });
    const merged = mergeDocuments(base, ours, theirs);
    expect(merged.isOk).toBe(true);
    expect(merged.value.conflicts.length).toBeGreaterThan(0);
    expect(merged.value.conflicts.map((c) => c.path)).toEqual(
        expect.arrayContaining([
            "node/sketch-offset/constraint/527164938721",
            "node/sketch-offset/entity/91827364555",
        ]),
    );
    for (const choice of ["ours", "theirs"] as const) {
        const resolved = resolveMerge(
            merged.value,
            merged.value.conflicts.map((c) => ({ path: c.path, choice })),
        );
        expect(resolved.isOk).toBe(true);
        if (choice === "theirs") {
            expect(resolved.value.conflicts.map((c) => [c.kind, c.path])).toEqual([
                ["dangling-ref", "node/sketch-offset/constraint/527164938721/refs"],
            ]);
            expect(() => validateOffsetRelations(data(resolved.value.merged))).toThrow(
                /Offset constraint .*missing/,
            );
            continue;
        }
        expect(resolved.value.conflicts).toEqual([]);
        const solver = new SketchSolver(Plane.XY, data(resolved.value.merged), scope);
        try {
            expect(solver.toData().constraints).toHaveLength(choice === "ours" ? 0 : 1);
            expect(solver.entity(91827364555)!.params[2]).toBe(choice === "ours" ? 12 : 13);
        } finally {
            solver.dispose();
        }
    }
});

test("save-file and blob-cache snapshots preserve source, relation and expression", async () => {
    const original = fixture();
    const decoded = await decodeDocumentFile(await encodeDocumentFile(original));
    expect(decoded.isOk).toBe(true);
    expect(decoded.value).toEqual(original);
    const snapshot = await splitManifest(original);
    const assembled = await assembleManifest(snapshot.manifest, (sha) => snapshot.blobs.get(sha));
    expect(assembled.isOk).toBe(true);
    expect(assembled.value).toEqual(original);
    expect(data(assembled.value).constraints[0]).toMatchObject({ datum: "gap", kind: 34 });
});

test("invalid merged ownership is refused with its constraint id", () => {
    const payload = data(fixture());
    payload.constraints.push({
        ...payload.constraints[0],
        id: 100,
        refs: [
            { entityId: 91827364555, pointIndex: 0 },
            { entityId: 734251950211, pointIndex: 0 },
        ],
    });
    expect(() => validateOffsetRelations(payload)).toThrow(/Offset constraint .*chains/);
});
