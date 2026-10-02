// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    assembleManifest,
    CLOUD_VERSION_FILE_TYPE,
    decodeDocumentFile,
    encodeDocumentFile,
    mergeDocuments,
    migrateDocument,
    Plane,
    resolveMerge,
    type Serialized,
    sha256Hex,
    splitManifest,
} from "@spicy3d/core";
import { loadDocumentFixtures } from "@spicy3d/core/test-utils";
import fc from "fast-check";
import "@spicy3d/app";
import "@spicy3d/parametric";
import "@spicy3d/wasm";
import type { SketchData } from "../../parametric/src/sketch/sketchModel";
import { SketchSolver } from "../../parametric/src/sketch/solver";
import "../../parametric/test/sketch/setup";

function fixture(): Serialized {
    const found = loadDocumentFixtures().find((entry) => entry.name === "v2/sketch5-angle-side.json");
    expect(found).not.toBeUndefined();
    return structuredClone(found!.data);
}
function sketch(document: Serialized): Serialized {
    return document["models"].nodes.find((node: Serialized) => node["id"] === "sketch-angle")!;
}
function data(document: Serialized): SketchData {
    return JSON.parse(sketch(document)["dataJson"]);
}
function edit(document: Serialized, change: (data: SketchData) => void): Serialized {
    const next = structuredClone(document),
        payload = data(next);
    change(payload);
    sketch(next)["dataJson"] = JSON.stringify(payload);
    return next;
}
function expectOrientation(document: Serialized, degrees: number) {
    const solver = new SketchSolver(Plane.XY, data(document));
    try {
        expect(solver.solve(true).result).toMatch(/^Ok/);
        const [x1, y1, x2, y2] = solver.toData().entities[0].params;
        expect((Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI).toBeCloseTo(degrees, 6);
    } finally {
        solver.dispose();
    }
}

test.each([
    "literal",
    "expression",
])("positive %s edit wins over clockwise geometry at the same magnitude", (kind) => {
    const base = fixture(),
        degrees = 14.5,
        radians = (degrees * Math.PI) / 180;
    const ours = edit(base, (payload) => {
        Object.assign(payload.constraints.find((item) => item.id === 4)!, {
            datum: kind === "literal" ? radians : String(degrees),
            angleSide: 1,
        });
    });
    const theirs = edit(base, (payload) => {
        payload.entities[0].params = [100, 0, 100 + 10 * Math.cos(radians), -10 * Math.sin(radians)];
    });
    const merged = mergeDocuments(base, ours, theirs);
    expect(merged.isOk).toBe(true);
    expect(merged.value.conflicts).toEqual([]);
    expect(data(merged.value.merged).constraints.find((item) => item.id === 4)).toMatchObject({
        datum: kind === "literal" ? radians : String(degrees),
        angleSide: 1,
    });
    expect(data(merged.value.merged).entities).toEqual(data(theirs).entities);
    expectOrientation(merged.value.merged, degrees);
});

test("marker-only edits retain the user's sign and commute with unrelated geometry edits", () => {
    fc.assert(
        fc.property(fc.double({ min: 1, max: 170, noNaN: true }), (degrees) => {
            const radians = (degrees * Math.PI) / 180;
            const base = edit(fixture(), (payload) => {
                payload.constraints.find((item) => item.id === 4)!.datum = radians;
                payload.entities[0].params = [100, 0, 100 + 10 * Math.cos(radians), -10 * Math.sin(radians)];
            });
            const ours = edit(base, (payload) => {
                payload.constraints.find((item) => item.id === 4)!.angleSide = 1;
            });
            const theirs = edit(base, (payload) => {
                payload.entities[0].params[0] += 3;
                payload.entities[0].params[2] += 3;
            });
            const forward = mergeDocuments(base, ours, theirs),
                reverse = mergeDocuments(base, theirs, ours);
            expect(forward.isOk).toBe(true);
            expect(reverse.isOk).toBe(true);
            expect(forward.value.conflicts).toEqual([]);
            expect(reverse.value.conflicts).toEqual([]);
            expect(data(forward.value.merged)).toEqual(data(reverse.value.merged));
            expect(data(forward.value.merged).constraints.find((item) => item.id === 4)?.angleSide).toBe(1);
            expect(data(forward.value.merged).constraints.find((item) => item.id === 4)?.datum).toBe(radians);
            expect(data(forward.value.merged).entities).toEqual(data(theirs).entities);
        }),
        { numRuns: 100 },
    );
});

test("cloud manifests and spicy files carry both angle semantics as ordinary payload data", async () => {
    const original = fixture();
    const payload = data(original);
    payload.constraints.push({
        ...payload.constraints.find((item) => item.id === 4)!,
        id: 5,
        datum: -Math.PI / 6,
        angleSide: 1,
    });
    sketch(original)["dataJson"] = JSON.stringify(payload);
    const { manifest, blobs } = await splitManifest(original, { minStringLength: 1 });
    expect(manifest["models"].nodes[1]["dataJson"]).toMatchObject({ $blob: expect.any(String) });
    const assembled = assembleManifest(JSON.parse(JSON.stringify(manifest)), (sha) => blobs.get(sha));
    expect(assembled.isOk).toBe(true);
    expect(assembled.value).toEqual(original);
    const decoded = await decodeDocumentFile(await encodeDocumentFile(assembled.value));
    expect(decoded.isOk).toBe(true);
    expect(decoded.value).toEqual(original);
    expect(
        data(decoded.value)
            .constraints.filter((item) => item.kind === 9)
            .map((item) => item.angleSide),
    ).toEqual([-1, 1]);
});

test.each([
    4, 5,
])("server cloudVersion spicy export at sketch %s preserves its side through migration", async (version) => {
    const original = fixture();
    original["moduleVersions"]["sketch"] = version;
    if (version === 4) {
        const payload = data(original);
        delete payload.constraints.find((item) => item.id === 4)!.angleSide;
        sketch(original)["dataJson"] = JSON.stringify(payload);
    }
    const { manifest, blobs } = await splitManifest(original);
    const bytes = new TextEncoder().encode(JSON.stringify(manifest)),
        sha = await sha256Hex(bytes);
    const encoded: Record<string, string> = { [sha]: btoa(String.fromCharCode(...bytes)) };
    for (const [key, value] of blobs) encoded[key] = btoa(String.fromCharCode(...value));
    const envelope = {
        type: CLOUD_VERSION_FILE_TYPE,
        exportFormat: 1,
        document: { id: original["id"], name: original["name"] },
        manifestSha256: sha,
        blobs: encoded,
    };
    const decoded = await decodeDocumentFile(await encodeDocumentFile(envelope as unknown as Serialized));
    expect(decoded.isOk).toBe(true);
    expect(decoded.value).toEqual(original);
    const migrated = migrateDocument(decoded.value);
    expect(migrated.isOk).toBe(true);
    expect(data(migrated.value).constraints.find((item) => item.id === 4)).toMatchObject({
        datum: "tilt",
        angleSide: -1,
    });
    expect(migrated.value["moduleVersions"]).toMatchObject({ sketch: 5 });
});

test.each([4, 5])("resolving a sketch %s datum conflict takes its angle side too", (version) => {
    const base = fixture();
    base["moduleVersions"]["sketch"] = version;
    if (version === 4) {
        const payload = data(base);
        delete payload.constraints.find((item) => item.id === 4)!.angleSide;
        sketch(base)["dataJson"] = JSON.stringify(payload);
    }
    const ours = edit(fixture(), (payload) => {
        Object.assign(payload.constraints.find((item) => item.id === 4)!, { datum: "45", angleSide: -1 });
    });
    const theirs = edit(fixture(), (payload) => {
        Object.assign(payload.constraints.find((item) => item.id === 4)!, { datum: "60", angleSide: 1 });
    });
    const merged = mergeDocuments(base, ours, theirs);
    expect(merged.isOk).toBe(true);
    expect(merged.value.conflicts).toHaveLength(1);
    expect(merged.value.conflicts[0].path).toContain("/constraint/4/datum");
    for (const [choice, datum, angleSide, degrees] of [
        ["ours", "45", -1, -45],
        ["theirs", "60", 1, 60],
    ] as const) {
        const resolved = resolveMerge(merged.value, [{ path: merged.value.conflicts[0].path, choice }]);
        expect(resolved.isOk).toBe(true);
        expect(resolved.value.conflicts).toEqual([]);
        expect(data(resolved.value.merged).constraints.find((item) => item.id === 4)).toMatchObject({
            datum,
            angleSide,
        });
        expectOrientation(resolved.value.merged, degrees);
    }
});
