// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    assembleManifest,
    decodeDocumentFile,
    encodeDocumentFile,
    mergeDocuments,
    migrateDocument,
    type Serialized,
    splitManifest,
} from "@spicy3d/core";
import { loadDocumentFixtures } from "@spicy3d/core/test-utils";
import "@spicy3d/app";
import { PARAMETRIC_FORMAT_VERSION } from "@spicy3d/parametric";
import "@spicy3d/wasm";

// biome-ignore lint/suspicious/noExplicitAny: the merge engine consumes serialized JSON
type Json = any;
function base(): Json {
    const fixture = loadDocumentFixtures().find((entry) => entry.name === "v2/parametric11-face-sweep.json");
    expect(fixture).not.toBeUndefined();
    return migrateDocument(fixture!.data).value;
}
function feature(doc: Json): Json {
    return JSON.parse(
        doc.models.nodes.find((node: Json) => node.__cla$$__ === "ParametricBodyNode").featuresJson,
    )[1];
}
function change(doc: Json, patch: Json): Json {
    const next = structuredClone(doc);
    const body = next.models.nodes.find((node: Json) => node.__cla$$__ === "ParametricBodyNode");
    const features = JSON.parse(body.featuresJson);
    features[1] = { ...features[1], ...patch };
    body.featuresJson = JSON.stringify(features);
    return next;
}
test("path source and ordered refs merge as one atomic reference", () => {
    const b = base();
    const oursPath = { ...feature(b).path, edges: [{ ...feature(b).path.edges[0], edgeId: "ours" }] };
    const theirsPath = { ...feature(b).path, edges: [{ ...feature(b).path.edges[0], edgeId: "theirs" }] };
    const result = mergeDocuments(
        b as Serialized,
        change(b, { path: oursPath }),
        change(b, { path: theirsPath }),
    );
    expect(result.isOk).toBe(true);
    expect(result.value.conflicts).toHaveLength(1);
    expect(feature(result.value.merged).path).toEqual(oursPath);
});
test("section reference remains atomic while independent options combine", () => {
    const b = base();
    const ours = change(b, { operation: "cut" });
    const theirs = change(b, { roundCorner: true });
    const result = mergeDocuments(b, ours, theirs);
    expect(result.isOk).toBe(true);
    expect(result.value.conflicts).toEqual([]);
    expect(feature(result.value.merged)).toMatchObject({
        operation: "cut",
        roundCorner: true,
        section: feature(b).section,
    });
});
test("different section repicks conflict once and cannot mix a sketch ID with another pick", () => {
    const b = base();
    const original = feature(b).section;
    const ours = { ...original, profile: { ...(original.profile ?? {}), area: 20 } };
    const theirs = { ...original, profile: { ...(original.profile ?? {}), area: 30 } };
    const result = mergeDocuments(b, change(b, { section: ours }), change(b, { section: theirs }));
    expect(result.isOk).toBe(true);
    expect(result.value.conflicts).toHaveLength(1);
    expect(feature(result.value.merged).section).toEqual(ours);
});
test("cloud blobs and device export preserve version 11 support/path references and payload exactly", async () => {
    const b = base();
    const { manifest, blobs } = await splitManifest(b, { minStringLength: 1 });
    const assembled = assembleManifest(JSON.parse(JSON.stringify(manifest)), (sha) => blobs.get(sha));
    expect(assembled.isOk).toBe(true);
    expect(assembled.value).toEqual(b);
    const decoded = await decodeDocumentFile(await encodeDocumentFile(assembled.value));
    expect(decoded.isOk).toBe(true);
    expect(decoded.value).toEqual(b);
    expect(feature(decoded.value).path).toEqual(feature(b).path);
    expect(decoded.value["moduleVersions"]).toMatchObject({ parametric: PARAMETRIC_FORMAT_VERSION });
});

test("support node and picked face remain one atomic reference", () => {
    const b = base();
    const ours = {
        ...feature(b).support,
        nodeId: "other-support",
        face: { ...feature(b).support.face, id: "ours" },
    };
    const theirs = { ...feature(b).support, face: { ...feature(b).support.face, id: "theirs" } };
    const result = mergeDocuments(b, change(b, { support: ours }), change(b, { support: theirs }));
    expect(result.isOk).toBe(true);
    expect(result.value.conflicts).toHaveLength(1);
    expect(feature(result.value.merged).support).toEqual(ours);
});
