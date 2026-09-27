// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import {
    DOCUMENT_FORMAT_VERSION,
    type DocumentChange,
    DocumentDiffers,
    diffDocuments,
    type IDocumentDiffer,
    NodeListDiffer,
    type Serialized,
} from "../src";

function node(id: string, name: string, extra: Record<string, unknown> = {}) {
    return { __cla$$__: "BoxNode", id, name, visible: true, parentId: "root", ...extra };
}

function documentWith(nodes: object[], formatVersion = DOCUMENT_FORMAT_VERSION): Serialized {
    return {
        __cla$$__: "Document",
        formatVersion,
        moduleVersions: {},
        id: "doc",
        name: "Doc",
        models: {
            components: [],
            materials: [],
            nodes: [{ __cla$$__: "FolderNode", id: "root", name: "Doc", visible: true }, ...nodes],
        },
        variables: [],
        acts: [],
        userData: {},
    } as unknown as Serialized;
}

const summary = (changes: DocumentChange[]) => changes.map((c) => [c.kind, c.target, c.message, ...c.args]);

describe("NodeListDiffer (placeholder until CLOUD-12)", () => {
    test("reports nodes added, removed, renamed and otherwise changed, by id; unchanged ones not at all", () => {
        const before = documentWith([
            node("a", "Box 1", { dx: 10 }),
            node("b", "Box 2"),
            node("c", "Sketch 1"),
            node("d", "Kept"),
        ]);
        const after = documentWith([
            node("a", "Box 1", { dx: 15 }),
            node("c", "Profile"),
            node("d", "Kept"),
            node("e", "Extrude 1"),
        ]);

        expect(summary(new NodeListDiffer().diff(before, after))).toEqual([
            ["modified", "a", "diff.modified{0}", "Box 1"],
            ["renamed", "c", "diff.renamed{0}{1}", "Sketch 1", "Profile"],
            ["added", "e", "diff.added{0}", "Extrude 1"],
            ["removed", "b", "diff.removed{0}", "Box 2"],
        ]);
    });

    test("a node renamed and changed is reported as both", () => {
        const before = documentWith([node("a", "Box 1", { dx: 10 })]);
        const after = documentWith([node("a", "Base", { dx: 20 })]);

        expect(summary(new NodeListDiffer().diff(before, after))).toEqual([
            ["renamed", "a", "diff.renamed{0}{1}", "Box 1", "Base"],
            ["modified", "a", "diff.modified{0}", "Base"],
        ]);
    });

    test("key order of a node's fields is not a change; the root node is never reported", () => {
        const before = documentWith([
            { visible: true, parentId: "root", name: "Box 1", id: "a", __cla$$__: "BoxNode", dx: 1 },
        ]);
        const after = documentWith([node("a", "Box 1", { dx: 1 })]);
        (after["models"] as { nodes: { name: string }[] }).nodes[0].name = "Renamed document";

        expect(new NodeListDiffer().diff(before, after)).toEqual([]);
    });

    test("a document without a model tree compares as empty", () => {
        const empty = { formatVersion: 1 } as unknown as Serialized;

        expect(summary(new NodeListDiffer().diff(empty, documentWith([node("a", "Box 1")])))).toEqual([
            ["added", "a", "diff.added{0}", "Box 1"],
        ]);
    });
});

describe("diffDocuments", () => {
    test("uses the registered differ, and the placeholder again once unregistered", () => {
        const diff = rs.fn((_before: Serialized, _after: Serialized): DocumentChange[] => [
            { kind: "modified", target: "x", message: "diff.modified{0}", args: ["Extrude 3"] },
        ]);
        const semantic: IDocumentDiffer = { diff };
        const unregister = DocumentDiffers.register(semantic);
        try {
            const changes = diffDocuments(documentWith([]), documentWith([]));
            expect(changes.isOk && changes.value[0].args).toEqual(["Extrude 3"]);
            expect(diff).toHaveBeenCalledTimes(1);
        } finally {
            unregister();
        }
        expect(DocumentDiffers.current).toBeInstanceOf(NodeListDiffer);
    });

    test("migrates both sides without modifying them; a newer format is the error", () => {
        const before = documentWith([node("a", "Box 1")]);
        const copy = structuredClone(before);

        const same = diffDocuments(before, before);
        expect(same.isOk && same.value).toEqual([]);
        expect(before).toEqual(copy);

        const newer = diffDocuments(before, documentWith([], DOCUMENT_FORMAT_VERSION + 1));
        expect(newer.isOk).toBe(false);
        expect(!newer.isOk && newer.error.kind).toBe("newerFormat");
    });
});
