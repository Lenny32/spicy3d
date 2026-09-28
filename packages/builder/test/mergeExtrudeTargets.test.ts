// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { mergeDocuments, migrateDocument, type Serialized } from "@spicy3d/core";
import { loadDocumentFixtures } from "@spicy3d/core/test-utils";
import "@spicy3d/app";
import "@spicy3d/parametric";
import "@spicy3d/wasm";

// The merge rule of the `extrudeTarget` feature (parametric format 2, docs/merge.md "Features"):
// the entry an extrude hosted in another body leaves in each other target body. Base: the
// v1/parametric2-extrude-targets fixture — one slot hosted in body-left, cutting body-right too.

// biome-ignore lint/suspicious/noExplicitAny: loosely typed serialized documents
type Json = any;

function base(): Json {
    const fixture = loadDocumentFixtures().find((x) => x.name === "v1/parametric2-extrude-targets.json");
    expect(fixture).not.toBeUndefined();
    return migrateDocument(fixture!.data).value as Json;
}

const node = (doc: Json, id: string): Json => doc["models"].nodes.find((x: Json) => x.id === id);

const features = (doc: Json, id: string): Json[] => JSON.parse(node(doc, id).featuresJson);

/** `doc` with body `id`'s feature list rewritten by `edit`. */
function editFeatures(doc: Json, id: string, edit: (features: Json[]) => Json[]): Json {
    const next = structuredClone(doc);
    const body = node(next, id);
    body.featuresJson = JSON.stringify(edit(JSON.parse(body.featuresJson)));
    return next;
}

const merge = (b: Json, ours: Json, theirs: Json) => {
    const result = mergeDocuments(b as Serialized, ours as Serialized, theirs as Serialized);
    expect(result.isOk).toBe(true);
    return result.value;
};

describe("merging extrude targets", () => {
    test("one side removes a target while the other edits the extrude: both are kept", () => {
        const b = base();
        const ours = editFeatures(b, "body-right", (list) => list.filter((x) => x.type !== "extrudeTarget"));
        const theirs = editFeatures(b, "body-left", (list) =>
            list.map((x) => (x.id === "feature-slot" ? { ...x, depth: -8 } : x)),
        );

        const result = merge(b, ours, theirs);

        expect(result.conflicts).toEqual([]);
        expect(features(result.merged as Json, "body-right").map((x) => x.id)).toEqual(["feature-right"]);
        expect(features(result.merged as Json, "body-left")[1]).toMatchObject({ depth: -8 });
    });

    test("the host and the extrude it names are one value: re-pointing them differently conflicts once", () => {
        const b = base();
        const point = (bodyId: string, featureId: string) =>
            editFeatures(b, "body-right", (list) =>
                list.map((x) => (x.type === "extrudeTarget" ? { ...x, bodyId, featureId } : x)),
            );
        const ours = point("body-left", "feature-left");
        const theirs = point("body-right", "feature-right");

        const result = merge(b, ours, theirs);

        expect(result.conflicts.map((x) => x.kind)).toEqual(["property"]);
        expect(result.conflicts[0].path).toContain("feature-slot-target");
        // Unresolved, the merge holds this device's value whole — never one field from each side.
        expect(features(result.merged as Json, "body-right")[1]).toMatchObject({
            bodyId: "body-left",
            featureId: "feature-left",
        });
    });

    test("a target added to an extrude whose host the other side deleted is a dangling reference", () => {
        const withEntry = base();
        const b = editFeatures(withEntry, "body-right", (list) =>
            list.filter((x) => x.type !== "extrudeTarget"),
        );
        const withoutHost = structuredClone(b);
        withoutHost["models"].nodes = withoutHost["models"].nodes.filter((x: Json) => x.id !== "body-left");

        const result = merge(b, withoutHost, withEntry);

        const dangling = result.conflicts.filter((x) => x.kind === "dangling-ref");
        expect(dangling).toHaveLength(1);
        expect(dangling[0].path).toContain("feature-slot-target");
        expect(dangling[0].choices).toContain("accept");
    });

    test("both sides adding different targets to one extrude keeps both entries", () => {
        const b = base();
        const third = (doc: Json, bodyId: string) => {
            const next = structuredClone(doc);
            next["models"].nodes.push({
                ...structuredClone(node(doc, "body-right")),
                id: bodyId,
                featuresJson: JSON.stringify([
                    { id: `${bodyId}-base`, type: "extrude", sketchId: "sketch-right", depth: 10 },
                    {
                        id: `${bodyId}-target`,
                        type: "extrudeTarget",
                        bodyId: "body-left",
                        featureId: "feature-slot",
                    },
                ]),
            });
            return next;
        };

        const result = merge(b, third(b, "body-a"), third(b, "body-b"));

        expect(result.conflicts).toEqual([]);
        expect(features(result.merged as Json, "body-a")[1]).toMatchObject({ featureId: "feature-slot" });
        expect(features(result.merged as Json, "body-b")[1]).toMatchObject({ featureId: "feature-slot" });
    });
});
