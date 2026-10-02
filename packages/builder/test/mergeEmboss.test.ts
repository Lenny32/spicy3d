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
import type { EmbossFeatureData, FeatureData } from "@spicy3d/parametric";
import "@spicy3d/parametric";
import "@spicy3d/wasm";

function base(): Serialized {
    const fixture = loadDocumentFixtures().find((entry) => entry.name === "v2/parametric14-emboss.json");
    expect(fixture).not.toBeUndefined();
    if (!fixture) throw new Error("Emboss fixture is required");
    const migrated = migrateDocument(fixture.data);
    expect(migrated.isOk).toBe(true);
    return migrated.value;
}
function nodes(doc: Serialized) {
    return (doc["models"] as { nodes: Record<string, unknown>[] }).nodes;
}
function body(doc: Serialized) {
    const node = nodes(doc).find((node) => node["id"] === "body-emboss");
    if (!node) throw new Error("Missing emboss body");
    return node;
}
function features(doc: Serialized): FeatureData[] {
    return JSON.parse(String(body(doc)["featuresJson"]));
}
function feature(doc: Serialized): EmbossFeatureData {
    const feature = features(doc).find((feature) => feature.type === "emboss");
    if (!feature || feature.type !== "emboss") throw new Error("Missing emboss feature");
    return feature;
}
function change(doc: Serialized, patch: Partial<EmbossFeatureData>): Serialized {
    const copy = structuredClone(doc);
    body(copy)["featuresJson"] = JSON.stringify(
        features(copy).map((feature) => (feature.type === "emboss" ? { ...feature, ...patch } : feature)),
    );
    return copy;
}

test("independent depth, mode and target-face changes merge without dropping profile anchors", () => {
    const b = base(),
        original = feature(b);
    const faces = [{ ...original.faces[0], center: { x: 20, y: 20, z: 25 } }];
    const result = mergeDocuments(b, change(b, { depth: "3 mm", faces }), change(b, { deboss: true }));
    expect(result.isOk).toBe(true);
    expect(result.value.conflicts).toEqual([]);
    expect(feature(result.value.merged)).toMatchObject({
        depth: "3 mm",
        faces,
        deboss: true,
        profiles: original.profiles,
    });
});

test("sketch and profile reselection form one atomic choice across concurrent edits", () => {
    const b = base(),
        original = feature(b);
    const ours = change(b, {
        sketchId: "sketch-base",
        profiles: [{ ...original.profiles[0], entities: [101, 102, 103, 104] }],
    });
    const theirs = change(b, { profiles: [{ ...original.profiles[0], center: { x: 16, y: 15, z: 35 } }] });
    const result = mergeDocuments(b, ours, theirs);
    expect(result.isOk).toBe(true);
    expect(result.value.conflicts.filter((conflict) => conflict.kind === "property")).toHaveLength(1);
    expect(feature(result.value.merged).sketchId).toBe("sketch-base");
    expect(feature(result.value.merged).profiles).toEqual(feature(ours).profiles);
});

test("concurrent target-face selections conflict as a whole and can be resolved", () => {
    const b = base(),
        original = feature(b);
    const ours = change(b, { faces: [{ ...original.faces[0], center: { x: 20, y: 20, z: 25 } }] });
    const theirs = change(b, { faces: [{ ...original.faces[0], center: { x: 20, y: 20, z: 30 } }] });
    const result = mergeDocuments(b, ours, theirs);
    expect(result.isOk).toBe(true);
    expect(result.value.conflicts).toHaveLength(1);
    expect(result.value.conflicts[0].path).toContain("/param/faces");
    const resolved = resolveMerge(result.value, [{ path: result.value.conflicts[0].path, choice: "theirs" }]);
    expect(resolved.isOk).toBe(true);
    expect(resolved.value.conflicts).toEqual([]);
    expect(feature(resolved.value.merged).faces).toEqual(feature(theirs).faces);
});

test("deleting a sketch conflicts with the other side adding relief that references it", () => {
    const saved = base(),
        b = structuredClone(saved),
        original = feature(saved);
    body(b)["featuresJson"] = JSON.stringify(features(b).filter((feature) => feature.type !== "emboss"));
    const removed = structuredClone(b);
    (removed["models"] as { nodes: Record<string, unknown>[] }).nodes = nodes(removed).filter(
        (node) => node["id"] !== original.sketchId,
    );
    const result = mergeDocuments(b, removed, saved);
    expect(result.isOk).toBe(true);
    expect(result.value.conflicts.filter((conflict) => conflict.kind === "dangling-ref")).toHaveLength(1);
});

test("semantic comparison names recessed relief and labels depth, mode and target selection", () => {
    const b = base(),
        original = feature(b);
    const diff = compareDocuments(
        b,
        change(b, {
            depth: 3,
            deboss: true,
            faces: [{ ...original.faces[0], center: { x: 20, y: 20, z: 25 } }],
        }),
    );
    expect(diff.isOk).toBe(true);
    expect(diff.value).toEqual(
        expect.arrayContaining([expect.objectContaining({ args: ["deboss 2", "depth", "2 mm", "3 mm"] })]),
    );
    expect(diff.value.some((line) => line.args.includes("deboss"))).toBe(true);
    expect(diff.value.some((line) => line.args.includes("faces"))).toBe(true);
});

test("cloud blob manifests and .spicy exports round-trip the complete approved version14 payload", async () => {
    const b = base();
    b["userData"] = { opaque: { emboss: "not a feature", values: [0, 255, 17] } };
    const { manifest, blobs } = await splitManifest(b, { minStringLength: 1 });
    expect(
        nodes(manifest).find((node) => node["featuresJson"] !== undefined)?.["featuresJson"],
    ).toMatchObject({ $blob: expect.any(String) });
    const assembled = assembleManifest(JSON.parse(JSON.stringify(manifest)), (sha) => blobs.get(sha));
    expect(assembled.isOk).toBe(true);
    expect(assembled.value).toEqual(b);
    const decoded = await decodeDocumentFile(await encodeDocumentFile(assembled.value));
    expect(decoded.isOk).toBe(true);
    expect(decoded.value).toEqual(b);
    expect(feature(decoded.value)).toEqual(feature(b));
    expect(decoded.value["moduleVersions"]).toMatchObject({ parametric: 14, sketch: 5 });
});
