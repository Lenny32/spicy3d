// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import {
    type IDocument,
    type INode,
    MergePathRevealers,
    mergePath,
    nodeOfMergePath,
    onFeatureFocusRequested,
    requestFeatureFocus,
    revealMergePath,
    takeFeatureFocus,
} from "../src";
import { createMockDocument } from "../test-utils";

// Selecting a conflict or a change (CLOUD-13) shows what its merge path names.

function documentWith(nodes: INode[]) {
    const setSelectedNodes = rs.fn((_nodes: INode[], _toggle: boolean) => _nodes.length);
    const document = createMockDocument({
        selection: { setSelectedNodes },
        modelManager: { findNode: (predicate: (node: INode) => boolean) => nodes.find(predicate) },
    });
    return { document, setSelectedNodes };
}

const body = { id: "body-1", name: "Body" } as unknown as INode;
const sketch = { id: "sketch-1", name: "Sketch" } as unknown as INode;

describe("revealMergePath", () => {
    const cleanups: (() => void)[] = [];

    afterEach(() => {
        for (const cleanup of cleanups.splice(0)) cleanup();
        takeFeatureFocus(body);
    });

    test("selects the node a path is about", () => {
        const { document, setSelectedNodes } = documentWith([body, sketch]);

        const revealed = revealMergePath(document, mergePath("node", "sketch-1", "prop", "name"));

        expect(revealed).toEqual({ node: sketch });
        expect(setSelectedNodes).toHaveBeenCalledWith([sketch], false);
    });

    test("a feature path opens that feature in the body's timeline, asked before the selection", () => {
        const { document, setSelectedNodes } = documentWith([body]);
        const requested: [INode, string][] = [];
        cleanups.push(onFeatureFocusRequested((node, featureId) => requested.push([node, featureId])));
        let focusedAtSelection: string | undefined;
        setSelectedNodes.mockImplementation((nodes: INode[]) => {
            focusedAtSelection = takeFeatureFocus(nodes[0]);
            return 1;
        });

        const revealed = revealMergePath(
            document,
            mergePath("node", "body-1", "feature", "f2", "param", "depth"),
        );

        expect(revealed).toEqual({ node: body, featureId: "f2" });
        expect(requested).toEqual([[body, "f2"]]);
        expect(focusedAtSelection).toBe("f2");
        // Consumed once.
        expect(takeFeatureFocus(body)).toBeUndefined();
    });

    test("registered revealers go further with the rest of the path", () => {
        const { document } = documentWith([sketch]);
        const reveal = rs.fn((_document: IDocument, _node: INode, _segments: readonly string[]) => true);
        cleanups.push(MergePathRevealers.register({ reveal }));

        revealMergePath(document, mergePath("node", "sketch-1", "entity", "123456"));

        expect(reveal).toHaveBeenCalledWith(document, sketch, ["entity", "123456"]);
    });

    test.each([
        ["a document-level path", mergePath("variable", "v1", "expression")],
        ["a node this document does not have", mergePath("node", "gone", "prop", "name")],
    ])("%s reveals nothing", (_what, path) => {
        const { document, setSelectedNodes } = documentWith([body]);

        expect(revealMergePath(document, path)).toBeUndefined();
        expect(nodeOfMergePath(document, path)).toBeUndefined();
        expect(setSelectedNodes).not.toHaveBeenCalled();
    });
});

describe("feature focus", () => {
    test("a request is taken only by a list of its node, once", () => {
        requestFeatureFocus(body, "f1");

        expect(takeFeatureFocus(sketch)).toBeUndefined();
        expect(takeFeatureFocus(body)).toBe("f1");
        expect(takeFeatureFocus(body)).toBeUndefined();
    });
});
