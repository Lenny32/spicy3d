// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { mergeDocuments, migrateDocument, type Serialized } from "@spicy3d/core";
import { loadDocumentFixtures } from "@spicy3d/core/test-utils";
import "@spicy3d/app";
import "@spicy3d/parametric";
import "@spicy3d/wasm";

// The merge rule of an extrude's extents (parametric format 3, docs/merge.md "Features"). Base: the
// v1/parametric3-extrude-extents fixture — body-block with a hole cut down to its bottom face
// (`feature-hole`, to object) and a through-all cut (`feature-through`).

// biome-ignore lint/suspicious/noExplicitAny: loosely typed serialized documents
type Json = any;

function base(): Json {
    const fixture = loadDocumentFixtures().find((x) => x.name === "v1/parametric3-extrude-extents.json");
    expect(fixture).not.toBeUndefined();
    return migrateDocument(fixture!.data).value as Json;
}

const node = (doc: Json, id: string): Json => doc["models"].nodes.find((x: Json) => x.id === id);

const feature = (doc: Json, id: string): Json =>
    JSON.parse(node(doc, "body-block").featuresJson).find((x: Json) => x.id === id);

/** `doc` with feature `id` of body-block rewritten by `edit`. */
function editFeature(doc: Json, id: string, edit: (feature: Json) => Json): Json {
    const next = structuredClone(doc);
    const body = node(next, "body-block");
    body.featuresJson = JSON.stringify(
        JSON.parse(body.featuresJson).map((x: Json) => (x.id === id ? edit(x) : x)),
    );
    return next;
}

const withExtent = (edit: (extent: Json) => Json) => (x: Json) => ({ ...x, extent: edit(x.extent) });

const merge = (b: Json, ours: Json, theirs: Json) => {
    const result = mergeDocuments(b as Serialized, ours as Serialized, theirs as Serialized);
    expect(result.isOk).toBe(true);
    return result.value;
};

describe("merging extrude extents", () => {
    test("the offset on one side and the depth on the other are both kept", () => {
        const b = base();
        const ours = editFeature(
            b,
            "feature-hole",
            withExtent((extent) => ({ ...extent, offset: -2 })),
        );
        const theirs = editFeature(b, "feature-hole", (x) => ({ ...x, depth: -3 }));

        const result = merge(b, ours, theirs);

        expect(result.conflicts).toEqual([]);
        const hole = feature(result.merged, "feature-hole");
        expect(hole.extent).toMatchObject({ type: "toObject", nodeId: "body-block", offset: -2 });
        expect(hole.depth).toBe(-3);
    });

    test("two different offsets conflict once", () => {
        const b = base();
        const ours = editFeature(
            b,
            "feature-hole",
            withExtent((extent) => ({ ...extent, offset: -2 })),
        );
        const theirs = editFeature(
            b,
            "feature-hole",
            withExtent((extent) => ({ ...extent, offset: 1 })),
        );

        const result = merge(b, ours, theirs);

        expect(result.conflicts.map((x) => x.kind)).toEqual(["property"]);
        expect(result.conflicts[0].path).toContain("feature-hole");
        expect(feature(result.merged, "feature-hole").extent.offset).toBe(-2);
    });

    test("the face and its body are one pick: re-picking differently conflicts once, never mixed", () => {
        const b = base();
        const repick = (id: string) =>
            editFeature(
                b,
                "feature-hole",
                withExtent((extent) => ({ ...extent, nodeId: "sketch-hole", face: { ...extent.face, id } })),
            );
        const ours = repick("ours-face");
        const theirs = editFeature(
            b,
            "feature-hole",
            withExtent((extent) => ({ ...extent, face: { ...extent.face, id: "theirs-face" } })),
        );

        const result = merge(b, ours, theirs);

        expect(result.conflicts.map((x) => x.kind)).toEqual(["property"]);
        const merged = feature(result.merged, "feature-hole").extent;
        expect(merged.nodeId).toBe("sketch-hole");
        expect(merged.face.id).toBe("ours-face");
    });

    test("a changed extent type is one value: it conflicts with an offset edit on the other side", () => {
        const b = base();
        const ours = editFeature(b, "feature-hole", (x) => ({ ...x, extent: { type: "throughAll" } }));
        const theirs = editFeature(
            b,
            "feature-hole",
            withExtent((extent) => ({ ...extent, offset: 3 })),
        );

        const result = merge(b, ours, theirs);

        expect(result.conflicts.map((x) => x.kind)).toEqual(["property"]);
        expect(feature(result.merged, "feature-hole").extent).toEqual({ type: "throughAll" });
    });

    test("an extent added on one side merges in cleanly", () => {
        const b = base();
        const ours = editFeature(b, "feature-through", (x) => ({ ...x, secondExtent: { type: "distance" } }));

        const result = merge(b, ours, b);

        expect(result.conflicts).toEqual([]);
        expect(feature(result.merged, "feature-through").secondExtent).toEqual({ type: "distance" });
    });

    test("a face on a body the other side deleted is a dangling reference", () => {
        const withPlate = structuredClone(base());
        withPlate["models"].nodes.push({
            ...structuredClone(node(withPlate, "body-block")),
            id: "body-plate",
        });
        const ours = editFeature(
            withPlate,
            "feature-hole",
            withExtent((extent) => ({ ...extent, nodeId: "body-plate" })),
        );
        const theirs = structuredClone(withPlate);
        theirs["models"].nodes = theirs["models"].nodes.filter((x: Json) => x.id !== "body-plate");

        const result = merge(withPlate, ours, theirs);

        const dangling = result.conflicts.filter((x) => x.kind === "dangling-ref");
        expect(dangling).toHaveLength(1);
        expect(dangling[0].path).toContain("feature-hole");
    });
});
