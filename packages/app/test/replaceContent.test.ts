// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    applyMergeToDocument,
    type IApplication,
    MERGE_HISTORY_NAME,
    mergeDocuments,
    type NodeRecord,
    NullVisual,
    type Serialized,
} from "@spicy3d/core";
import { createMockApplication } from "@spicy3d/core/test-utils";
import { Document } from "../src/document";
import { HeadlessDocumentEvaluator } from "../src/mergeEvaluator";

// Replacing an open document's content with another version of it (a merge, CLOUD-12/13; a pull
// from another device, CLOUD-10): in place, one undo step, unchanged nodes kept, one notification.

function folder(id: string, name: string, parentId = "root", extra: Record<string, unknown> = {}) {
    return { __cla$$__: "FolderNode", id, name, visible: true, parentId, ...extra };
}

function version(nodes: object[], extra: Record<string, unknown> = {}): Serialized {
    return {
        __cla$$__: "Document",
        formatVersion: 1,
        moduleVersions: {},
        id: "doc-1",
        name: "Bracket",
        models: {
            components: [],
            materials: [],
            nodes: [
                { __cla$$__: "FolderNode", id: "root", name: extra["name"] ?? "Bracket", visible: true },
                ...nodes,
            ],
        },
        variables: [],
        settings: {},
        acts: [],
        userData: {},
        ...extra,
    } as unknown as Serialized;
}

const BASE = version([folder("a", "Parts"), folder("a1", "Bolts", "a"), folder("b", "Spares")]);

let app: IApplication;
let document: Document;

beforeEach(async () => {
    app = createMockApplication();
    document = (await Document.load(app, BASE)) as Document;
});

afterEach(() => {
    document.dispose();
});

const ids = (doc: Document) => doc.modelManager.findNodes().map((n) => `${n.id}<${n.parent?.id}`);
const byId = (doc: Document, id: string) => doc.modelManager.findNode((n) => n.id === id);

describe("replaceContent", () => {
    const next = version(
        [folder("b", "Spares"), folder("c", "New", "b"), folder("a", "Parts"), folder("a1", "Screws", "a")],
        { name: "Bracket v2", variables: [{ id: "v1", name: "w", type: "length", expression: "4 mm" }] },
    );

    test("applies the other version in place: unchanged nodes stay the same objects, moved into order", () => {
        const [a, b, a1] = ["a", "b", "a1"].map((id) => byId(document, id));
        const visual = document.visual;

        expect(document.replaceContent(next, "pull").isOk).toBe(true);

        expect(ids(document)).toEqual(["b<root", "c<b", "a<root", "a1<a"]);
        expect(byId(document, "a")).toBe(a);
        expect(byId(document, "b")).toBe(b);
        expect(byId(document, "a1")).not.toBe(a1);
        expect(byId(document, "a1")?.name).toBe("Screws");
        expect(document.name).toBe("Bracket v2");
        expect(document.variables.items.map((v) => v.name)).toEqual(["w"]);
        expect(document.visual).toBe(visual);
        expect(document.serialize()["models"]).toEqual(next["models"]);
    });

    test("is one undo step: undo restores the previous content, redo the new one", () => {
        const before = document.serialize();
        const undos = document.history.undoCount();

        document.replaceContent(next, "pull");
        expect(document.history.undoCount()).toBe(undos + 1);
        expect(document.isDirty).toBe(true);

        document.history.undo();
        expect(document.serialize()).toEqual(before);
        expect(document.isDirty).toBe(false);
        document.history.redo();
        expect(document.serialize()["models"]).toEqual(next["models"]);
        expect(document.name).toBe("Bracket v2");
    });

    test("observers hear one notification, once the tree is final", () => {
        const heard: string[][] = [];
        document.modelManager.addNodeObserver((records: NodeRecord[]) => {
            heard.push(records.map((r) => `${r.action}:${r.node.id}`));
            // every record already sees the final tree
            expect(ids(document)).toEqual(["b<root", "c<b", "a<root", "a1<a"]);
        });
        document.replaceContent(next, "pull");
        expect(heard).toEqual([["remove:a1", "move:b", "insertAfter:c", "insertAfter:a1"]]);
    });

    test("a document that cannot be migrated is refused and nothing changes", () => {
        const before = document.serialize();
        const newer = document.replaceContent(version([], { formatVersion: 99 }), "pull");
        expect(newer.isOk).toBe(false);
        expect(document.serialize()).toEqual(before);
    });
});

describe("applyMergeToDocument", () => {
    test("applies the merge with the user's choices as one step named merge; one undo restores mine", () => {
        const ours = document.serialize();
        const theirs = version([
            folder("a", "Parts (theirs)"),
            folder("a1", "Bolts", "a"),
            folder("b", "Spares"),
        ]);
        (ours["models"] as { nodes: { name: string }[] }).nodes[1].name = "Parts (mine)";
        document.replaceContent(ours, "edit");
        const mine = document.serialize();
        const result = mergeDocuments(BASE, mine, theirs);
        expect(result.value.conflicts.map((c) => c.path)).toEqual(["node/a/prop/name"]);

        const applied = applyMergeToDocument(document, result.value, [
            { path: "node/a/prop/name", choice: "theirs" },
        ]);

        expect(applied.isOk).toBe(true);
        expect(byId(document, "a")?.name).toBe("Parts (theirs)");
        expect(MERGE_HISTORY_NAME).toBe("merge");
        document.history.undo();
        expect(document.serialize()).toEqual(mine);
    });
});

describe("headless documents", () => {
    test("load without a visual and stay out of the open documents", async () => {
        const loaded = await Document.loadHeadless(app, BASE);
        expect(loaded.isOk).toBe(true);
        const headless = loaded.value;
        try {
            expect(headless.headless).toBe(true);
            expect(headless.visual).toBeInstanceOf(NullVisual);
            expect([...app.documents]).not.toContain(headless);
            expect(ids(headless)).toEqual(ids(document));
        } finally {
            headless.dispose();
        }
    });

    test("the headless evaluator rebuilds a version and reports what fails, then disposes it", async () => {
        const broken = version([
            folder("a", "Parts"),
            {
                __cla$$__: "ConstructionNode",
                id: "datum",
                name: "Datum",
                visible: true,
                parentId: "root",
                definitionJson: JSON.stringify({
                    kind: "plane-offset",
                    source: { kind: "shape", nodeId: "gone", shapeType: "face", index: 0 },
                    distance: 5,
                }),
                displaySize: 50,
            },
        ]);
        const progress: number[] = [];
        const report = await new HeadlessDocumentEvaluator(app).evaluate(broken, {
            onProgress: (done) => progress.push(done),
        });
        expect(report.isOk).toBe(true);
        expect([...report.value.keys()]).toEqual(["node/datum/rebuild"]);
        expect(progress).toEqual([1, 2]);
        expect([...app.documents].map((d) => d.id)).toEqual([document.id]);
    });

    test("a document nobody can load is the evaluator's error", async () => {
        const report = await new HeadlessDocumentEvaluator(app).evaluate(version([], { formatVersion: 99 }));
        expect(!report.isOk && report.error.kind).toBe("failed");
    });
});
