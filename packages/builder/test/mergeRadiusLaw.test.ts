// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    decodeDocumentFile,
    encodeDocumentFile,
    mergeDocuments,
    migrateDocument,
    type Serialized,
} from "@spicy3d/core";
import { loadDocumentFixtures } from "@spicy3d/core/test-utils";
import type { FilletFeatureData } from "@spicy3d/parametric";
import "@spicy3d/parametric";
import { PARAMETRIC_FORMAT_VERSION } from "@spicy3d/parametric/src/migrations";
import "@spicy3d/app";
import "@spicy3d/wasm";

function base(): Serialized {
    const fixture = loadDocumentFixtures().find(
        (item) => item.name === "v2/parametric7-variable-fillet.json",
    );
    expect(fixture).not.toBeUndefined();
    const migrated = migrateDocument(fixture!.data);
    expect(migrated.isOk).toBe(true);
    return migrated.value;
}
function body(doc: Serialized): Serialized {
    const node = ((doc["models"] as Serialized)["nodes"] as Serialized[]).find(
        (item) => item["id"] === "body-block",
    );
    expect(node).not.toBeUndefined();
    return node!;
}
function fillet(doc: Serialized): FilletFeatureData {
    return JSON.parse(body(doc)["featuresJson"] as string)[1];
}
function edit(doc: Serialized, action: (feature: FilletFeatureData) => FilletFeatureData): Serialized {
    const next = structuredClone(doc);
    const node = body(next);
    const features = JSON.parse(node["featuresJson"] as string);
    features[1] = action(features[1]);
    node["featuresJson"] = JSON.stringify(features);
    return next;
}

describe("variable fillet persistence and merge", () => {
    test("different knot edits conflict once at the whole law", () => {
        const b = base();
        const ours = edit(b, (feature) => ({
            ...feature,
            radiusLaw: feature.radiusLaw!.map((point, index) =>
                index === 0 ? { ...point, radius: "small * 2" } : point,
            ),
        }));
        const theirs = edit(b, (feature) => ({
            ...feature,
            radiusLaw: feature.radiusLaw!.map((point, index) =>
                index === 1 ? { ...point, position: 0.3 } : point,
            ),
        }));
        const result = mergeDocuments(b, ours, theirs);
        expect(result.isOk).toBe(true);
        expect(result.value.conflicts).toHaveLength(1);
        expect(result.value.conflicts[0].path).toBe("node/body-block/feature/feature-law/param/radiusLaw");
        expect(fillet(result.value.merged).radiusLaw).toEqual(fillet(ours).radiusLaw);
    });

    test("a radius law edit and an independent feature rename both survive", () => {
        const b = base();
        const ours = edit(b, (feature) => ({
            ...feature,
            radiusLaw: [
                { position: 0, radius: "small" },
                { position: 1, radius: "small * 2" },
            ],
        }));
        const theirs = edit(b, (feature) => ({ ...feature, name: "Variable corner" }));
        const result = mergeDocuments(b, ours, theirs);
        expect(result.isOk).toBe(true);
        expect(result.value.conflicts).toEqual([]);
        expect(fillet(result.value.merged)).toMatchObject({
            name: "Variable corner",
            radiusLaw: fillet(ours).radiusLaw,
        });
    });

    test("a .spicy roundtrip preserves sample positions, expressions and selected-edge references", async () => {
        const b = base();
        const encoded = await encodeDocumentFile(b);
        const decoded = await decodeDocumentFile(encoded);
        expect(decoded.isOk).toBe(true);
        expect(decoded.value["moduleVersions"]).toMatchObject({ parametric: PARAMETRIC_FORMAT_VERSION });
        expect(fillet(decoded.value)).toEqual(fillet(b));
    });
});
