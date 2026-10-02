// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    assembleManifest,
    decodeDocumentFile,
    encodeDocumentFile,
    mergeDocuments,
    migrateDocument,
    splitManifest,
} from "@spicy3d/core";
import { loadDocumentFixtures } from "@spicy3d/core/test-utils";
import "@spicy3d/app";
import { PARAMETRIC_FORMAT_VERSION } from "@spicy3d/parametric";
import "@spicy3d/wasm";

// biome-ignore lint/suspicious/noExplicitAny: these helpers inspect the merge engine's serialized document payload
type Json = any;
function base(): Json {
    const fixture = loadDocumentFixtures().find((entry) => entry.name === "v2/parametric13-guided-loft.json");
    expect(fixture).not.toBeUndefined();
    if (!fixture) throw new Error("Guided loft fixture is required");
    const migrated = migrateDocument(fixture.data);
    expect(migrated.isOk).toBe(true);
    return migrated.value;
}
function body(doc: Json): Json {
    return doc.models.nodes.find((node: Json) => node.__cla$$__ === "ParametricBodyNode");
}
function feature(doc: Json): Json {
    return JSON.parse(body(doc).featuresJson)[0];
}
function change(doc: Json, patch: Json): Json {
    const copy = structuredClone(doc);
    body(copy).featuresJson = JSON.stringify([{ ...feature(copy), ...patch }]);
    return copy;
}

test("concurrent changes to opposite guides conflict once and cannot form a hybrid pair", () => {
    const b = base();
    const original = feature(b).guided;
    const ours = {
        ...original,
        spine: { ...original.spine, edges: [{ ...original.spine.edges[0], edgeId: "ours" }] },
    };
    const theirs = {
        ...original,
        boundary: { ...original.boundary, edges: [{ ...original.boundary.edges[0], edgeId: "theirs" }] },
    };
    const merged = mergeDocuments(b, change(b, { guided: ours }), change(b, { guided: theirs }));
    expect(merged.isOk).toBe(true);
    expect(merged.value.conflicts).toHaveLength(1);
    expect(feature(merged.value.merged).guided).toEqual(ours);
});

test("guide source and its ordered fingerprints merge together", () => {
    const b = base();
    const original = feature(b).guided;
    const ours = { ...original, boundary: { nodeId: original.spine.nodeId, edges: original.spine.edges } };
    const theirs = {
        ...original,
        boundary: {
            ...original.boundary,
            edges: [{ ...original.boundary.edges[0], start: { x: 6, y: 3, z: 0 } }],
        },
    };
    const merged = mergeDocuments(b, change(b, { guided: ours }), change(b, { guided: theirs }));
    expect(merged.isOk).toBe(true);
    expect(merged.value.conflicts).toHaveLength(1);
    expect(feature(merged.value.merged).guided.boundary).toEqual(ours.boundary);
});

test("a guide repick and an independent solid option combine", () => {
    const b = base();
    const guided = {
        ...feature(b).guided,
        boundary: {
            ...feature(b).guided.boundary,
            edges: [{ ...feature(b).guided.boundary.edges[0], edgeId: "updated" }],
        },
    };
    const merged = mergeDocuments(b, change(b, { guided }), change(b, { solid: false }));
    expect(merged.isOk).toBe(true);
    expect(merged.value.conflicts).toEqual([]);
    expect(feature(merged.value.merged)).toMatchObject({ guided, solid: false });
});

test("clearing guides conflicts with a concurrent boundary change", () => {
    const b = base();
    const guided = {
        ...feature(b).guided,
        boundary: {
            ...feature(b).guided.boundary,
            edges: [{ ...feature(b).guided.boundary.edges[0], edgeId: "updated" }],
        },
    };
    const merged = mergeDocuments(b, change(b, { guided: undefined }), change(b, { guided }));
    expect(merged.isOk).toBe(true);
    expect(merged.value.conflicts).toHaveLength(1);
    expect(feature(merged.value.merged)).not.toHaveProperty("guided");
});

test("deleting a guide source reports a dangling reference inside the atomic pair", () => {
    const b = base();
    const guided = feature(b).guided;
    const original = change(b, { guided: undefined });
    const removed = structuredClone(original);
    removed.models.nodes = removed.models.nodes.filter((node: Json) => node.id !== guided.boundary.nodeId);
    const merged = mergeDocuments(original, change(original, { guided }), removed);
    expect(merged.isOk).toBe(true);
    const dangling = merged.value.conflicts.filter((conflict) => conflict.kind === "dangling-ref");
    expect(dangling).toHaveLength(1);
    expect(dangling[0].path).toBe("node/body-guided-loft/feature/guided-loft/param/guided");
});

test("cloud featuresJson blobs and device exports preserve the complete version13 guide pair", async () => {
    const b = base();
    b.userData = { opaque: { guided: "user data is not a feature", bytes: [0, 255, 17] } };
    const { manifest, blobs } = await splitManifest(b, { minStringLength: 1 });
    expect(
        (manifest["models"] as Json).nodes.find((node: Json) => node.featuresJson !== undefined).featuresJson,
    ).toMatchObject({ $blob: expect.any(String) });
    const assembled = assembleManifest(JSON.parse(JSON.stringify(manifest)), (sha) => blobs.get(sha));
    expect(assembled.isOk).toBe(true);
    expect(assembled.value).toEqual(b);
    const decoded = await decodeDocumentFile(await encodeDocumentFile(assembled.value));
    expect(decoded.isOk).toBe(true);
    expect(decoded.value).toEqual(b);
    expect(feature(decoded.value).guided).toEqual(feature(b).guided);
    expect(decoded.value["moduleVersions"]).toMatchObject({
        parametric: PARAMETRIC_FORMAT_VERSION,
        sketch: 6,
    });
});
