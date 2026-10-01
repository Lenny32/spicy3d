// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    assembleManifest,
    compareDocuments,
    decodeDocumentFile,
    encodeDocumentFile,
    mergeDocuments,
    migrateDocument,
    resolveMerge,
    type Serialized,
    splitManifest,
} from "@spicy3d/core";
import { loadDocumentFixtures } from "@spicy3d/core/test-utils";
import "@spicy3d/app";
import "@spicy3d/parametric";
import "@spicy3d/wasm";

// biome-ignore lint/suspicious/noExplicitAny: serialized fixture documents
type Json = any;
function base(): Json {
    const found = loadDocumentFixtures().find((entry) => entry.name === "v2/sketch4-text.json");
    expect(found).not.toBeUndefined();
    const result = migrateDocument(found!.data);
    expect(result.isOk).toBe(true);
    return result.value;
}
function data(doc: Json): Json {
    return JSON.parse(doc.models.nodes.find((node: Json) => node.id === "sketch-text").dataJson);
}
function edit(doc: Json, change: Json): Json {
    const copy = structuredClone(doc),
        sketch = copy.models.nodes.find((node: Json) => node.id === "sketch-text");
    const next = data(copy);
    Object.assign(next.texts[0], change);
    sketch.dataJson = JSON.stringify(next);
    return copy;
}
function merge(b: Json, ours: Json, theirs: Json) {
    const result = mergeDocuments(b as Serialized, ours as Serialized, theirs as Serialized);
    expect(result.isOk).toBe(true);
    return result.value;
}

test("content and height edits merge independently with stable profile references", () => {
    const b = base(),
        result = merge(b, edit(b, { value: "B", profileIds: [11, 12, 13] }), edit(b, { height: 12 }));
    expect(result.conflicts).toEqual([]);
    expect(data(result.merged).texts[0]).toMatchObject({ value: "B", profileIds: [11, 12, 13], height: 12 });
});

test("concurrent different content edits conflict once with their contour identities", () => {
    const b = base(),
        result = merge(b, edit(b, { value: "B", profileIds: [11, 12, 13] }), edit(b, { value: "H" }));
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].path).toBe("node/sketch-text/text/10/content");
});

test("frame position merges atomically while rotation stays independent", () => {
    const b = base(),
        independent = merge(b, edit(b, { x: 10, y: 20 }), edit(b, { angle: 45 }));
    expect(independent.conflicts).toEqual([]);
    expect(data(independent.merged).texts[0]).toMatchObject({ x: 10, y: 20, angle: 45 });
    const conflicting = merge(b, edit(b, { x: 10 }), edit(b, { y: 20 }));
    expect(conflicting.conflicts).toHaveLength(1);
    expect(conflicting.conflicts[0].path).toBe("node/sketch-text/text/10/position");
});

test("semantic comparison summarizes text edits once", () => {
    const b = base(),
        compared = compareDocuments(b, edit(b, { value: "B", height: 12, profileIds: [11, 12, 13] }));
    expect(compared.isOk).toBe(true);
    expect(compared.value).toHaveLength(1);
    expect(compared.value[0].target).toBe("node/sketch-text/sketch");
    expect(JSON.stringify(compared.value[0].args)).toContain("diff.noun.text");
});

test("manifest and spicy round trips preserve editable text metadata", async () => {
    const b = base(),
        { manifest, blobs } = await splitManifest(b);
    const assembled = assembleManifest(manifest, (sha) => blobs.get(sha));
    expect(assembled.isOk).toBe(true);
    const reopened = await decodeDocumentFile(await encodeDocumentFile(assembled.value));
    expect(reopened.isOk).toBe(true);
    expect(reopened.value).toEqual(b);
});

test("resolving a deleted text versus a new extrusion restores the owning text", () => {
    const b = base();
    const body = b.models.nodes.find((node: Json) => node.id === "body-text");
    const extrusion = JSON.parse(body.featuresJson)[0];
    body.featuresJson = "[]";
    const ours = structuredClone(b),
        theirs = structuredClone(b);
    const sketch = ours.models.nodes.find((node: Json) => node.id === "sketch-text");
    const removed = data(ours);
    removed.texts = [];
    sketch.dataJson = JSON.stringify(removed);
    theirs.models.nodes.find((node: Json) => node.id === "body-text").featuresJson = JSON.stringify([
        extrusion,
    ]);
    const result = merge(b, ours, theirs);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].kind).toBe("dangling-ref");
    const resolved = resolveMerge(result, [{ path: result.conflicts[0].path, choice: "theirs" }]);
    expect(resolved.isOk).toBe(true);
    expect(resolved.value.conflicts).toEqual([]);
    expect(data(resolved.value.merged).texts).toEqual(data(theirs).texts);
});
