// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import {
    compareDocuments,
    DOCUMENT_FORMAT_VERSION,
    type DocumentChange,
    DocumentDiffers,
    displayNodeName,
    I18n,
    type IDocumentDiffer,
    SemanticDiffer,
    type Serialized,
} from "../src";

// The Compare lines of core's classes; the parametric and primitive ones are in
// packages/builder/test/semanticDiff.test.ts (every rule registered there).

function folder(id: string, name: string, extra: Record<string, unknown> = {}) {
    return { __cla$$__: "FolderNode", id, name, visible: true, parentId: "root", ...extra };
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

describe("SemanticDiffer", () => {
    test("reports nodes added, removed, renamed, hidden and moved, by path; unchanged ones not at all", () => {
        const before = documentWith([
            folder("a", "Parts"),
            folder("b", "Old"),
            folder("c", "Sketches"),
            folder("d", "Kept"),
        ]);
        const after = documentWith([
            folder("a", "Parts", { visible: false }),
            folder("c", "Profiles"),
            folder("d", "Kept", { parentId: "a" }),
            folder("e", "New"),
        ]);

        expect(summary(new SemanticDiffer().diff(before, after))).toEqual([
            [
                "modified",
                "node/a/prop/visible",
                "diff.changedValue{0}{1}{2}{3}",
                "Parts",
                "visible",
                "true",
                "false",
            ],
            ["renamed", "node/c/prop/name", "diff.renamed{0}{1}", "Sketches", "Profiles"],
            ["moved", "node/d/parent", "diff.moved{0}", "Kept"],
            ["added", "node/e", "diff.added{0}", "New"],
            ["removed", "node/b", "diff.removed{0}", "Old"],
        ]);
    });

    test("what is inside an added or removed node is not listed again", () => {
        const before = documentWith([folder("a", "Group"), folder("b", "Inner", { parentId: "a" })]);

        expect(summary(new SemanticDiffer().diff(before, documentWith([])))).toEqual([
            ["removed", "node/a", "diff.removed{0}", "Group"],
        ]);
    });

    test("key order is not a change; the document name and variables are", () => {
        const before = documentWith([
            { visible: true, parentId: "root", name: "A", id: "a", __cla$$__: "FolderNode" },
        ]);
        const after = documentWith([folder("a", "A")]);
        after["name"] = "Bracket";
        after["variables"] = [{ id: "v1", name: "w", type: "length", expression: "40 mm" }];

        expect(summary(new SemanticDiffer().diff(before, after))).toEqual([
            ["renamed", "doc/name", "diff.renamed{0}{1}", "Doc", "Bracket"],
            ["added", "variable/v1", "diff.added{0}", "w"],
        ]);
    });

    test("node names made of an i18n key and a counter are shown translated", () => {
        const isKey = rs.spyOn(I18n, "isI18nKey").mockImplementation((key: string) => key === "body.box");
        const translate = rs.spyOn(I18n, "translate").mockImplementation(() => "Box");
        try {
            expect(displayNodeName("body.box12")).toBe("Box 12");
            expect(displayNodeName("Bracket")).toBe("Bracket");
        } finally {
            isKey.mockRestore();
            translate.mockRestore();
        }
    });
});

describe("compareDocuments", () => {
    test("uses the registered differ, and the semantic one again once unregistered", () => {
        const diff = rs.fn((_before: Serialized, _after: Serialized): DocumentChange[] => [
            { kind: "modified", target: "x", message: "diff.modified{0}", args: ["Extrude 3"] },
        ]);
        const other: IDocumentDiffer = { diff };
        const unregister = DocumentDiffers.register(other);
        try {
            const changes = compareDocuments(documentWith([]), documentWith([]));
            expect(changes.isOk && changes.value[0].args).toEqual(["Extrude 3"]);
            expect(diff).toHaveBeenCalledTimes(1);
        } finally {
            unregister();
        }
        expect(DocumentDiffers.current).toBeInstanceOf(SemanticDiffer);
    });

    test("migrates both sides without modifying them; a newer format is the error", () => {
        const before = documentWith([folder("a", "Box 1")]);
        const copy = structuredClone(before);

        const same = compareDocuments(before, before);
        expect(same.isOk && same.value).toEqual([]);
        expect(before).toEqual(copy);

        const newer = compareDocuments(before, documentWith([], DOCUMENT_FORMAT_VERSION + 1));
        expect(newer.isOk).toBe(false);
        expect(!newer.isOk && newer.error.kind).toBe("newerFormat");
    });
});
