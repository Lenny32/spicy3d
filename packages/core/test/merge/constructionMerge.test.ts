// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { DOCUMENT_FORMAT_VERSION, mergeDocuments, type Serialized } from "../../src";

// The `construction.definition` payload rule for the lengths and angles that may be expressions
// (document format 2): each one a parameter, like an extrude's `depth`.

const W = { id: "var-w", name: "w", expression: "10 mm", type: "length" };

function constructionDocument(definition: object, variables: object[] = [W]): Serialized {
    return {
        __cla$$__: "Document",
        formatVersion: DOCUMENT_FORMAT_VERSION,
        moduleVersions: {},
        id: "doc",
        name: "Doc",
        models: {
            nodes: [
                { __cla$$__: "FolderNode", id: "root", name: "Doc", visible: true },
                {
                    __cla$$__: "ConstructionNode",
                    id: "plane-1",
                    name: "Station",
                    visible: true,
                    parentId: "root",
                    displaySize: 50,
                    definitionJson: JSON.stringify(definition),
                },
            ],
            materials: [],
            components: [],
        },
        variables,
        settings: {},
        acts: [],
        userData: {},
    } as unknown as Serialized;
}

const offset = (distance: number | string, plane = "YZ") => ({
    kind: "plane-offset",
    source: { kind: "origin-plane", plane },
    distance,
});

function merge(base: Serialized, ours: Serialized, theirs: Serialized) {
    const result = mergeDocuments(base, ours, theirs);
    expect(result.isOk).toBe(true);
    const node = result.value.merged["models"].nodes.find((x: { id: string }) => x.id === "plane-1");
    return { definition: JSON.parse(node.definitionJson), conflicts: result.value.conflicts };
}

describe("construction definition merge (expressions)", () => {
    test("an expression distance and a changed source merge field by field", () => {
        const { definition, conflicts } = merge(
            constructionDocument(offset(5)),
            constructionDocument(offset("w * 2")),
            constructionDocument(offset(5, "XY")),
        );

        expect(conflicts).toEqual([]);
        expect(definition).toEqual(offset("w * 2", "XY"));
    });

    test("two different distances are one parameter's conflict", () => {
        const { conflicts } = merge(
            constructionDocument(offset(5)),
            constructionDocument(offset("w")),
            constructionDocument(offset(20)),
        );

        expect(conflicts.map((x) => [x.kind, x.path, x.ours, x.theirs])).toEqual([
            ["property", "node/plane-1/definition/distance", "w", 20],
        ]);
    });

    test("a distance naming a variable the other side deleted dangles", () => {
        const { conflicts } = merge(
            constructionDocument(offset(5)),
            constructionDocument(offset("w + 1")),
            constructionDocument(offset(5), []),
        );

        expect(conflicts.map((x) => [x.kind, x.path])).toContainEqual([
            "dangling-ref",
            "node/plane-1/definition/distance",
        ]);
    });

    test("a path position's distance expression is checked against the variables", () => {
        const along = (value: number | string) => ({
            kind: "plane-along-path",
            path: { kind: "datum", nodeId: "root", member: "X" },
            position: { kind: "distance", value },
        });
        const { conflicts } = merge(
            constructionDocument(along(5)),
            constructionDocument(along("w / 2")),
            constructionDocument(along(5), []),
        );

        expect(conflicts.map((x) => [x.kind, x.path])).toContainEqual([
            "dangling-ref",
            "node/plane-1/definition/position",
        ]);
    });
});
