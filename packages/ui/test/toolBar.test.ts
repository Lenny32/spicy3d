// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { describe, expect, test } from "@rstest/core";

import type { PubSubRecorder } from "./_helpers/coreMocks";

// CSS modules (shared via helper)
import "./_helpers/cssMocks";

// Track PubSub pub calls via the shared recorder
const pubSubRecorder = rs.hoisted((): PubSubRecorder => {
    const { createPubSubRecorder } = require("./_helpers/coreMocks");
    return createPubSubRecorder();
});

// Mock core
rs.mock("@spicy3d/core", () => {
    const actual = rs.hoisted(() => require("@spicy3d/core"));
    const { I18nMock } = rs.hoisted(() => require("./_helpers/coreMocks"));
    return {
        ...actual,
        I18n: I18nMock,
        PubSub: pubSubRecorder.stub,
        NodeUtils: { isLinkedListNode: () => true },
    };
});

// Mock element helpers
import "./_helpers/mockElement";

// Mock treeItemGroup
rs.mock("../src/project/tree/treeItemGroup", () => ({
    TreeGroup: class {
        isExpanded = false;
    },
}));

import { ToolBar } from "../src/project/toolBar";
import { TreeGroup } from "../src/project/tree/treeItemGroup";
import { mustQuery } from "./_helpers/domHelpers";

describe("ToolBar", () => {
    function createMockProjectView(tree?: unknown) {
        return {
            activeTree: () => tree,
            activeDocument: {
                modelManager: {
                    rootNode: {
                        firstChild: null,
                    },
                },
            },
        };
    }

    beforeEach(() => {
        pubSubRecorder.reset();
    });

    function publishedTopics() {
        return pubSubRecorder.pubs.map((p) => p.topic);
    }

    describe("constructor", () => {
        test("should set className", () => {
            const pv = createMockProjectView() as any;
            const tb = new ToolBar(pv);
            expect(tb.className).toBe("tb-panel");
        });

        test("should create three buttons (newFolder, expandAll, unexpandAll)", () => {
            const pv = createMockProjectView() as any;
            const tb = new ToolBar(pv);

            // Should have 3 anchor children
            const anchors = tb.querySelectorAll("a");
            expect(anchors.length).toBe(3);
        });

        test("should store reference to projectView", () => {
            const pv = createMockProjectView() as any;
            const tb = new ToolBar(pv);
            expect(tb.projectView).toBe(pv);
        });

        test("should render svg icons within anchor buttons", () => {
            const pv = createMockProjectView() as any;
            const tb = new ToolBar(pv);

            const svgs = tb.querySelectorAll("svg");
            expect(svgs.length).toBe(3);
        });
    });

    describe("newFolder button", () => {
        test("should publish executeCommand when clicked", () => {
            const pv = createMockProjectView() as any;
            const tb = new ToolBar(pv);

            const firstSvg = mustQuery<SVGElement>(tb, "svg");
            const onclick = (firstSvg as any)._onclick as (() => void) | undefined;
            expect(onclick).toBeDefined();
            onclick!();

            expect(publishedTopics()).toContain("executeCommand");
        });
    });

    describe("expandAll / unExpandAll", () => {
        test("expandAll should be a no-op when no active tree", () => {
            const pv = createMockProjectView(undefined) as any;
            const tb = new ToolBar(pv);
            expect(pv.activeTree()).toBeUndefined();

            // Find the expand button (index 2 based on the array)
            const svgs = tb.querySelectorAll("svg");
            expect(svgs.length).toBe(3);
            const onclick = (svgs[2] as SVGElement as any)._onclick as (() => void) | undefined; // expandAll is last
            expect(onclick).toBeDefined();
            onclick!();

            // no tree and no command published — nothing happened
            expect(publishedTopics()).toEqual([]);
        });

        test("unExpandAll should be a no-op when no active tree", () => {
            const pv = createMockProjectView(undefined) as any;
            const tb = new ToolBar(pv);
            expect(pv.activeTree()).toBeUndefined();

            const svgs = tb.querySelectorAll("svg");
            expect(svgs.length).toBe(3);
            const onclick = (svgs[1] as SVGElement as any)._onclick as (() => void) | undefined; // unExpandAll is second
            expect(onclick).toBeDefined();
            onclick!();

            expect(publishedTopics()).toEqual([]);
        });

        test("expandAll should set isExpanded on tree group items", () => {
            // TreeGroup is mocked above with a zero-arg class; cast through any
            // because tsc still sees the real constructor signature
            const item = new (TreeGroup as any)() as { isExpanded: boolean };
            const mockTree = {
                treeItem: () => item,
            };

            // Mock activeTree to return our mock
            const pv = {
                activeTree: () => mockTree,
                activeDocument: {
                    modelManager: {
                        rootNode: {
                            firstChild: {
                                firstChild: null,
                                nextSibling: null,
                            },
                        },
                    },
                },
            } as any;

            const tb = new ToolBar(pv);
            const svgs = tb.querySelectorAll("svg");
            expect(svgs.length).toBe(3);
            const onclick = (svgs[2] as SVGElement as any)._onclick as (() => void) | undefined;
            expect(onclick).toBeDefined();

            expect(item.isExpanded).toBe(false);
            onclick!();
            expect(item.isExpanded).toBe(true);
        });
    });
});
