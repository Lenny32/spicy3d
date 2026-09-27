// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import type { IDocument, INode } from "@spicy3d/core";
import { SketchEditor } from "../../src/sketch/editor/sketchEditor";
import { sketchEntitiesOfPath, sketchMergeRevealer } from "../../src/sketch/mergeReveal";
import type { SketchData } from "../../src/sketch/sketchModel";
import { SketchNode } from "../../src/sketch/sketchNode";
import "./setup";

// A conflict about a sketch entity, selected in the conflict panel (CLOUD-13), opens the sketch and
// selects the entities concerned.

function sketchWith(data: Partial<SketchData>): SketchNode {
    const node = Object.create(SketchNode.prototype) as SketchNode;
    Object.defineProperty(node, "data", { value: { entities: [], constraints: [], ...data } });
    return node;
}

const sketch = sketchWith({
    constraints: [
        {
            id: 77,
            kind: 0 as SketchData["constraints"][number]["kind"],
            refs: [
                { entityId: 5, pointIndex: 0 },
                { entityId: 9, pointIndex: 1 },
                { entityId: 5, pointIndex: 1 },
            ],
        },
    ],
});

function shown(): IDocument {
    const document = { application: {} } as unknown as IDocument;
    (document.application as { activeView?: unknown }).activeView = { document };
    return document;
}

afterEach(() => {
    rs.restoreAllMocks();
});

describe("sketchEntitiesOfPath", () => {
    test.each([
        [["entity", "123"], [123]],
        [["external", "-100"], [-100]],
        [
            ["constraint", "77"],
            [5, 9],
        ],
        [["constraint", "404"], []],
        [["planeRef"], []],
        [["entity", "not-a-number"], []],
    ])("%j → %j", (segments, ids) => {
        expect(sketchEntitiesOfPath(sketch, segments)).toEqual(ids);
    });
});

describe("the sketch merge revealer", () => {
    test("opens the sketch shown and selects the entities", () => {
        const selectEntities = rs.fn((_ids: readonly number[]) => {});
        const enter = rs
            .spyOn(SketchEditor, "enter")
            .mockImplementation(() => ({ selectEntities }) as unknown as SketchEditor);
        rs.spyOn(SketchEditor, "getActive").mockReturnValue(undefined);

        expect(sketchMergeRevealer.reveal(shown(), sketch, ["constraint", "77"])).toBe(true);

        expect(enter).toHaveBeenCalledWith(sketch);
        expect(selectEntities).toHaveBeenCalledWith([5, 9]);
    });

    test("selects in the session already open on that sketch", () => {
        const selectEntities = rs.fn((_ids: readonly number[]) => {});
        rs.spyOn(SketchEditor, "getActive").mockReturnValue({
            node: sketch,
            selectEntities,
        } as unknown as SketchEditor);
        const enter = rs.spyOn(SketchEditor, "enter");

        expect(sketchMergeRevealer.reveal(shown(), sketch, ["entity", "3"])).toBe(true);

        expect(enter).not.toHaveBeenCalled();
        expect(selectEntities).toHaveBeenCalledWith([3]);
    });

    test.each([
        ["not a sketch", { id: "body" } as unknown as INode, ["entity", "3"], true],
        ["no entity in the path", sketch, ["planeRef"], true],
        ["its document not the one shown", sketch, ["entity", "3"], false],
    ])("does nothing when %s", (_what, node, segments, isShown) => {
        const enter = rs.spyOn(SketchEditor, "enter");
        const document = isShown
            ? shown()
            : ({ application: { activeView: undefined } } as unknown as IDocument);

        expect(sketchMergeRevealer.reveal(document, node as INode, segments as string[])).toBe(false);
        expect(enter).not.toHaveBeenCalled();
    });
});
