// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { mergeDocuments, migrateDocument, type Serialized } from "@spicy3d/core";
import { loadDocumentFixtures } from "@spicy3d/core/test-utils";
import "@spicy3d/app";
import "@spicy3d/parametric";
import "@spicy3d/wasm";

// The merge rule of a sketch bspline (sketch format 2, docs/merge.md "Sketches"). Base: the
// v2/sketch2-bspline fixture — sketch-open holds an open bspline (entity 1) closed by a line,
// sketch-periodic a periodic centripetal one.

// biome-ignore lint/suspicious/noExplicitAny: loosely typed serialized documents
type Json = any;

function base(): Json {
    const fixture = loadDocumentFixtures().find((x) => x.name === "v2/sketch2-bspline.json");
    expect(fixture).not.toBeUndefined();
    return migrateDocument(fixture!.data).value as Json;
}

const node = (doc: Json, id: string): Json => doc["models"].nodes.find((x: Json) => x.id === id);

const bspline = (doc: Json, sketchId: string): Json =>
    JSON.parse(node(doc, sketchId).dataJson).entities.find((x: Json) => x.type === "bspline");

/** `doc` with the bspline of `sketchId` rewritten by `edit`. */
function editBSpline(doc: Json, sketchId: string, edit: (entity: Json) => Json): Json {
    const next = structuredClone(doc);
    const sketch = node(next, sketchId);
    const data = JSON.parse(sketch.dataJson);
    data.entities = data.entities.map((x: Json) => (x.type === "bspline" ? edit(x) : x));
    sketch.dataJson = JSON.stringify(data);
    return next;
}

const merge = (b: Json, ours: Json, theirs: Json) => {
    const result = mergeDocuments(b as Serialized, ours as Serialized, theirs as Serialized);
    expect(result.isOk).toBe(true);
    return result.value;
};

describe("merging bsplines", () => {
    test("a moved fit point on one side and a new parametrization on the other are both kept", () => {
        const b = base();
        const ours = editBSpline(b, "sketch-open", (x) => ({
            ...x,
            params: x.params.map((v: number, i: number) => (i === 5 ? v + 2 : v)),
        }));
        const theirs = editBSpline(b, "sketch-open", (x) => ({ ...x, parametrization: "centripetal" }));

        const result = merge(b, ours, theirs);

        expect(result.conflicts).toEqual([]);
        const merged = bspline(result.merged, "sketch-open");
        expect(merged.parametrization).toBe("centripetal");
        expect(merged.params[5]).toBe(bspline(b, "sketch-open").params[5] + 2);
    });

    test("opening a periodic curve on one side and reparametrizing it on the other are both kept", () => {
        const b = base();
        const ours = editBSpline(b, "sketch-periodic", ({ periodic: _periodic, ...x }) => x);
        const theirs = editBSpline(b, "sketch-periodic", (x) => ({ ...x, parametrization: "chord" }));

        const result = merge(b, ours, theirs);

        expect(result.conflicts).toEqual([]);
        const merged = bspline(result.merged, "sketch-periodic");
        expect(merged.periodic).toBeUndefined();
        expect(merged.parametrization).toBe("chord");
    });

    test("two different parametrizations conflict once, at the entity's field", () => {
        const b = base();
        const ours = editBSpline(b, "sketch-open", (x) => ({ ...x, parametrization: "uniform" }));
        const theirs = editBSpline(b, "sketch-open", (x) => ({ ...x, parametrization: "centripetal" }));

        const result = merge(b, ours, theirs);

        expect(result.conflicts.map((x) => x.kind)).toEqual(["property"]);
        expect(result.conflicts[0].path).toContain("parametrization");
    });
});
