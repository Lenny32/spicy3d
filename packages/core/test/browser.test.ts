// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    Act,
    BrowserActions,
    BrowserProviders,
    type ConstructionNode,
    captureConstructionRef,
    DocumentMutations,
    FolderNode,
    GroupNode,
    Matrix4,
    Mesh,
    MeshNode,
    PubSub,
    Transaction,
    XYZ,
} from "../src";
import { createMockApplication, TestDocument } from "../test-utils";

function setup() {
    const document = new TestDocument({ application: createMockApplication() });
    const model = document.modelManager.browser;
    const actions = new BrowserActions(model);
    const component = (name: string, parent = document.modelManager.rootNode) => {
        const node = new FolderNode({ document, name });
        parent.add(node);
        return node;
    };
    const body = (name: string, parent = document.modelManager.rootNode) => {
        const node = new MeshNode({ document, name, mesh: new Mesh({ meshType: "surface" }) });
        parent.add(node);
        return node;
    };
    return { document, model, actions, component, body };
}

describe("Browser model", () => {
    test("content replacement keeps activation by ID, updates rows, and cleans up replaced observers", () => {
        const { document, model, actions, component, body } = setup();
        try {
            const owner = component("Owner");
            const shape = body("Body", owner);
            actions.activate(model.entries.get(owner.id)!);
            const data = document.modelManager.serialize();
            const stored = data.nodes.find((node) => node["id"] === shape.id)!;
            stored["name"] = "Remote name";
            document.modelManager.applyContent(data);
            const replacement = document.modelManager.findNode((node) => node.id === shape.id)!;
            expect(replacement).not.toBe(shape);
            expect(model.entries.get(shape.id)?.node).toBe(replacement);
            expect(model.entries.get(shape.id)?.name).toBe("Remote name");
            expect(model.nodeKeys.has(shape)).toBe(false);
            expect(model.activeKey).toBe(owner.id);
            const changed = rs.fn(() => {});
            model.changed.sub(changed);
            shape.name = "Detached";
            expect(changed).not.toHaveBeenCalled();
        } finally {
            document.dispose();
        }
    });
    test("moving between existing transformed groups preserves world placement and undo restores it", () => {
        const { document, model, actions, body } = setup();
        try {
            const source = new GroupNode({ document, name: "Source" });
            const target = new GroupNode({ document, name: "Target" });
            source.transform = Matrix4.fromTranslation(10, 0, 0);
            target.transform = Matrix4.fromTranslation(30, 0, 0);
            document.modelManager.addNode(source, target);
            const shape = body("Body", source);
            shape.transform = Matrix4.fromTranslation(5, 0, 0);
            expect(actions.move([model.entries.get(shape.id)!], model.entries.get(target.id)!)).toBe(true);
            expect(shape.parent).toBe(target);
            expect(target.transform.multiply(shape.transform).ofPoint(XYZ.zero).x).toBe(15);
            document.history.undo();
            expect(shape.parent).toBe(source);
            expect(shape.transform.ofPoint(XYZ.zero).x).toBe(5);
        } finally {
            document.dispose();
        }
    });
    test("projects nested components and virtual object categories without modifying serialized data", () => {
        const { document, model, component, body } = setup();
        try {
            const first = component("Base");
            const child = component("Shell", first);
            const shape = body("Solid", child);
            const before = document.modelManager.serialize();
            expect(model.entries.get(model.rootKey)?.node).toBe(document.modelManager.rootNode);
            expect(model.entries.get(first.id)?.type).toBe("component");
            expect(model.entries.get(child.id)?.parentKey).toBe(first.id);
            expect(model.entries.get(shape.id)?.parentKey).toBe(`${child.id}:category:bodies`);
            expect(model.entries.get(`${child.id}:origin`)?.children).toHaveLength(7);
            expect(model.entries.has(`${child.id}:category:sketches`)).toBe(false);
            expect(document.modelManager.serialize()).toEqual(before);
        } finally {
            document.dispose();
        }
    });

    test("external rename, visibility, add, delete, and undo update stable entries", () => {
        const { document, model, component, body } = setup();
        try {
            const owner = component("Owner");
            const shape = body("Body", owner);
            const entry = model.entries.get(shape.id)!;
            shape.name = "Renamed";
            shape.visible = false;
            expect(model.entries.get(shape.id)).toBe(entry);
            expect(entry.name).toBe("Renamed");
            expect(entry.node?.visible).toBe(false);
            Transaction.execute(document, "delete", () => owner.remove(shape));
            expect(model.entries.has(shape.id)).toBe(false);
            expect(model.entries.has(`${owner.id}:category:bodies`)).toBe(false);
            document.history.undo();
            expect(model.entries.get(shape.id)?.node).toBe(shape);
            expect(model.entries.get(shape.id)?.parentKey).toBe(`${owner.id}:category:bodies`);
        } finally {
            document.dispose();
        }
    });

    test("activation directs creation and removing its ancestor falls back to the nearest live container", () => {
        const { document, model, actions, component } = setup();
        try {
            const base = component("Base");
            const shell = component("Shell", base);
            const nested = component("Nested", shell);
            expect(actions.activate(model.entries.get(nested.id)!)).toBe(true);
            const shape = new MeshNode({ document, name: "New", mesh: new Mesh() });
            document.modelManager.addNode(shape);
            expect(shape.parent).toBe(nested);
            base.remove(shell);
            expect(model.activeKey).toBe(base.id);
            expect(document.modelManager.currentNode).toBe(base);
        } finally {
            document.dispose();
        }
    });

    test("valid moves change ownership in one undo step; invalid moves leave it unchanged", () => {
        const { document, model, actions, component, body } = setup();
        try {
            const source = component("Source");
            const target = component("Target");
            const first = body("First", source);
            const second = body("Second", source);
            const entries = [model.entries.get(first.id)!, model.entries.get(second.id)!];
            expect(actions.move(entries, model.entries.get(target.id)!)).toBe(true);
            expect(first.parent).toBe(target);
            expect(second.parent).toBe(target);
            expect(model.entries.get(first.id)?.parentKey).toBe(`${target.id}:category:bodies`);
            document.history.undo();
            expect(first.parent).toBe(source);
            expect(second.parent).toBe(source);
            const nested = component("Nested", source);
            expect(actions.canMove([model.entries.get(source.id)!], model.entries.get(nested.id)!)).toBe(
                false,
            );
            expect(source.parent).toBe(document.modelManager.rootNode);
            expect(actions.canMove(entries, model.entries.get(`${target.id}:origin`)!)).toBe(false);
        } finally {
            document.dispose();
        }
    });

    test("runtime origins never enter the save or undo history and capture existing reference types", () => {
        const { document, model, actions } = setup();
        try {
            const before = document.modelManager.serialize();
            const position = document.history.position();
            for (let index = 0; index < 7; index++) {
                const entry = model.entries.get(`${model.rootKey}:origin:${index}`)!;
                expect(actions.setVisible([entry], true)).toBe(true);
                const node = entry.node as ConstructionNode;
                const geometry = node.geometry;
                expect(geometry.isOk).toBe(true);
                const captured = captureConstructionRef(document, node);
                expect(captured.isOk).toBe(true);
                expect(captured.unchecked()?.kind).toBe(index < 4 ? "fixed" : "origin-plane");
                expect(actions.rename(entry, "Changed")).toBe(false);
                expect(actions.delete([entry])).toBe(false);
                expect(node.parent).toBeUndefined();
                document.modelManager.addNode(node);
                document.modelManager.rootNode.insertAfter(undefined, node);
                expect(node.parent).toBeUndefined();
                node.name = "Changed externally";
                expect(node.name).toBe(entry.name);
            }
            expect(document.history.position()).toBe(position);
            expect(document.modelManager.serialize()).toEqual(before);
            document.modelManager.rootNode.visible = false;
            expect([...model.origins.values()].every((origin) => !origin.parentVisible)).toBe(true);
        } finally {
            document.dispose();
        }
    });

    test("read-only repositories and a held modeling program reject document edits", () => {
        const { document, model, actions, component, body } = setup();
        try {
            const owner = component("Owner");
            const shape = body("Body");
            const entry = model.entries.get(shape.id)!;
            Object.assign(document.repository, { isReadOnly: true });
            expect(actions.rename(entry, "Changed")).toBe(false);
            expect(actions.setVisible([entry], false)).toBe(false);
            expect(actions.move([entry], model.entries.get(owner.id)!)).toBe(false);
            expect(actions.delete([entry])).toBe(false);
            expect(actions.setVisible([model.entries.get(`${model.rootKey}:origin:4`)!], true)).toBe(true);
            Object.assign(document.repository, { isReadOnly: false });
            const scope = DocumentMutations.hold(document);
            try {
                expect(actions.rename(entry, "Changed")).toBe(false);
            } finally {
                scope.release();
            }
            expect(shape.name).toBe("Body");
            expect(shape.parent).toBe(document.modelManager.rootNode);
        } finally {
            document.dispose();
        }
    });

    test("providers classify new objects and unregister without replacing model objects", () => {
        const { document, model, body } = setup();
        const unregister = BrowserProviders.register({
            describe: (node) =>
                node.name === "Profile"
                    ? {
                          type: "customSketch",
                          category: "sketches",
                          icon: "icon-shape",
                      }
                    : undefined,
        });
        try {
            const shape = body("Profile");
            expect(model.entries.get(shape.id)?.parentKey).toBe(`${model.rootKey}:category:sketches`);
            unregister();
            expect(model.entries.get(shape.id)?.type).toBe("mesh");
            expect(model.entries.get(shape.id)?.node).toBe(shape);
        } finally {
            unregister();
            document.dispose();
        }
    });

    test("saved view additions, names, and removals update the projection", () => {
        const { document, model } = setup();
        try {
            const view = new Act({
                name: "Custom",
                cameraPosition: XYZ.unitZ,
                cameraTarget: XYZ.zero,
                cameraUp: XYZ.unitY,
            });
            document.acts.push(view);
            const entry = [...model.entries.values()].find((item) => item.view === view)!;
            expect(entry.name).toBe("Custom");
            view.name = "Changed";
            expect(model.entries.get(entry.key)?.name).toBe("Changed");
            document.acts.remove(view);
            expect(model.entries.has(entry.key)).toBe(false);
            expect(model.entries.get(`${model.rootKey}:views`)?.children).toHaveLength(4);
        } finally {
            document.dispose();
        }
    });

    test("deletion delegates to the guarded application command", () => {
        const { document, model, actions, body } = setup();
        const shape = body("Body");
        const select = rs.fn((_nodes: unknown[], _toggle: boolean) => 1);
        document.selection.setSelectedNodes = select;
        const publish = rs.spyOn(PubSub.default, "pub");
        try {
            expect(actions.delete([model.entries.get(shape.id)!])).toBe(true);
            expect(select).toHaveBeenCalledWith([shape], false);
            expect(publish).toHaveBeenCalledWith("executeCommand", "modify.deleteNode");
        } finally {
            publish.mockRestore();
            document.dispose();
        }
    });
});
