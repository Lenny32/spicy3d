// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    assembleManifest,
    compareDocuments,
    decodeDocumentFile,
    encodeDocumentFile,
    mergeDocuments,
    migrateDocument,
    type Serialized,
    splitManifest,
} from "@spicy3d/core";
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

function controlBase(): Json {
    const fixture = loadDocumentFixtures().find((x) => x.name === "v2/sketch3-control-nurbs.json");
    expect(fixture).not.toBeUndefined();
    return migrateDocument(fixture!.data).value;
}

test("control layout conflicts atomically rather than combining unrelated weights and knots", () => {
    const b = controlBase();
    const ours = editBSpline(b, "sketch-open", (e) => ({
        ...e,
        control: { ...e.control, weights: [1, 1, 1] },
    }));
    const theirs = editBSpline(b, "sketch-open", (e) => ({ ...e, control: { ...e.control, knots: [0, 2] } }));
    const result = merge(b, ours, theirs);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].path).toBe("node/sketch-open/entity/1/control");
    expect(bspline(result.merged, "sketch-open").control).toEqual(bspline(ours, "sketch-open").control);
});
test("pole movement and a weight edit merge independently with stable entity paths", () => {
    const b = controlBase();
    const ours = editBSpline(b, "sketch-open", (e) => ({ ...e, params: [20, 0, 22, 22, 0, 20] }));
    const theirs = editBSpline(b, "sketch-open", (e) => ({
        ...e,
        control: { ...e.control, weights: [1, 1, 1] },
    }));
    const result = merge(b, ours, theirs);
    expect(result.conflicts).toEqual([]);
    expect(bspline(result.merged, "sketch-open")).toMatchObject({
        id: 1,
        params: [20, 0, 22, 22, 0, 20],
        control: { weights: [1, 1, 1] },
    });
    const compared = compareDocuments(b, theirs);
    expect(compared.isOk).toBe(true);
    expect(compared.value).toHaveLength(1);
    expect(compared.value[0].target).toContain("sketch-open");
});
test("cloud manifests and device spicy export round-trip control metadata exactly", async () => {
    const b = controlBase();
    const { manifest, blobs } = await splitManifest(b);
    const assembled = assembleManifest(JSON.parse(JSON.stringify(manifest)), (sha) => blobs.get(sha));
    expect(assembled.isOk).toBe(true);
    expect(assembled.value).toEqual(b);
    const decoded = await decodeDocumentFile(await encodeDocumentFile(assembled.value));
    expect(decoded.isOk).toBe(true);
    expect(decoded.value).toEqual(b);
    expect(bspline(decoded.value, "sketch-periodic").control.weights).toEqual([1, 2, 1, 2]);
    const encodedBlobs = Object.fromEntries(
        [...blobs].map(([sha, bytes]) => [sha, Buffer.from(bytes).toString("base64")]),
    );
    encodedBlobs["manifest"] = Buffer.from(JSON.stringify(manifest)).toString("base64");
    const cloudExport = {
        type: "spicy3d.cloudVersion",
        exportFormat: 1,
        manifestSha256: "manifest",
        blobs: encodedBlobs,
    };
    const exported = await decodeDocumentFile(new Blob([JSON.stringify(cloudExport)]));
    expect(exported.isOk).toBe(true);
    expect(exported.value).toEqual(b);
});
