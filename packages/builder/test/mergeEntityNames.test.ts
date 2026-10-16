// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { mergeDocuments, type Serialized } from "@spicy3d/core";
import { loadDocumentFixtures } from "@spicy3d/core/test-utils";
import "@spicy3d/app";
import "@spicy3d/parametric";
import "@spicy3d/wasm";
import type { SketchData } from "../../parametric/src/sketch/sketchModel";
import "../../parametric/test/sketch/setup";

const OUTER = 418273645091;
const HOLE = 927364518204;
const LINE = 556120938471;

function fixture(): Serialized {
    const found = loadDocumentFixtures().find((entry) => entry.name === "v2/sketch7-entity-names.json");
    expect(found).not.toBeUndefined();
    return structuredClone(found!.data);
}
function data(doc: Serialized): SketchData {
    return JSON.parse(doc["models"].nodes[1]["dataJson"]);
}
function edit(doc: Serialized, change: (payload: SketchData) => void): Serialized {
    const result = structuredClone(doc),
        payload = data(result);
    change(payload);
    result["models"].nodes[1]["dataJson"] = JSON.stringify(payload);
    return result;
}
const named = (doc: Serialized) => Object.fromEntries(data(doc).entities.map((e) => [e.id, e.name]));

test("a name merges independently of the entity's geometry", () => {
    const base = fixture();
    const ours = edit(base, (p) => {
        p.entities.find((e) => e.id === LINE)!.name = "baseline";
    });
    const theirs = edit(base, (p) => {
        p.entities.find((e) => e.id === LINE)!.params = [0, -12, 40, -12];
        delete p.entities.find((e) => e.id === HOLE)!.name;
    });
    const merged = mergeDocuments(base, ours, theirs);
    expect(merged.isOk).toBe(true);
    expect(merged.value.conflicts).toEqual([]);
    expect(named(merged.value.merged)).toEqual({ [OUTER]: "outer", [HOLE]: undefined, [LINE]: "baseline" });
    expect(data(merged.value.merged).entities.find((e) => e.id === LINE)!.params).toEqual([0, -12, 40, -12]);
});

test("naming one entity two ways is a conflict on that name", () => {
    const base = fixture();
    const ours = edit(base, (p) => {
        p.entities.find((e) => e.id === LINE)!.name = "baseline";
    });
    const theirs = edit(base, (p) => {
        p.entities.find((e) => e.id === LINE)!.name = "floor";
    });
    const merged = mergeDocuments(base, ours, theirs);
    expect(merged.isOk).toBe(true);
    expect(merged.value.conflicts.map((c) => c.path)).toEqual([`node/sketch-names/entity/${LINE}/name`]);
});
