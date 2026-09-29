// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import {
    documentTimeline,
    type FeatureItem,
    FolderNode,
    type I18nKeys,
    type IFeatureListNode,
    type INode,
    onFeatureFocusRequested,
    revealTimelineEntry,
    takeFeatureFocus,
    timelineEntryLabel,
} from "../src";
import { createMockDocument, createPlainNode, TestDocument } from "../test-utils";

function iconNode(name: string, icon?: string): INode {
    const node = createPlainNode(name, name);
    if (icon !== undefined) Object.assign(node, { icon });
    return node;
}

function feature(id: string, item?: Partial<FeatureItem>): FeatureItem {
    return { id, display: "command.feature.fuse" as I18nKeys, parameters: [], ...item };
}

/** A parametric-body stand-in: a feature list, and consumed tools as children. */
function bodyNode(name: string, features: FeatureItem[], children: INode[] = []): INode & IFeatureListNode {
    const body = Object.assign(iconNode(name, "icon-body"), {
        featureItems: () => features,
        setFeatureParameter: () => {},
        setFeatureSuppressed: () => {},
        moveFeature: () => {},
        removeFeature: () => {},
        firstChild: children[0],
        add: () => {},
    });
    children.forEach((child, i) => {
        child.parent = body as never;
        child.nextSibling = children[i + 1];
    });
    return body as INode & IFeatureListNode;
}

describe("documentTimeline", () => {
    test("lists nodes in model order, walking into folders without listing them", () => {
        const document = new TestDocument();
        const folder = new FolderNode({ document, name: "folder" });
        const sketch = iconNode("sketch", "icon-sketch");
        const box = iconNode("box", "icon-box");
        const plain = iconNode("plain");
        folder.add(box);
        document.modelManager.rootNode.add(sketch, folder, plain);

        const entries = documentTimeline(document);

        expect(entries.map((x) => [x.kind, x.key, x.icon])).toEqual([
            ["node", "sketch", "icon-sketch"],
            ["node", "box", "icon-box"],
            ["node", "plain", "icon-shape"],
        ]);
    });

    test("a feature-list node contributes one entry per feature, after its consumed tools", () => {
        const document = new TestDocument();
        const tool = iconNode("tool", "icon-box");
        const body = bodyNode(
            "body",
            [feature("f1", { icon: "icon-extrude" }), feature("f2", { suppressed: true })],
            [tool],
        );
        document.modelManager.rootNode.add(body);

        const entries = documentTimeline(document);

        expect(entries.map((x) => [x.kind, x.key, x.icon])).toEqual([
            ["node", "tool", "icon-box"],
            ["feature", "body/f1", "icon-extrude"],
            ["feature", "body/f2", "icon-body"],
        ]);
        expect(entries[2]).toMatchObject({ node: body, feature: { id: "f2", suppressed: true } });
    });

    test("a feature-list node with no features is listed as itself", () => {
        const document = new TestDocument();
        document.modelManager.rootNode.add(bodyNode("empty", []));

        expect(documentTimeline(document).map((x) => [x.kind, x.key])).toEqual([["node", "empty"]]);
    });
});

describe("timelineEntryLabel", () => {
    const translate = (key: I18nKeys) => `t:${key}`;

    test.each([
        ["a node by its name", { kind: "node", key: "n", node: iconNode("Sketch 1"), icon: "i" }, "Sketch 1"],
        [
            "a renamed feature by its name",
            {
                kind: "feature",
                key: "k",
                node: bodyNode("b", []),
                icon: "i",
                feature: feature("f", { name: "Hole" }),
            },
            "Hole",
        ],
        [
            "an unnamed feature by its kind",
            { kind: "feature", key: "k", node: bodyNode("b", []), icon: "i", feature: feature("f") },
            "t:command.feature.fuse",
        ],
    ] as const)("names %s", (_case, entry, expected) => {
        expect(timelineEntryLabel(entry, translate)).toBe(expected);
    });
});

describe("revealTimelineEntry", () => {
    test("selects the node of a node entry", () => {
        const setSelectedNodes = rs.fn((_nodes: INode[], _toggle: boolean) => _nodes.length);
        const document = createMockDocument({ selection: { setSelectedNodes } });
        const node = iconNode("box");

        revealTimelineEntry(document, { kind: "node", key: "box", node, icon: "icon-box" });

        expect(setSelectedNodes).toHaveBeenCalledWith([node], false);
    });

    test("a feature entry asks the body's feature list to open it before selecting the body", () => {
        const body = bodyNode("body", []);
        let focusedAtSelection: string | undefined;
        const setSelectedNodes = rs.fn((nodes: INode[], _toggle: boolean) => {
            focusedAtSelection = takeFeatureFocus(nodes[0]);
            return 1;
        });
        const document = createMockDocument({ selection: { setSelectedNodes } });
        const requested: [INode, string][] = [];
        const stop = onFeatureFocusRequested((node, featureId) => requested.push([node, featureId]));
        try {
            revealTimelineEntry(document, {
                kind: "feature",
                key: "body/f1",
                node: body,
                icon: "i",
                feature: feature("f1"),
            });
        } finally {
            stop();
        }

        expect(requested).toEqual([[body, "f1"]]);
        expect(focusedAtSelection).toBe("f1");
        expect(setSelectedNodes).toHaveBeenCalledWith([body], false);
    });

    test("a feature request nobody took does not stay pending", () => {
        const body = bodyNode("body", []);
        const document = createMockDocument();

        revealTimelineEntry(document, {
            kind: "feature",
            key: "body/f1",
            node: body,
            icon: "i",
            feature: feature("f1"),
        });

        expect(takeFeatureFocus(body)).toBeUndefined();
    });
});
