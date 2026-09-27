// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { compareDocuments, I18n, type Locale, type Serialized } from "@spicy3d/core";
import { loadMergeFixtures } from "@spicy3d/core/test-utils";
import { en } from "@spicy3d/i18n";
import "@spicy3d/app";
import "@spicy3d/parametric";
import "@spicy3d/wasm";

// The version history's Compare with the semantic differ (CLOUD-12), in English: feature
// parameters with their unit, a sketch's items summarized, nodes by their display name.

let identity: Locale | undefined;

beforeAll(() => {
    identity = I18n.getLanguages().find((x) => x.language === "en");
    I18n.addLanguage(en as Locale);
});

afterAll(() => {
    if (identity) I18n.addLanguage(identity);
});

const base = loadMergeFixtures().find((x) => x.name === "identity-unchanged")!.base;

function edited(edit: (doc: Serialized) => void): Serialized {
    const copy = structuredClone(base);
    copy["settings"] = { lengthUnit: "mm" };
    edit(copy);
    return copy;
}

const nodeOf = (doc: Serialized, id: string) => doc["models"].nodes.find((n: { id: string }) => n.id === id);

function lines(before: Serialized, after: Serialized): string[] {
    const changes = compareDocuments(before, after);
    expect(changes.isOk).toBe(true);
    return changes.value.map((c) => I18n.translate(c.message, ...c.args));
}

test("Compare lists semantic differences", () => {
    const before = edited(() => {});
    const after = edited((doc) => {
        const body = nodeOf(doc, "body-1");
        const features = JSON.parse(body.featuresJson);
        features[0].depth = 15;
        features[1].radius = 1.5;
        body.featuresJson = JSON.stringify(features);
        const sketch = nodeOf(doc, "sketch-1");
        const data = JSON.parse(sketch.dataJson);
        for (const id of [11, 12, 13]) data.entities.push({ id, type: "line", params: [0, id, 1, id] });
        data.constraints = data.constraints.filter((c: { id: number }) => c.id !== 2);
        sketch.dataJson = JSON.stringify(data);
        doc["models"].nodes = doc["models"].nodes.filter(
            (n: { id: string }) => n.id !== "seFZEYsHrtzwpOiyaxckw",
        );
        doc["variables"][0].expression = "45 mm";
    });

    expect(lines(before, after)).toEqual([
        "w: expression 40 mm → 45 mm",
        "Sketch 1: +3 lines, −1 constraint",
        "Extrude 1: depth 10 mm → 15 mm",
        "Fillet 2: radius 1 mm → 1.5 mm",
        "Box 1 deleted",
    ]);
});

test("features added, removed and reordered; a node renamed and moved", () => {
    const before = edited(() => {});
    const after = edited((doc) => {
        const body = nodeOf(doc, "body-1");
        const features = JSON.parse(body.featuresJson);
        body.featuresJson = JSON.stringify([
            features[0],
            features[2],
            features[1],
            { id: "f9", type: "chamfer", distance: 1, edges: [] },
        ]);
        const box = nodeOf(doc, "seFZEYsHrtzwpOiyaxckw");
        box.name = "Base plate";
        box.parentId = "folder-parts";
        doc["models"].nodes = [
            ...doc["models"].nodes.filter(
                (n: { id: string }) => n.id !== box.id && n.id !== "folder-a" && n.id !== "folder-b",
            ),
        ];
        doc["models"].nodes.splice(6, 0, box);
        doc["models"].nodes.push(nodeOf(before, "folder-a"), nodeOf(before, "folder-b"));
    });

    expect(lines(before, after)).toEqual([
        "Extrude 2 reordered",
        "Chamfer 4 added",
        "Box 1 renamed to Base plate",
        "Base plate moved",
    ]);
});
