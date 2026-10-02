// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    CONFLICT_MESSAGE_KEYS,
    type ConflictKind,
    type MergeConflict,
    Mesh,
    MeshNode,
    mergePath,
    type Serialized,
    Serializer,
} from "../../src";
import { createMockDocument, loadDocumentFixtures } from "../../test-utils";

// The merge fixture corpus (packages/core/test/fixtures/merge/<case>/), as code: every case starts
// from the stored v1 document (`fixtures/documents/v1/rich.json`, a document the real serializer
// wrote) and edits it the way the app would, as pure JSON operations. `mergeFixtures.test.ts`
// checks the files against this module; `npm run merge:fixtures` rewrites them.
// The expected results are the spec's (docs/merge.md) answers; the engine (CLOUD-12) must match them.

type Doc = Serialized;
type Json = Record<string, any>;

export interface MergeFixtureCase {
    readonly name: string;
    readonly description: string;
    readonly base: Doc;
    readonly ours: Doc;
    readonly theirs: Doc;
    readonly expected: Doc;
    readonly conflicts: MergeConflict[];
}

// ------------------------------------------------------------------ JSON editing helpers

const clone = <T>(value: T): T => structuredClone(value);

function nodesOf(doc: Doc): Json[] {
    return doc["models"].nodes;
}

function nodeOf(doc: Doc, id: string): Json {
    const node = nodesOf(doc).find((n) => n["id"] === id);
    if (node === undefined) throw new Error(`no node ${id}`);
    return node;
}

/** The ids of `id` and its descendants (the flat array is pre-order: a subtree is contiguous). */
function subtree(doc: Doc, id: string): Set<string> {
    const ids = new Set([id]);
    for (const node of nodesOf(doc)) if (ids.has(node["parentId"])) ids.add(node["id"]);
    return ids;
}

/** Appends `node` as the last child of `parentId` (after the parent's whole subtree). */
function addNode(doc: Doc, node: Json, parentId: string): void {
    const nodes = nodesOf(doc);
    const inside = subtree(doc, parentId);
    let at = nodes.findIndex((n) => n["id"] === parentId) + 1;
    while (at < nodes.length && inside.has(nodes[at]["id"])) at++;
    nodes.splice(at, 0, { ...node, parentId });
}

function removeNode(doc: Doc, id: string): void {
    const gone = subtree(doc, id);
    doc["models"].nodes = nodesOf(doc).filter((n) => !gone.has(n["id"]));
}

function moveNode(doc: Doc, id: string, parentId: string): void {
    const moved = subtree(doc, id);
    const block = nodesOf(doc).filter((n) => moved.has(n["id"]));
    removeNode(doc, id);
    const [head, ...rest] = block;
    addNode(doc, head, parentId);
    const nodes = nodesOf(doc);
    nodes.splice(nodes.findIndex((n) => n["id"] === id) + 1, 0, ...rest);
}

function features(doc: Doc, bodyId: string): Json[] {
    return JSON.parse(nodeOf(doc, bodyId)["featuresJson"]);
}

function setFeatures(doc: Doc, bodyId: string, list: Json[]): void {
    nodeOf(doc, bodyId)["featuresJson"] = JSON.stringify(list);
}

function editFeature(doc: Doc, bodyId: string, featureId: string, patch: Json): void {
    setFeatures(
        doc,
        bodyId,
        features(doc, bodyId).map((f) => (f["id"] === featureId ? { ...f, ...patch } : f)),
    );
}

function insertFeature(doc: Doc, bodyId: string, index: number, feature: Json): void {
    const list = features(doc, bodyId);
    list.splice(index, 0, feature);
    setFeatures(doc, bodyId, list);
}

function sketch(doc: Doc, sketchId: string): Json {
    return JSON.parse(nodeOf(doc, sketchId)["dataJson"]);
}

function editSketch(doc: Doc, sketchId: string, edit: (data: Json) => void): void {
    const data = sketch(doc, sketchId);
    edit(data);
    nodeOf(doc, sketchId)["dataJson"] = JSON.stringify(data);
}

function edit(doc: Doc, ...edits: ((doc: Doc) => void)[]): Doc {
    const copy = clone(doc);
    for (const step of edits) step(copy);
    return copy;
}

// ------------------------------------------------------------------ The shared base

const ROOT = "fJ8oZYZU28huXd6_BAPDu";
const PARTS = "folder-parts";
const BODY = "body-1";
const BOX = "seFZEYsHrtzwpOiyaxckw";
const MATERIAL = "fQnNVYa1q5JyF1bROHuKN";

const IDENTITY = {
    array: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    __cla$$__: "Matrix4",
};

function xyz(x: number, y: number, z: number): Json {
    return { x, y, z, __cla$$__: "XYZ" };
}

function plane(z = 0): Json {
    return { origin: xyz(0, 0, z), normal: xyz(0, 0, 1), xvec: xyz(1, 0, 0), __cla$$__: "Plane" };
}

function sketchNode(id: string, name: string, data: Json, extra: Json = {}): Json {
    return {
        plane: plane(),
        dataJson: JSON.stringify(data),
        materialId: MATERIAL,
        faceMaterialPair: [],
        transform: clone(IDENTITY),
        id,
        name,
        visible: true,
        __cla$$__: "SketchNode",
        ...extra,
    };
}

/** A datum plane offset from the body's top face, captured after `f2` (position `featureIndex`). */
function datumOnTop(featureIndex: number): Json {
    const definition = {
        kind: "plane-offset",
        source: {
            kind: "shape",
            nodeId: BODY,
            shapeType: "face",
            index: 6,
            trackedId: "sketch:sketch-1:e1.2.3.4:top",
            featureIndex,
        },
        distance: 5,
    };
    return {
        definitionJson: JSON.stringify(definition),
        displaySize: 50,
        materialId: MATERIAL,
        faceMaterialPair: [],
        transform: clone(IDENTITY),
        id: "datum-top",
        name: "Datum above the top",
        visible: true,
        __cla$$__: "ConstructionNode",
    };
}

function folder(id: string, name: string): Json {
    return { id, name, visible: true, __cla$$__: "FolderNode" };
}

function box(id: string, name: string, dx: number): Json {
    const base = nodeOf(sharedBase(), BOX);
    return { ...clone(base), id, name, dx, parentId: undefined };
}

/** An imported mesh (one triangle), serialized by the real serializer. */
function meshNode(id: string, name: string, positions: number[]): Json {
    const mesh = new Mesh({
        meshType: "surface",
        position: new Float32Array(positions),
        index: new Uint32Array([0, 1, 2]),
    });
    const node = new MeshNode({ document: createMockDocument(), mesh, name, id, materialId: MATERIAL });
    return Serializer.serializeObject(node);
}

let cachedBase: Doc | undefined;

/**
 * `v1/rich.json` plus: a spare circle sketch (`sketch-2`, used by no feature), a boss sketch
 * (`sketch-3`) fused onto the block by a third feature `f3`, and two empty folders `folder-a` /
 * `folder-b` at the root. `body-1`: f1 extrude `sketch-1` 10 → f2 fillet r1 on edge `f1:0` → f3
 * extrude `sketch-3` 15, fuse.
 */
function sharedBase(): Doc {
    if (cachedBase === undefined) {
        const rich = loadDocumentFixtures().find((x) => x.name === "v1/rich.json");
        if (rich === undefined) throw new Error("fixture v1/rich.json is missing");
        const doc = clone(rich.data);
        doc["id"] = "merge-fixture";
        doc["name"] = "Merge fixture";
        addNode(
            doc,
            sketchNode("sketch-2", "Spare sketch", {
                entities: [{ id: 1, type: "circle", params: [60, 10, 5] }],
                constraints: [],
            }),
            PARTS,
        );
        addNode(
            doc,
            sketchNode("sketch-3", "Boss sketch", {
                entities: [{ id: 1, type: "circle", params: [20, 10, 3] }],
                constraints: [],
            }),
            PARTS,
        );
        insertFeature(doc, BODY, 2, {
            id: "f3",
            type: "extrude",
            sketchId: "sketch-3",
            depth: 15,
            operation: "fuse",
        });
        addNode(doc, folder("folder-a", "Folder A"), ROOT);
        addNode(doc, folder("folder-b", "Folder B"), ROOT);
        cachedBase = doc;
    }
    return clone(cachedBase);
}

// ------------------------------------------------------------------ Conflicts

/** Conflicts as fixtures store them: `undefined` sides are left out of the JSON. */
function conflict(
    kind: ConflictKind,
    path: string,
    values: { base?: unknown; ours?: unknown; theirs?: unknown },
    args: unknown[],
    choices: MergeConflict["choices"],
    messageKey = CONFLICT_MESSAGE_KEYS[kind],
): MergeConflict {
    return {
        kind,
        path,
        base: values.base,
        ours: values.ours,
        theirs: values.theirs,
        messageKey,
        args,
        choices,
    };
}

const sideChoices: MergeConflict["choices"] = ["ours", "theirs"];

// ------------------------------------------------------------------ Cases

type CaseBuilder = () => Omit<MergeFixtureCase, "name">;

/** Two fixed ids in the random range of `sketchIds.ts` — what two devices would draw. */
const OURS_LINE_ID = 734_251_950_211;
const THEIRS_LINE_ID = 91_827_364_555;

const CASES: Record<string, CaseBuilder> = {
    "sketch-angle-datum-side-conflict": () => {
        const base = clone(
            loadDocumentFixtures().find((entry) => entry.name === "v2/sketch5-angle-side.json")!.data,
        );
        const setAngle = (datum: string, angleSide: number) => (d: Doc) =>
            editSketch(d, "sketch-angle", (data) => {
                Object.assign(
                    data["constraints"].find((c: Json) => c["id"] === 4),
                    { datum, angleSide },
                );
            });
        const ours = edit(base, setAngle("45", -1));
        const theirs = edit(base, setAngle("60", 1));
        return {
            description: "Concurrent angle expression edits choose datum source and angleSide together.",
            base,
            ours,
            theirs,
            expected: clone(ours),
            conflicts: [
                conflict(
                    "property",
                    mergePath("node", "sketch-angle", "constraint", "4", "datum"),
                    {
                        base: { datum: "tilt", angleSide: -1 },
                        ours: { datum: "45", angleSide: -1 },
                        theirs: { datum: "60", angleSide: 1 },
                    },
                    ["constraint 4", "datum"],
                    sideChoices,
                ),
            ],
        };
    },
    "sketch-text-content-vs-height": () => {
        const base = edit(sharedBase(), (d) => {
            d["moduleVersions"] = { ...d["moduleVersions"], sketch: 4 };
            editSketch(d, "sketch-1", (data) => {
                data["texts"] = [
                    {
                        id: 800,
                        value: "O",
                        profileIds: [801, 802],
                        x: 100,
                        y: 100,
                        height: 10,
                        angle: 0,
                        frame: { width: 30, height: 20 },
                    },
                ];
            });
        });
        const content = (d: Doc) =>
            editSketch(d, "sketch-1", (data) => {
                data["texts"][0].value = "B";
                data["texts"][0].profileIds.push(803);
            });
        const height = (d: Doc) =>
            editSketch(d, "sketch-1", (data) => {
                data["texts"][0].height = 12;
            });
        return {
            description:
                "Editable text content and cap height changed independently; both retained with stable contour ids.",
            base,
            ours: edit(base, content),
            theirs: edit(base, height),
            expected: edit(base, content, height),
            conflicts: [],
        };
    },

    "delete-node-vs-move": () => {
        const base = sharedBase();
        const ours = edit(base, (d) => removeNode(d, BOX));
        return {
            description:
                "This device deleted the box, the other moved it into Folder A: a move is a modification — delete-vs-modify, the deletion held (ours).",
            base,
            ours,
            theirs: edit(base, (d) => moveNode(d, BOX, "folder-a")),
            expected: clone(ours),
            conflicts: [
                conflict(
                    "delete-vs-modify",
                    mergePath("node", BOX),
                    { base: nodeOf(base, BOX), theirs: { ...nodeOf(base, BOX), parentId: "folder-a" } },
                    ["body.box1"],
                    sideChoices,
                ),
            ],
        };
    },

    "tree-kept-node-parents-gone": () => {
        const base = edit(
            sharedBase(),
            (d) => addNode(d, folder("folder-p", "Folder P"), ROOT),
            (d) => addNode(d, folder("folder-c", "Folder C"), "folder-p"),
            (d) => addNode(d, folder("folder-q", "Folder Q"), ROOT),
        );
        const ours = edit(base, (d) => removeNode(d, "folder-q"));
        const theirs = edit(
            base,
            (d) => moveNode(d, "folder-c", "folder-q"),
            (d) => removeNode(d, "folder-p"),
        );
        return {
            description:
                "Folder C is kept by both devices, but each deleted the folder the other put it in (this one Q, the other P): C is never dropped — ours' parent P comes back with it, reported as a move.",
            base,
            ours,
            theirs,
            expected: clone(ours),
            conflicts: [
                conflict(
                    "move",
                    mergePath("node", "folder-c", "parent"),
                    { base: "folder-p", ours: "folder-p", theirs: "folder-q" },
                    ["Folder C"],
                    sideChoices,
                ),
                conflict(
                    "delete-vs-modify",
                    mergePath("node", "folder-q"),
                    { base: nodeOf(base, "folder-q"), theirs: nodeOf(theirs, "folder-q") },
                    ["Folder Q"],
                    sideChoices,
                ),
            ],
        };
    },

    "tree-cycle-into-deleted-parent": () => {
        const base = edit(
            sharedBase(),
            (d) => addNode(d, folder("folder-p", "Folder P"), ROOT),
            (d) => addNode(d, folder("folder-n", "Folder N"), "folder-p"),
            (d) => addNode(d, folder("folder-m", "Folder M"), ROOT),
        );
        return {
            description:
                "M into N here; N into M and N's folder P deleted there: a cycle whose reverted node has no parent left on any side — it goes to the root, with its subtree.",
            base,
            ours: edit(base, (d) => moveNode(d, "folder-m", "folder-n")),
            theirs: edit(
                base,
                (d) => moveNode(d, "folder-n", "folder-m"),
                (d) => removeNode(d, "folder-p"),
            ),
            expected: edit(
                base,
                (d) => moveNode(d, "folder-n", ROOT),
                (d) => removeNode(d, "folder-p"),
                (d) => moveNode(d, "folder-m", "folder-n"),
            ),
            conflicts: [
                conflict(
                    "cycle",
                    mergePath("node", "folder-n", "parent"),
                    { base: "folder-p", ours: "folder-p", theirs: "folder-m" },
                    ["Folder N", "Folder M"],
                    sideChoices,
                ),
            ],
        };
    },

    "delete-node-vs-modify-theirs-deleted": () => {
        const base = sharedBase();
        const ours = edit(base, (d) => (nodeOf(d, BOX)["dx"] = 25));
        return {
            description:
                "The mirror of delete-node-vs-modify: this device made the box longer, the other deleted it — delete-vs-modify, merged holds ours (the edited box).",
            base,
            ours,
            theirs: edit(base, (d) => removeNode(d, BOX)),
            expected: clone(ours),
            conflicts: [
                conflict(
                    "delete-vs-modify",
                    mergePath("node", BOX),
                    { base: nodeOf(base, BOX), ours: nodeOf(ours, BOX) },
                    ["body.box1"],
                    sideChoices,
                ),
            ],
        };
    },

    "variables-same-name-both-add": () => {
        const base = sharedBase();
        const ours = edit(base, (d) =>
            d["variables"].push({ id: "var-ours", name: "thickness", expression: "2 mm", type: "length" }),
        );
        return {
            description:
                "Both devices added a variable named thickness with different values: the table may hold one name once — a duplicate name, merged keeps ours (theirs' definition dropped).",
            base,
            ours,
            theirs: edit(base, (d) =>
                d["variables"].push({
                    id: "var-theirs",
                    name: "thickness",
                    expression: "3 mm",
                    type: "length",
                }),
            ),
            expected: clone(ours),
            conflicts: [
                conflict(
                    "duplicate-id",
                    mergePath("variable", "var-theirs", "name"),
                    { theirs: "thickness" },
                    ["thickness"],
                    sideChoices,
                    "merge.conflict.duplicateName{0}",
                ),
            ],
        };
    },

    "construction-anchor-remap": () => {
        const base = sharedBase();
        const inserted = {
            id: "early-pad",
            type: "extrude",
            sketchId: "sketch-2",
            depth: 3,
            operation: "fuse",
        };
        const insertEarly = (d: Doc) => insertFeature(d, BODY, 1, inserted);
        return {
            description:
                "This device added a datum plane on the body's top face captured after f2 (featureIndex 2); the other inserted a feature before f2. A ConstructionRef's featureIndex is a timeline position: it follows f2 to 3.",
            base,
            ours: edit(base, (d) => addNode(d, datumOnTop(2), ROOT)),
            theirs: edit(base, insertEarly),
            expected: edit(base, insertEarly, (d) => addNode(d, datumOnTop(3), ROOT)),
            conflicts: [],
        };
    },

    "tree-move-two-cycles": () => {
        const base = edit(
            sharedBase(),
            (d) => addNode(d, folder("folder-c", "Folder C"), ROOT),
            (d) => addNode(d, folder("folder-d", "Folder D"), ROOT),
        );
        const ours = edit(
            base,
            (d) => moveNode(d, "folder-a", "folder-b"),
            (d) => moveNode(d, "folder-c", "folder-d"),
        );
        return {
            description:
                "Two cycles at once (A into B and C into D here, B into A and D into C there): each is broken on its own, one cycle conflict per move of theirs reverted.",
            base,
            ours,
            theirs: edit(
                base,
                (d) => moveNode(d, "folder-b", "folder-a"),
                (d) => moveNode(d, "folder-d", "folder-c"),
            ),
            expected: clone(ours),
            conflicts: [
                conflict(
                    "cycle",
                    mergePath("node", "folder-b", "parent"),
                    { base: ROOT, ours: ROOT, theirs: "folder-a" },
                    ["Folder B", "Folder A"],
                    sideChoices,
                ),
                conflict(
                    "cycle",
                    mergePath("node", "folder-d", "parent"),
                    { base: ROOT, ours: ROOT, theirs: "folder-c" },
                    ["Folder D", "Folder C"],
                    sideChoices,
                ),
            ],
        };
    },

    "rebuild-failure-thin-wall": () => {
        const base = sharedBase();
        // this device narrowed the block to 8 mm (y), the other set the fillet on its vertical
        // edge to 12 mm: each is fine alone, together the fillet no longer fits the 8 mm face
        const narrow = (d: Doc) =>
            editSketch(d, "sketch-1", (s) => {
                s["entities"][1]["params"] = [40, 0, 40, 8];
                s["entities"][2]["params"] = [40, 8, 0, 8];
                s["entities"][3]["params"] = [0, 8, 0, 0];
            });
        const bigFillet = (d: Doc) => editFeature(d, BODY, "f2", { radius: 12 });
        return {
            description:
                "A thinner wall here, a bigger fillet there: two valid parameter changes whose combination fails — merged structurally without conflict; the validation pass (kernel) reports the fillet as a rebuild-failure. Its args[1] is the kernel's error message, not stored here.",
            base,
            ours: edit(base, narrow),
            theirs: edit(base, bigFillet),
            expected: edit(base, narrow, bigFillet),
            conflicts: [
                conflict(
                    "rebuild-failure",
                    mergePath("node", BODY, "feature", "f2", "rebuild"),
                    {},
                    ["fillet f2"],
                    ["accept"],
                ),
            ],
        };
    },

    "blob-both-replaced": () => {
        const base = edit(sharedBase(), (d) =>
            addNode(d, meshNode("mesh-1", "Scan", [0, 0, 0, 1, 0, 0, 0, 1, 0]), ROOT),
        );
        const replace = (positions: number[]) => (d: Doc) => {
            nodeOf(d, "mesh-1")["mesh"] = meshNode("mesh-1", "Scan", positions)["mesh"];
        };
        const ours = edit(base, replace([0, 0, 0, 2, 0, 0, 0, 2, 0]));
        const theirs = edit(base, replace([0, 0, 0, 3, 0, 0, 0, 3, 0]));
        return {
            description:
                "Both devices re-imported the mesh with different data: opaque geometry is never merged inside — a blob conflict, ours held.",
            base,
            ours,
            theirs,
            expected: clone(ours),
            conflicts: [
                conflict(
                    "blob",
                    mergePath("node", "mesh-1", "prop", "mesh"),
                    {
                        base: nodeOf(base, "mesh-1")["mesh"],
                        ours: nodeOf(ours, "mesh-1")["mesh"],
                        theirs: nodeOf(theirs, "mesh-1")["mesh"],
                    },
                    ["Scan", "mesh"],
                    sideChoices,
                ),
            ],
        };
    },
    "identity-unchanged": () => {
        const base = sharedBase();
        return {
            description: "Nothing changed on either side: the merge is the base, no conflict.",
            base,
            ours: clone(base),
            theirs: clone(base),
            expected: clone(base),
            conflicts: [],
        };
    },

    "identity-ours-only": () => {
        const base = sharedBase();
        const ours = edit(
            base,
            (d) => editFeature(d, BODY, "f1", { depth: 12 }),
            (d) => (nodeOf(d, BOX)["name"] = "Red box"),
        );
        return {
            description: "Only this device changed things: merge(base, ours, base) = ours.",
            base,
            ours,
            theirs: clone(base),
            expected: clone(ours),
            conflicts: [],
        };
    },

    "identity-same-change-both": () => {
        const base = sharedBase();
        const change = (d: Doc) => {
            editFeature(d, BODY, "f1", { depth: 12 });
            nodeOf(d, BOX)["dx"] = 15;
        };
        const ours = edit(base, change);
        return {
            description: "Both devices made the identical change: taken once, no conflict.",
            base,
            ours,
            theirs: edit(base, change),
            expected: clone(ours),
            conflicts: [],
        };
    },

    "feature-params-different-features": () => {
        const base = sharedBase();
        const ours = (d: Doc) => editFeature(d, BODY, "f1", { depth: 12 });
        const theirs = (d: Doc) => editFeature(d, BODY, "f2", { radius: 1.5 });
        return {
            description: "Parameters of two different features: both taken.",
            base,
            ours: edit(base, ours),
            theirs: edit(base, theirs),
            expected: edit(base, ours, theirs),
            conflicts: [],
        };
    },

    "feature-different-params-same-feature": () => {
        const base = sharedBase();
        const ours = (d: Doc) => editFeature(d, BODY, "f1", { depth: 12 });
        const theirs = (d: Doc) => editFeature(d, BODY, "f1", { symmetric: true });
        return {
            description: "Two different parameters of one feature: per-parameter 3-way, both taken.",
            base,
            ours: edit(base, ours),
            theirs: edit(base, theirs),
            expected: edit(base, ours, theirs),
            conflicts: [],
        };
    },

    "feature-same-param-conflict": () => {
        const base = sharedBase();
        const ours = edit(base, (d) => editFeature(d, BODY, "f1", { depth: 12 }));
        return {
            description:
                "The same extrude distance set to 12 here and 15 there: a property conflict, ours held.",
            base,
            ours,
            theirs: edit(base, (d) => editFeature(d, BODY, "f1", { depth: 15 })),
            expected: clone(ours),
            conflicts: [
                conflict(
                    "property",
                    mergePath("node", BODY, "feature", "f1", "param", "depth"),
                    { base: 10, ours: 12, theirs: 15 },
                    ["extrude f1", "depth"],
                    sideChoices,
                ),
            ],
        };
    },

    "delete-sketch-vs-add-constraint": () => {
        const base = sharedBase();
        const ours = edit(base, (d) => removeNode(d, "sketch-2"));
        const theirs = edit(base, (d) =>
            editSketch(d, "sketch-2", (s) => {
                s["constraints"].push({ id: 1, kind: 10, refs: [{ entityId: 1, pointIndex: 0 }], datum: 5 });
            }),
        );
        return {
            description:
                "This device deleted the spare sketch, the other added a radius constraint to it: delete-vs-modify, the deletion held.",
            base,
            ours,
            theirs,
            expected: clone(ours),
            conflicts: [
                conflict(
                    "delete-vs-modify",
                    mergePath("node", "sketch-2"),
                    { base: nodeOf(base, "sketch-2"), theirs: nodeOf(theirs, "sketch-2") },
                    ["Spare sketch"],
                    sideChoices,
                ),
            ],
        };
    },

    "timeline-insert-same-position": () => {
        const base = sharedBase();
        const oursFeature = {
            id: "ours-boss",
            type: "extrude",
            sketchId: "sketch-3",
            depth: 20,
            operation: "fuse",
        };
        const theirsFeature = { id: "theirs-cut", type: "extrude", sketchId: "sketch-2", depth: 4 };
        const ours = edit(base, (d) => insertFeature(d, BODY, 3, oursFeature));
        const theirs = edit(base, (d) => insertFeature(d, BODY, 3, theirsFeature));
        return {
            description:
                "Both devices inserted a feature at timeline position 3 (after f3): their order changes the geometry — an order conflict, both kept ours first.",
            base,
            ours,
            theirs,
            expected: edit(base, (d) => {
                insertFeature(d, BODY, 3, oursFeature);
                insertFeature(d, BODY, 4, theirsFeature);
            }),
            conflicts: [
                conflict(
                    "order",
                    mergePath("node", BODY, "insertAfter", "f3"),
                    { base: [], ours: ["ours-boss"], theirs: ["theirs-cut"] },
                    ["body.parametricBody1"],
                    ["ours-first", "theirs-first", "ours", "theirs"],
                    "merge.conflict.insertAt{0}",
                ),
            ],
        };
    },

    "delete-feature-vs-fillet-on-its-edge": () => {
        const base = sharedBase();
        const fillet = {
            id: "boss-fillet",
            type: "fillet",
            radius: 0.5,
            edges: [
                {
                    kind: "circle",
                    center: { x: 20, y: 10, z: 15 },
                    radius: 3,
                    axis: { x: 0, y: 0, z: 1 },
                    edgeId: "f3:2",
                },
            ],
        };
        const removeBoss = (d: Doc) =>
            setFeatures(
                d,
                BODY,
                features(d, BODY).filter((f) => f["id"] !== "f3"),
            );
        const addFillet = (d: Doc) => insertFeature(d, BODY, 3, fillet);
        return {
            description:
                "This device deleted the boss extrude f3, the other filleted the boss's top edge (tracked id f3:2): both applied, the fillet's edge is a dangling reference.",
            base,
            ours: edit(base, removeBoss),
            theirs: edit(base, addFillet),
            expected: edit(base, addFillet, removeBoss),
            conflicts: [
                conflict(
                    "dangling-ref",
                    mergePath("node", BODY, "feature", "boss-fillet", "param", "edges"),
                    { theirs: fillet.edges },
                    ["fillet boss-fillet", "f3"],
                    ["accept", "ours", "theirs"],
                ),
            ],
        };
    },

    "rename-variable-vs-new-expression": () => {
        const base = sharedBase();
        const rename = (d: Doc) => {
            d["variables"][0] = { ...d["variables"][0], name: "width" };
            d["variables"][1] = { ...d["variables"][1], expression: "width / 2" };
        };
        const useOldName = (d: Doc) => editFeature(d, BODY, "f1", { depth: "w / 4" });
        return {
            description:
                "This device renamed variable w to width (and fixed h), the other set f1's depth to `w / 4`: both applied, the expression names a variable that no longer exists.",
            base,
            ours: edit(base, rename),
            theirs: edit(base, useOldName),
            expected: edit(base, rename, useOldName),
            conflicts: [
                conflict(
                    "dangling-ref",
                    mergePath("node", BODY, "feature", "f1", "param", "depth"),
                    { base: 10, ours: 10, theirs: "w / 4" },
                    ["extrude f1", "w"],
                    ["accept", "ours", "theirs"],
                ),
            ],
        };
    },

    "both-add-sketch-line": () => {
        const base = sharedBase();
        const oursLine = { id: OURS_LINE_ID, type: "line", params: [0, 30, 40, 30] };
        const theirsLine = { id: THEIRS_LINE_ID, type: "line", params: [0, -10, 40, -10] };
        const add = (line: Json) => (d: Doc) => editSketch(d, "sketch-1", (s) => s["entities"].push(line));
        return {
            description:
                "Each device drew a line in the same sketch; random ids keep them apart: both kept, ours first.",
            base,
            ours: edit(base, add(oursLine)),
            theirs: edit(base, add(theirsLine)),
            expected: edit(base, add(oursLine), add(theirsLine)),
            conflicts: [],
        };
    },

    "sketch-same-entity-changed-differently": () => {
        const base = sharedBase();
        const resize = (params: number[]) => (d: Doc) =>
            editSketch(d, "sketch-2", (s) => {
                s["entities"][0]["params"] = params;
            });
        const ours = edit(base, resize([60, 10, 6]));
        return {
            description:
                "The same circle resized differently: an entity's params are one value — a property conflict, ours held.",
            base,
            ours,
            theirs: edit(base, resize([60, 10, 7])),
            expected: clone(ours),
            conflicts: [
                conflict(
                    "property",
                    mergePath("node", "sketch-2", "entity", 1, "params"),
                    { base: [60, 10, 5], ours: [60, 10, 6], theirs: [60, 10, 7] },
                    ["circle 1", "params"],
                    sideChoices,
                ),
            ],
        };
    },

    "sketch-delete-entity-vs-new-constraint": () => {
        const line = { id: 2, type: "line", params: [50, 0, 50, 20] };
        const base = edit(sharedBase(), (d) => editSketch(d, "sketch-2", (s) => s["entities"].push(line)));
        const deleteLine = (d: Doc) =>
            editSketch(d, "sketch-2", (s) => {
                s["entities"] = s["entities"].filter((e: Json) => e["id"] !== 2);
            });
        const constraint = {
            id: 527_604_118_392,
            kind: 5,
            refs: [
                { entityId: 2, pointIndex: 0 },
                { entityId: 2, pointIndex: 1 },
            ],
        };
        const constrain = (d: Doc) => editSketch(d, "sketch-2", (s) => s["constraints"].push(constraint));
        return {
            description:
                "This device deleted a line of the spare sketch, the other made it vertical: both applied, the new constraint references a deleted entity.",
            base,
            ours: edit(base, deleteLine),
            theirs: edit(base, constrain),
            expected: edit(base, deleteLine, constrain),
            conflicts: [
                conflict(
                    "dangling-ref",
                    mergePath("node", "sketch-2", "constraint", constraint.id, "refs"),
                    { theirs: constraint.refs },
                    [`constraint ${constraint.id}`, "line 2"],
                    ["accept", "ours", "theirs"],
                ),
            ],
        };
    },

    "sketch-duplicate-entity-id": () => {
        const base = sharedBase();
        const id = 408_117_326_905;
        const add = (params: number[]) => (d: Doc) =>
            editSketch(d, "sketch-1", (s) => s["entities"].push({ id, type: "line", params }));
        const ours = edit(base, add([0, 40, 10, 40]));
        return {
            description:
                "Both devices added a different entity under the same id (the collision random ids make vanishingly rare): duplicate-id, ours held.",
            base,
            ours,
            theirs: edit(base, add([0, 50, 10, 50])),
            expected: clone(ours),
            conflicts: [
                conflict(
                    "duplicate-id",
                    mergePath("node", "sketch-1", "entity", id),
                    {
                        ours: { id, type: "line", params: [0, 40, 10, 40] },
                        theirs: { id, type: "line", params: [0, 50, 10, 50] },
                    },
                    [`line ${id}`],
                    sideChoices,
                ),
            ],
        };
    },

    "timeline-anchor-remap": () => {
        const base = sharedBase();
        const onFace = sketchNode(
            "sketch-top",
            "Sketch on top",
            {
                entities: [{ id: 1, type: "circle", params: [30, 10, 2] }],
                constraints: [],
                refPositions: { [BODY]: 2 },
            },
            {
                plane: plane(10),
                planeRefJson: JSON.stringify({ nodeId: BODY, normal: { x: 0, y: 0, z: 1 }, offset: 10 }),
            },
        );
        const inserted = {
            id: "early-pad",
            type: "extrude",
            sketchId: "sketch-2",
            depth: 3,
            operation: "fuse",
        };
        const addSketch = (position: number) => (d: Doc) => {
            const node = clone(onFace);
            const data = JSON.parse(node["dataJson"]);
            data.refPositions[BODY] = position;
            node["dataJson"] = JSON.stringify(data);
            addNode(d, node, PARTS);
        };
        const insertEarly = (d: Doc) => insertFeature(d, BODY, 1, inserted);
        return {
            description:
                "This device put a sketch on the body's top face, anchored after f2 (position 2); the other inserted a feature before f2. Anchors merge as feature ids: the anchor follows f2 to position 3.",
            base,
            ours: edit(base, addSketch(2)),
            theirs: edit(base, insertEarly),
            expected: edit(base, insertEarly, addSketch(3)),
            conflicts: [],
        };
    },

    "tree-move-cycle": () => {
        const base = sharedBase();
        const ours = edit(base, (d) => moveNode(d, "folder-a", "folder-b"));
        return {
            description:
                "This device moved Folder A into Folder B, the other Folder B into Folder A: each fine alone, a cycle together — ours held, Folder B stays at the root.",
            base,
            ours,
            theirs: edit(base, (d) => moveNode(d, "folder-b", "folder-a")),
            expected: clone(ours),
            conflicts: [
                conflict(
                    "cycle",
                    // reported on the node whose move is dropped (theirs'), which stays at the root
                    mergePath("node", "folder-b", "parent"),
                    { base: ROOT, ours: ROOT, theirs: "folder-a" },
                    ["Folder B", "Folder A"],
                    sideChoices,
                ),
            ],
        };
    },

    "tree-move-same-node": () => {
        const base = sharedBase();
        const ours = edit(base, (d) => moveNode(d, BOX, "folder-a"));
        return {
            description:
                "The box moved into Folder A here and into Folder B there: a move conflict, ours held.",
            base,
            ours,
            theirs: edit(base, (d) => moveNode(d, BOX, "folder-b")),
            expected: clone(ours),
            conflicts: [
                conflict(
                    "move",
                    mergePath("node", BOX, "parent"),
                    { base: ROOT, ours: "folder-a", theirs: "folder-b" },
                    ["body.box1"],
                    sideChoices,
                ),
            ],
        };
    },

    "tree-moves-different-nodes": () => {
        const base = sharedBase();
        const ours = (d: Doc) => moveNode(d, BOX, "folder-a");
        const theirs = (d: Doc) => moveNode(d, "sketch-2", "folder-b");
        return {
            description: "Different nodes moved to different folders: both moves taken.",
            base,
            ours: edit(base, ours),
            theirs: edit(base, theirs),
            expected: edit(base, ours, theirs),
            conflicts: [],
        };
    },

    "delete-node-vs-modify": () => {
        const base = sharedBase();
        const ours = edit(base, (d) => removeNode(d, BOX));
        const theirs = edit(base, (d) => (nodeOf(d, BOX)["dx"] = 25));
        return {
            description:
                "This device deleted the box, the other made it longer: delete-vs-modify, the deletion held.",
            base,
            ours,
            theirs,
            expected: clone(ours),
            conflicts: [
                conflict(
                    "delete-vs-modify",
                    mergePath("node", BOX),
                    { base: nodeOf(base, BOX), theirs: nodeOf(theirs, BOX) },
                    ["body.box1"],
                    sideChoices,
                ),
            ],
        };
    },

    "delete-node-vs-untouched": () => {
        const base = sharedBase();
        const ours = (d: Doc) => removeNode(d, BOX);
        const theirs = (d: Doc) =>
            editSketch(d, "sketch-3", (s) => {
                s["entities"][0]["params"] = [20, 10, 4];
            });
        return {
            description: "The box deleted here, an unrelated sketch edited there: both taken.",
            base,
            ours: edit(base, ours),
            theirs: edit(base, theirs),
            expected: edit(base, ours, theirs),
            conflicts: [],
        };
    },

    "both-add-nodes": () => {
        const base = sharedBase();
        const ours = (d: Doc) => addNode(d, box("box-ours", "Box here", 5), ROOT);
        const theirs = (d: Doc) => addNode(d, box("box-theirs", "Box there", 7), ROOT);
        return {
            description:
                "Each device added a box at the end of the root: both kept, ours first (a stable order, no conflict).",
            base,
            ours: edit(base, ours),
            theirs: edit(base, theirs),
            expected: edit(base, ours, theirs),
            conflicts: [],
        };
    },

    "document-fields": () => {
        const base = sharedBase();
        return {
            description:
                "Both renamed the document (last writer — the other device's head — wins, no conflict); units changed there, userData here: all taken.",
            base,
            ours: edit(base, (d) => {
                d["name"] = "Name from here";
                d["userData"] = { ...d["userData"], reviewed: true };
            }),
            theirs: edit(base, (d) => {
                d["name"] = "Name from there";
                d["settings"] = { lengthUnit: "mm" };
            }),
            expected: edit(base, (d) => {
                d["name"] = "Name from there";
                d["settings"] = { lengthUnit: "mm" };
                d["userData"] = { ...d["userData"], reviewed: true };
            }),
            conflicts: [],
        };
    },

    "variables-both-add": () => {
        const base = sharedBase();
        const ours = (d: Doc) =>
            d["variables"].push({ id: "var-ours", name: "depth", expression: "h + 2 mm", type: "length" });
        const theirs = (d: Doc) =>
            d["variables"].push({ id: "var-theirs", name: "gap", expression: "1 mm", type: "length" });
        return {
            description:
                "Each device appended a variable: both kept, ours first (every expression still resolves).",
            base,
            ours: edit(base, ours),
            theirs: edit(base, theirs),
            expected: edit(base, ours, theirs),
            conflicts: [],
        };
    },

    "variable-same-expression-conflict": () => {
        const base = sharedBase();
        const set = (expression: string) => (d: Doc) => {
            d["variables"][0] = { ...d["variables"][0], expression };
        };
        const ours = edit(base, set("45 mm"));
        return {
            description: "The same variable given two different values: a property conflict on the variable.",
            base,
            ours,
            theirs: edit(base, set("50 mm")),
            expected: clone(ours),
            conflicts: [
                conflict(
                    "property",
                    mergePath("variable", "v1", "expression"),
                    { base: "40 mm", ours: "45 mm", theirs: "50 mm" },
                    ["w", "expression"],
                    sideChoices,
                ),
            ],
        };
    },

    "timeline-reorder-conflict": () => {
        const pad = { id: "f4", type: "extrude", sketchId: "sketch-2", depth: 4, operation: "fuse" };
        const base = edit(sharedBase(), (d) => insertFeature(d, BODY, 3, pad));
        const moveAfter = (anchor: string) => (d: Doc) => {
            const list = features(d, BODY).filter((f) => f["id"] !== "f4");
            list.splice(list.findIndex((f) => f["id"] === anchor) + 1, 0, pad);
            setFeatures(d, BODY, list);
        };
        const ours = edit(base, moveAfter("f1"));
        return {
            description:
                "The pad f4 moved after f1 here and after f2 there: one feature reordered differently — an order conflict, ours held.",
            base,
            ours,
            theirs: edit(base, moveAfter("f2")),
            expected: clone(ours),
            conflicts: [
                conflict(
                    "order",
                    mergePath("node", BODY, "feature", "f4", "position"),
                    // a position is the id of the feature right before it (null = the start)
                    { base: "f3", ours: "f1", theirs: "f2" },
                    ["extrude f4"],
                    sideChoices,
                ),
            ],
        };
    },
};

/** Every case, by name (sorted), built fresh on every call. */
export function buildMergeFixtureCases(): MergeFixtureCase[] {
    return Object.keys(CASES)
        .sort()
        .map((name) => ({ name, ...CASES[name]() }));
}
