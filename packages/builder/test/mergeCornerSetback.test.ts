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

// biome-ignore lint/suspicious/noExplicitAny: serialized fixture data
type Json = any;
function fixture(): Json {
    const found = loadDocumentFixtures().find(
        (entry) => entry.name === "v2/parametric12-corner-setback.json",
    );
    expect(found).not.toBeUndefined();
    return migrateDocument(found!.data).value;
}
function feature(doc: Json): Json {
    return JSON.parse(
        doc.models.nodes.find((node: Json) => node.__cla$$__ === "ParametricBodyNode").featuresJson,
    )[1];
}
function change(doc: Json, edit: (feature: Json) => void): Json {
    const value = structuredClone(doc);
    const body = value.models.nodes.find((node: Json) => node.__cla$$__ === "ParametricBodyNode");
    const features = JSON.parse(body.featuresJson);
    edit(features[1]);
    body.featuresJson = JSON.stringify(features);
    return value;
}
test("independent concurrent distance edits conflict as one coherent corner triplet", () => {
    const base = fixture();
    const ours = change(base, (value) => {
        value.cornerSetbacks[0].distances[0] = 2.45;
    });
    const theirs = change(base, (value) => {
        value.cornerSetbacks[0].distances[1] = "setback + 0.05 mm";
    });
    const result = mergeDocuments(base, ours, theirs);
    expect(result.isOk).toBe(true);
    expect(result.value.conflicts).toHaveLength(1);
    expect(feature(result.value.merged).cornerSetbacks).toEqual(feature(ours).cornerSetbacks);
});
test("repicked corner references cannot mix with another device's distances", () => {
    const base = fixture();
    const ours = change(base, (value) => {
        value.cornerSetbacks[0].edges[0].edgeId = "new-edge";
    });
    const theirs = change(base, (value) => {
        value.cornerSetbacks[0].distances[2] = 2.6;
    });
    const result = mergeDocuments(base, ours, theirs);
    expect(result.isOk).toBe(true);
    expect(result.value.conflicts).toHaveLength(1);
    expect(feature(result.value.merged).cornerSetbacks).toEqual(feature(ours).cornerSetbacks);
});
test("corner and independent feature name edits combine", () => {
    const base = fixture();
    const ours = change(base, (value) => {
        value.cornerSetbacks[0].distances[0] = 2.45;
    });
    const theirs = change(base, (value) => {
        value.name = "Rounded corner";
    });
    const result = mergeDocuments(base, ours, theirs);
    expect(result.isOk).toBe(true);
    expect(result.value.conflicts).toEqual([]);
    expect(feature(result.value.merged)).toMatchObject({
        name: "Rounded corner",
        cornerSetbacks: feature(ours).cornerSetbacks,
    });
});
test("cloud blob and spicy file roundtrips preserve setback expressions and stable refs exactly", async () => {
    const base = fixture();
    const { manifest, blobs } = await splitManifest(base, { minStringLength: 1 });
    const assembled = assembleManifest(structuredClone(manifest), (hash) => blobs.get(hash));
    expect(assembled.isOk).toBe(true);
    expect(assembled.value).toEqual(base);
    const decoded = await decodeDocumentFile(await encodeDocumentFile(assembled.value));
    expect(decoded.isOk).toBe(true);
    expect(decoded.value).toEqual(base);
    expect(decoded.value["moduleVersions"]).toMatchObject({ parametric: PARAMETRIC_FORMAT_VERSION });
});
