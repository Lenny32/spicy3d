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
import type { ProjectionFeatureData } from "@spicy3d/parametric";
import "@spicy3d/parametric";
import "@spicy3d/app";
import "@spicy3d/wasm";

function nodes(doc: Serialized): Serialized[] {
    return (doc["models"] as Serialized)["nodes"] as Serialized[];
}
function base(): Serialized {
    const fixture = loadDocumentFixtures().find((item) => item.name === "v2/parametric10-projection.json");
    expect(fixture).not.toBeUndefined();
    if (!fixture) throw new Error("Missing projection fixture");
    const migrated = migrateDocument(fixture.data);
    expect(migrated.isOk).toBe(true);
    return migrated.value;
}
function body(doc: Serialized): Serialized {
    const node = nodes(doc).find((item) => item["id"] === "body-projection");
    expect(node).not.toBeUndefined();
    if (!node) throw new Error("Projection body missing");
    return node;
}
function feature(doc: Serialized): ProjectionFeatureData {
    return JSON.parse(body(doc)["featuresJson"] as string)[0];
}
function edit(
    doc: Serialized,
    action: (feature: ProjectionFeatureData) => ProjectionFeatureData,
): Serialized {
    const next = structuredClone(doc);
    body(next)["featuresJson"] = JSON.stringify([action(feature(next))]);
    return next;
}

test("projection source node and whole-edge selection conflict as one atomic reference", () => {
    const b = base();
    const ours = edit(b, (f) => ({
        ...f,
        source: { ...f.source, edges: f.source.edges.map((edge) => ({ ...edge, edgeId: "ours-edge" })) },
    }));
    const theirs = edit(b, (f) => ({ ...f, source: { ...f.source, nodeId: "sketch-wall" } }));
    const result = mergeDocuments(b, ours, theirs);
    expect(result.isOk).toBe(true);
    expect(result.value.conflicts).toHaveLength(1);
    expect(result.value.conflicts[0].path).toBe(
        "node/body-projection/feature/feature-projection/param/source",
    );
    expect(feature(result.value.merged).source).toEqual(feature(ours).source);
});

test("projection target node and face anchor conflict as one atomic reference", () => {
    const b = base();
    const ours = edit(b, (f) => ({ ...f, target: { ...f.target, face: { ...f.target.face, area: 1300 } } }));
    const theirs = edit(b, (f) => ({ ...f, target: { ...f.target, nodeId: "sketch-wall" } }));
    const result = mergeDocuments(b, ours, theirs);
    expect(result.isOk).toBe(true);
    expect(result.value.conflicts).toHaveLength(1);
    expect(result.value.conflicts[0].path).toBe(
        "node/body-projection/feature/feature-projection/param/target",
    );
    expect(feature(result.value.merged).target).toEqual(feature(ours).target);
});

test("direction components are one world-vector choice rather than independently merged numbers", () => {
    const b = base();
    const ours = edit(b, (f) => ({ ...f, direction: { x: -1, y: 0, z: 0 } }));
    const theirs = edit(b, (f) => ({ ...f, direction: { x: 1, y: 0, z: 0.2 } }));
    const result = mergeDocuments(b, ours, theirs);
    expect(result.isOk).toBe(true);
    expect(result.value.conflicts.map((conflict) => conflict.path)).toEqual([
        "node/body-projection/feature/feature-projection/param/direction",
    ]);
    expect(feature(result.value.merged).direction).toEqual(feature(ours).direction);
});

test("an independent projection rename and direction change both survive merge", () => {
    const b = base();
    const ours = edit(b, (f) => ({ ...f, direction: { x: -1, y: 0, z: 0 } }));
    const theirs = edit(b, (f) => ({ ...f, name: "Back wall" }));
    const result = mergeDocuments(b, ours, theirs);
    expect(result.isOk).toBe(true);
    expect(result.value.conflicts).toEqual([]);
    expect(feature(result.value.merged)).toMatchObject({
        name: "Back wall",
        direction: { x: -1, y: 0, z: 0 },
    });
});

test.each([
    "sketch-source",
    "body-wall",
])("projection retains node-reference validation when %s is concurrently deleted", (deleted) => {
    const b = base();
    const ours = edit(b, (f) =>
        deleted === "sketch-source"
            ? {
                  ...f,
                  source: {
                      ...f.source,
                      edges: f.source.edges.map((edge) => ({ ...edge, edgeId: "changed-source" })),
                  },
              }
            : { ...f, target: { ...f.target, face: { ...f.target.face, area: 1300 } } },
    );
    const theirs = structuredClone(b);
    (theirs["models"] as Serialized)["nodes"] = nodes(theirs).filter((node) => node["id"] !== deleted);
    const result = mergeDocuments(b, ours, theirs);
    expect(result.isOk).toBe(true);
    expect(result.value.conflicts.filter((conflict) => conflict.kind === "dangling-ref")).toHaveLength(1);
});

test("projection .spicy and cloud manifest/blob roundtrips preserve exact references, direction and userData", async () => {
    const b = base();
    b["userData"] = { arbitrary: { direction: "user-owned", formatVersion: 999 } };
    const decoded = await decodeDocumentFile(await encodeDocumentFile(b));
    expect(decoded.isOk).toBe(true);
    expect(decoded.value).toEqual(b);
    const { manifest, blobs } = await splitManifest(b, { minStringLength: 1 });
    expect(blobs.size).toBeGreaterThan(0);
    const assembled = assembleManifest(JSON.parse(JSON.stringify(manifest)), (sha) => blobs.get(sha));
    expect(assembled.isOk).toBe(true);
    expect(assembled.value).toEqual(b);
    const merged = mergeDocuments(b, assembled.value, b);
    expect(merged.isOk).toBe(true);
    expect(merged.value.conflicts).toEqual([]);
    expect(feature(merged.value.merged)).toEqual(feature(b));
    expect(merged.value.merged["moduleVersions"]).toMatchObject({ parametric: 10, sketch: 3 });
    expect(merged.value.merged["userData"]).toEqual(b["userData"]);
});
