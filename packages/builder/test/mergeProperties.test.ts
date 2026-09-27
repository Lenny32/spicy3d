// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    assembleManifest,
    deepFreeze,
    type MergeResult,
    mergeDocuments,
    type Serialized,
    splitManifest,
} from "@spicy3d/core";
import fc from "fast-check";
import "@spicy3d/app";
import "@spicy3d/parametric";
import "@spicy3d/wasm";

// Property tests of the merge engine (docs/merge.md, "Identities") over generated documents: a
// tree of folders, boxes, sketches and feature-list bodies, variables and materials, then random
// edits the way the app makes them (renames, parameters, added / removed / moved nodes, features
// inserted, removed and reordered, sketch lines drawn and moved, variables).

type Json = Record<string, any>;

const ROOT = "root";
const IDENTITY = { array: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], __cla$$__: "Matrix4" };

/** A tiny deterministic PRNG, so a generated seed replays the same edits. */
function random(seed: number) {
    let state = seed >>> 0 || 1;
    const next = () => {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        return (state >>> 0) / 2 ** 32;
    };
    return {
        next,
        int: (n: number) => Math.floor(next() * n),
        pick: <T>(items: readonly T[]) => items[Math.floor(next() * items.length)],
    };
}

function nodes(doc: Json): Json[] {
    return doc["models"].nodes;
}

function subtree(doc: Json, id: string): Set<string> {
    const ids = new Set([id]);
    for (const node of nodes(doc)) if (ids.has(node["parentId"])) ids.add(node["id"]);
    return ids;
}

function addNode(doc: Json, node: Json, parentId: string): void {
    const list = nodes(doc);
    const inside = subtree(doc, parentId);
    let at = list.findIndex((n) => n["id"] === parentId) + 1;
    while (at < list.length && inside.has(list[at]["id"])) at++;
    list.splice(at, 0, { ...node, parentId });
}

function removeNode(doc: Json, id: string): void {
    const gone = subtree(doc, id);
    doc["models"].nodes = nodes(doc).filter((n) => !gone.has(n["id"]));
}

function moveNode(doc: Json, id: string, parentId: string): void {
    const moved = subtree(doc, id);
    const block = nodes(doc).filter((n) => moved.has(n["id"]));
    removeNode(doc, id);
    const [head, ...rest] = block;
    addNode(doc, head, parentId);
    const list = nodes(doc);
    list.splice(list.findIndex((n) => n["id"] === id) + 1, 0, ...rest);
}

function geometry(extra: Json): Json {
    return {
        materialId: "mat-1",
        faceMaterialPair: [],
        transform: structuredClone(IDENTITY),
        visible: true,
        ...extra,
    };
}

function sketchData(lines: number): string {
    const entities = Array.from({ length: lines }, (_, i) => ({
        id: i + 1,
        type: "line",
        params: [i, 0, i + 1, 0],
    }));
    return JSON.stringify({ entities, constraints: [], refPositions: {} });
}

/** A base document: `seed` decides its size and shape. */
function baseDocument(seed: number): Serialized {
    const r = random(seed);
    const doc: Json = {
        __cla$$__: "Document",
        formatVersion: 1,
        moduleVersions: { parametric: 1, sketch: 1 },
        id: "prop-doc",
        name: "Generated",
        models: {
            nodes: [{ id: ROOT, name: "Generated", visible: true, __cla$$__: "FolderNode" }],
            materials: [],
            components: [],
        },
        variables: [
            { id: "v1", name: "w", type: "length", expression: "10 mm" },
            { id: "v2", name: "h", type: "length", expression: "w / 2" },
        ],
        settings: { lengthUnit: "mm" },
        acts: [],
        userData: {},
    };
    doc["models"].materials.push({
        id: "mat-1",
        name: "Grey",
        color: 0xaaaaaa,
        opacity: 1,
        __cla$$__: "PhongMaterial",
    });
    const folders = [ROOT];
    for (let i = 0; i < 1 + r.int(3); i++) {
        const id = `folder-${i}`;
        addNode(doc, { id, name: `Folder ${i}`, visible: true, __cla$$__: "FolderNode" }, r.pick(folders));
        folders.push(id);
    }
    for (let i = 0; i < 1 + r.int(3); i++) {
        addNode(
            doc,
            geometry({
                id: `box-${i}`,
                name: `body.box${i + 1}`,
                dx: 10,
                dy: 10,
                dz: 10,
                __cla$$__: "BoxNode",
            }),
            r.pick(folders),
        );
    }
    for (let i = 0; i < 1 + r.int(2); i++) {
        const sketch = `sketch-${i}`;
        addNode(
            doc,
            geometry({
                id: sketch,
                name: `Sketch ${i}`,
                plane: { __cla$$__: "Plane", origin: { x: 0, y: 0, z: 0 } },
                dataJson: sketchData(2 + r.int(3)),
                __cla$$__: "SketchNode",
            }),
            r.pick(folders),
        );
        const features = [
            { id: `f${i}-1`, type: "extrude", sketchId: sketch, depth: 5 },
            { id: `f${i}-2`, type: "fillet", radius: 1, edges: [{ kind: "line", edgeId: `f${i}-1:0` }] },
        ];
        addNode(
            doc,
            geometry({
                id: `body-${i}`,
                name: `Body ${i}`,
                featuresJson: JSON.stringify(features),
                __cla$$__: "ParametricBodyNode",
            }),
            r.pick(folders),
        );
    }
    return doc as Serialized;
}

/** The app's kind of edits, `count` of them, drawn from `seed` (ids carry `tag`, so two sides never collide). */
function edited(base: Serialized, seed: number, count: number, tag: string): Serialized {
    const doc = structuredClone(base) as Json;
    const r = random(seed);
    const find = (id: string) => nodes(doc).find((n) => n["id"] === id)!;
    const of = (cls: string) => nodes(doc).filter((n) => n["__cla$$__"] === cls);
    for (let step = 0; step < count; step++) {
        const all = nodes(doc).slice(1);
        const folders = [
            ROOT,
            ...of("FolderNode")
                .slice(1)
                .map((n) => n["id"]),
        ];
        switch (r.int(12)) {
            case 0: {
                const node = r.pick(all);
                if (node) node["name"] = `${node["name"]}*`;
                break;
            }
            case 1: {
                const box = r.pick(of("BoxNode"));
                if (box) box[r.pick(["dx", "dy", "dz"])] = 1 + r.int(40);
                break;
            }
            case 2:
                addNode(
                    doc,
                    geometry({
                        id: `box-${tag}-${step}`,
                        name: "body.box9",
                        dx: 3,
                        dy: 3,
                        dz: 3,
                        __cla$$__: "BoxNode",
                    }),
                    r.pick(folders),
                );
                break;
            case 3: {
                const node = r.pick(
                    all.filter((n) => n["__cla$$__"] === "BoxNode" || n["__cla$$__"] === "FolderNode"),
                );
                if (node) removeNode(doc, node["id"]);
                break;
            }
            case 4: {
                const node = r.pick(all);
                const target = r.pick(folders);
                if (node && !subtree(doc, node["id"]).has(target)) moveNode(doc, node["id"], target);
                break;
            }
            case 5:
            case 6: {
                const body = r.pick(of("ParametricBodyNode"));
                if (!body) break;
                const features: Json[] = JSON.parse(body["featuresJson"]);
                const action = r.int(4);
                if (action === 0 && features.length > 0)
                    r.pick(features)["depth" in features[0] ? "depth" : "radius"] = 1 + r.int(9);
                if (action === 1)
                    features.splice(r.int(features.length + 1), 0, {
                        id: `f-${tag}-${step}`,
                        type: "chamfer",
                        distance: 0.5,
                        edges: [],
                    });
                if (action === 2 && features.length > 1) features.splice(r.int(features.length), 1);
                if (action === 3 && features.length > 1) {
                    const [moved] = features.splice(r.int(features.length), 1);
                    features.splice(r.int(features.length + 1), 0, moved);
                }
                body["featuresJson"] = JSON.stringify(features);
                break;
            }
            case 7:
            case 8: {
                const sketch = r.pick(of("SketchNode"));
                if (!sketch) break;
                const data = JSON.parse(sketch["dataJson"]);
                const action = r.int(3);
                if (action === 0)
                    data.entities.push({
                        id: 1000 + step + (tag === "o" ? 0 : 500),
                        type: "line",
                        params: [0, step, 1, step],
                    });
                if (action === 1 && data.entities.length > 0)
                    data.entities.splice(r.int(data.entities.length), 1);
                if (action === 2 && data.entities.length > 0)
                    r.pick(data.entities as Json[])["params"] = [step, step, step + 2, step];
                sketch["dataJson"] = JSON.stringify(data);
                break;
            }
            case 9:
                doc["variables"].push({
                    id: `var-${tag}-${step}`,
                    name: `p${tag}${step}`,
                    type: "length",
                    expression: `${step} mm`,
                });
                break;
            case 10: {
                const variable = r.pick(doc["variables"] as Json[]);
                if (variable) variable["expression"] = `${1 + r.int(50)} mm`;
                break;
            }
            default:
                doc["settings"] = { lengthUnit: r.pick(["mm", "cm", "in"]) };
        }
        void find;
    }
    return doc as Serialized;
}

function merged(base: Serialized, ours: Serialized, theirs: Serialized): MergeResult {
    const result = mergeDocuments(deepFreeze(base), deepFreeze(ours), deepFreeze(theirs));
    expect(result.isOk).toBe(true);
    return result.value;
}

const documents = fc.record({
    base: fc.nat(),
    ours: fc.nat(),
    theirs: fc.nat(),
    edits: fc.integer({ min: 1, max: 12 }),
});
const RUNS = { numRuns: 150 };

describe("merge identities (fast-check)", () => {
    test("merge(b, x, b) = x without conflicts", () => {
        fc.assert(
            fc.property(documents, ({ base, ours, edits }) => {
                const b = baseDocument(base);
                const x = edited(b, ours, edits, "o");
                const result = merged(b, x, b);
                expect(result.conflicts).toEqual([]);
                expect(result.merged).toEqual(x);
                expect(result.changes).toEqual([]);
            }),
            RUNS,
        );
    });

    test("merge(b, b, y) = y without conflicts", () => {
        fc.assert(
            fc.property(documents, ({ base, theirs, edits }) => {
                const b = baseDocument(base);
                const y = edited(b, theirs, edits, "t");
                const result = merged(b, b, y);
                expect(result.conflicts).toEqual([]);
                expect(result.merged).toEqual(y);
            }),
            RUNS,
        );
    });

    test("merge(b, x, x) = x without conflicts", () => {
        fc.assert(
            fc.property(documents, ({ base, ours, edits }) => {
                const b = baseDocument(base);
                const x = edited(b, ours, edits, "o");
                const result = merged(b, x, structuredClone(x));
                expect(result.conflicts).toEqual([]);
                expect(result.merged).toEqual(x);
            }),
            RUNS,
        );
    });

    test("any two edit sets merge deterministically into a well-formed document", () => {
        fc.assert(
            fc.property(documents, ({ base, ours, theirs, edits }) => {
                const b = baseDocument(base);
                const [x, y] = [edited(b, ours, edits, "o"), edited(b, theirs, edits, "t")];
                const first = merged(b, x, y);
                const second = merged(b, x, y);
                expect(JSON.stringify(second.merged)).toBe(JSON.stringify(first.merged));
                expect(JSON.stringify(second.conflicts)).toBe(JSON.stringify(first.conflicts));
                const list = nodes(first.merged as Json);
                const ids = list.map((n) => n["id"]);
                expect(new Set(ids).size).toBe(ids.length);
                const seen = new Set<string>([ROOT]);
                for (const node of list.slice(1)) {
                    expect(seen.has(node["parentId"])).toBe(true);
                    seen.add(node["id"]);
                }
            }),
            RUNS,
        );
    });
});

describe("assembled documents and cloud manifests", () => {
    /** Low thresholds: every payload string and number array becomes a blob. */
    const split = (doc: Serialized) => splitManifest(doc, { minStringLength: 40, minArrayLength: 4 });

    test("an assembled side merges with manifest sides by hash: the identities hold", async () => {
        await fc.assert(
            fc.asyncProperty(documents, async ({ base, ours, theirs, edits }) => {
                const b = baseDocument(base);
                const [x, y] = [edited(b, ours, edits, "o"), edited(b, theirs, edits, "t")];
                const [bm, ym] = [await split(b), await split(y)];
                const blobs = new Map([...bm.blobs, ...ym.blobs]);
                const assemble = (doc: Serialized) => assembleManifest(doc, (sha) => blobs.get(sha)).value;

                // this device's version assembled, base and head as manifests
                const same = merged(bm.manifest, b, ym.manifest);
                expect(same.conflicts).toEqual([]);
                expect(assemble(same.merged)).toEqual(y);
                const mine = merged(bm.manifest, x, bm.manifest);
                expect(mine.conflicts).toEqual([]);
                expect(mine.merged).toEqual(x);
            }),
            { numRuns: 40 },
        );
    });
});
