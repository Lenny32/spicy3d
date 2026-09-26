// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { beforeEach, describe, expect, test } from "@rstest/core";
import { isNodeWarning, type Serialized, Serializer, UnknownNode } from "../src";
import { TestDocument } from "../test-utils";

const pluginNode = {
    __cla$$__: "PluginGearNode",
    id: "gear",
    name: "Gear",
    visible: true,
    teeth: 24,
    profile: { __cla$$__: "PluginProfile", module: 2 },
    parentId: "root",
};

function tree(): Serialized[] {
    return [
        { __cla$$__: "FolderNode", id: "root", name: "root", visible: true },
        pluginNode,
        { __cla$$__: "FolderNode", id: "inside", name: "Inside", visible: false, parentId: "gear" },
        { __cla$$__: "FolderNode", id: "after", name: "After", visible: true, parentId: "root" },
    ];
}

describe("UnknownNode", () => {
    let doc: TestDocument;

    beforeEach(() => {
        doc = new TestDocument();
        doc.analyses.dispose();
    });

    test("an unregistered node class loads as a placeholder keeping its children", async () => {
        await doc.modelManager.deserialize({ components: [], materials: [], nodes: tree() });

        const gear = doc.modelManager.findNode((n) => n.id === "gear");
        expect(gear).toBeInstanceOf(UnknownNode);
        expect((gear as UnknownNode).className).toBe("PluginGearNode");
        expect(gear!.name).toBe("Gear");
        expect((gear as UnknownNode).firstChild?.id).toBe("inside");
        expect(isNodeWarning(gear)).toBe(true);
    });

    test("saving writes the stored JSON back unchanged", async () => {
        await doc.modelManager.deserialize({ components: [], materials: [], nodes: tree() });

        expect(doc.modelManager.serialize().nodes).toEqual(tree());
    });

    test("a rename or visibility change in the tree is saved with the raw data", async () => {
        await doc.modelManager.deserialize({ components: [], materials: [], nodes: tree() });
        const gear = doc.modelManager.findNode((n) => n.id === "gear")!;

        gear.name = "Big gear";
        gear.visible = false;

        const saved = doc.modelManager.serialize().nodes.find((n) => n["id"] === "gear");
        expect(saved).toEqual({ ...pluginNode, name: "Big gear", visible: false });
    });

    test("a clone is another placeholder of the same class with a new id", () => {
        const gear = new UnknownNode(doc, pluginNode);

        const copy = gear.clone();

        expect(copy).toBeInstanceOf(UnknownNode);
        expect(copy.id).not.toBe("gear");
        expect(copy.className).toBe("PluginGearNode");
        expect(copy.name).toBe("Gear_copy");
    });

    test("the placeholder does not share or mutate the data it was built from", () => {
        const data = structuredClone(pluginNode);
        const gear = new UnknownNode(doc, data);

        data.profile.module = 99;

        const saved = Serializer.serializeObject(gear);
        expect(saved["profile"]).toEqual({ __cla$$__: "PluginProfile", module: 2 });
        expect(saved["parentId"]).toBeUndefined();
        expect(data.parentId).toBe("root");
    });
});
