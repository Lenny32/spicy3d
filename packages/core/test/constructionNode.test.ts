// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import { GroupNode, type INode, Matrix4, type NodeRecord, Plane, Serializer, Transaction, XYZ } from "../src";
import { ConstructionNode } from "../src/construction/node";
import { DocumentConstructionResolver } from "../src/construction/resolver";
import type { ConstructionDefinition, ConstructionRef } from "../src/construction/types";
import { createMockApplication, TestDocument } from "../test-utils";

const xyz = (x = 0, y = 0, z = 0) => new XYZ({ x, y, z });
const fixedPoint = (x = 0, y = 0, z = 0): ConstructionRef => ({
    kind: "fixed",
    geometry: { kind: "point", point: xyz(x, y, z) },
});
const fixedAxis = (direction: XYZ): ConstructionRef => ({
    kind: "fixed",
    geometry: { kind: "axis", origin: XYZ.zero, direction },
});
const datum = (node: ConstructionNode): ConstructionRef => ({ kind: "datum", nodeId: node.id });
const offset = (distance: number): ConstructionDefinition => ({
    kind: "plane-offset",
    source: { kind: "origin-plane", plane: "XY" },
    distance,
});

function setup() {
    const doc = new TestDocument({ application: createMockApplication() });
    const add = (definition: ConstructionDefinition, name = "Reference") => {
        const node = new ConstructionNode({ document: doc, definition, name });
        doc.modelManager.addNode(node);
        return node;
    };
    return { doc, add };
}

function planeZ(node: ConstructionNode) {
    const result = node.geometry;
    expect(result.isOk, result.isOk ? undefined : result.error).toBe(true);
    const geometry = result.unchecked()!;
    expect(geometry.kind).toBe("plane");
    if (geometry.kind !== "plane") throw new Error("Expected plane");
    return geometry.plane.origin.z;
}

describe("persistent construction objects", () => {
    test("a source and dependent in the same transformed group receive the placement once", () => {
        const { doc, add } = setup();
        const source = add({ kind: "point-vertex", vertex: fixedPoint(1, 2, 3) });
        const dependent = add({ kind: "point-vertex", vertex: datum(source) });
        const group = new GroupNode({ document: doc, name: "Shared placement" });
        doc.modelManager.addNode(group);
        source.parent!.move(source, group);
        dependent.parent!.move(dependent, group);
        group.transform = Matrix4.fromTranslation(10, 20, 30);
        const geometry = dependent.geometry.unchecked()!;
        expect(geometry.kind).toBe("point");
        if (geometry.kind !== "point") throw new Error("Expected point");
        expect(geometry.point.distanceTo(xyz(11, 22, 33))).toBeLessThan(1e-7);
    });

    test.each<ConstructionDefinition>([
        offset(7),
        { kind: "axis-two-points", first: fixedPoint(1, 2, 3), second: fixedPoint(1, 2, 5) },
        { kind: "point-vertex", vertex: fixedPoint(4, 5, 6) },
        {
            kind: "ucs",
            origin: fixedPoint(1, 2, 3),
            first: fixedAxis(XYZ.unitX),
            second: fixedAxis(XYZ.unitY),
        },
        {
            kind: "plane-offset",
            source: { kind: "fixed", geometry: { kind: "plane", plane: Plane.XY } },
            distance: 3,
        },
    ])("round trips $kind identity, definition and evaluated geometry", (definition) => {
        const { doc, add } = setup();
        const node = add(definition, "Named datum");
        node.displaySize = 25;
        node.visible = false;
        expect(node.geometry.isOk).toBe(true);
        const serialized = Serializer.serializeObject(node);
        const restored = Serializer.deserializeObject(doc, serialized) as ConstructionNode;
        expect(restored).toBeInstanceOf(ConstructionNode);
        expect(restored.id).toBe(node.id);
        expect(restored.name).toBe("Named datum");
        expect(restored.definition).toEqual(node.definition);
        expect(restored.visible).toBe(false);
        expect(restored.displaySize).toBe(25);
        expect(restored.geometry.isOk).toBe(true);
        expect(restored.geometry.unchecked()!).toEqual(node.geometry.unchecked()!);
    });

    test("editing a source updates a hidden downstream datum and its rendered geometry", () => {
        const { add } = setup();
        const source = add(offset(5));
        const dependent = add({ kind: "plane-offset", source: datum(source), distance: 3 });
        expect(planeZ(dependent)).toBe(8);
        const before = dependent.mesh.edges!.position;
        expect(before[2]).toBe(8);
        source.visible = false;
        source.definition = offset(12);
        expect(planeZ(dependent)).toBe(15);
        expect(dependent.mesh.edges!.position[2]).toBe(15);
    });

    test("parameter edit undo and redo restore downstream values", () => {
        const { doc, add } = setup();
        const source = add(offset(5));
        const dependent = add({ kind: "plane-offset", source: datum(source), distance: 3 });
        Transaction.execute(doc, "Edit datum", () => {
            source.definition = offset(20);
        });
        expect(planeZ(dependent)).toBe(23);
        doc.history.undo();
        expect(planeZ(dependent)).toBe(8);
        doc.history.redo();
        expect(planeZ(dependent)).toBe(23);
    });

    test("creation and deletion undo/redo retain identity and restore dependents", () => {
        const { doc, add } = setup();
        let source!: ConstructionNode;
        Transaction.execute(doc, "Create datum", () => {
            source = add(offset(5));
        });
        const id = source.id;
        doc.history.undo();
        expect(doc.modelManager.findNode((node) => node.id === id)).toBeUndefined();
        doc.history.redo();
        expect(doc.modelManager.findNode((node) => node.id === id)).toBe(source);
        const dependent = add({ kind: "plane-offset", source: datum(source), distance: 3 });
        expect(planeZ(dependent)).toBe(8);
        Transaction.execute(doc, "Delete datum", () => source.parent!.remove(source));
        expect(dependent.geometry.isOk).toBe(false);
        expect(String(dependent.geometry.error)).toMatch(/missing|deleted|not found/i);
        doc.history.undo();
        expect(planeZ(dependent)).toBe(8);
        doc.history.redo();
        expect(dependent.geometry.isOk).toBe(false);
    });

    test("loading cyclic definitions reports errors instead of stack overflow or stale coordinates", () => {
        const { add } = setup();
        const first = add(offset(1));
        const second = add({ kind: "plane-offset", source: datum(first), distance: 2 });
        first.definitionJson = JSON.stringify({ kind: "plane-offset", source: datum(second), distance: 3 });
        expect(first.geometry.isOk).toBe(false);
        expect(String(first.geometry.error)).toMatch(/cycl/i);
        expect(second.geometry.isOk).toBe(false);
    });

    test("a cyclic parameter edit is rejected without changing its definition or history", () => {
        const { doc, add } = setup();
        const first = add(offset(1));
        const second = add({ kind: "plane-offset", source: datum(first), distance: 2 });
        const before = first.definitionJson;
        const history = doc.history.undoCount();
        first.definition = { kind: "plane-offset", source: datum(second), distance: 3 };
        expect(first.definitionJson).toBe(before);
        expect(doc.history.undoCount()).toBe(history);
        expect(planeZ(first)).toBe(1);
        expect(planeZ(second)).toBe(3);
    });

    test("axis display extent never changes intersection coordinates", () => {
        const { add } = setup();
        const axis = add({ kind: "axis-two-points", first: fixedPoint(), second: fixedPoint(0, 0, 1) });
        const source = add(offset(10000));
        const point = add({ kind: "point-edge-plane", edge: datum(axis), plane: datum(source) });
        axis.displaySize = 1;
        const result = point.geometry;
        expect(result.isOk).toBe(true);
        const geometry = result.unchecked()!;
        expect(geometry.kind).toBe("point");
        if (geometry.kind !== "point") throw new Error("Expected point");
        expect(geometry.point.z).toBeCloseTo(10000);
        expect(axis.mesh.edges!.position[5] - axis.mesh.edges!.position[2]).toBeCloseTo(1);
    });

    test("derived UCS members keep stable identity through source edits and serialization", () => {
        const { doc, add } = setup();
        const origin = add({ kind: "point-vertex", vertex: fixedPoint(1, 2, 3) });
        const ucs = add({
            kind: "ucs",
            origin: datum(origin),
            first: fixedAxis(XYZ.unitX),
            second: fixedAxis(XYZ.unitY),
        });
        const ref: ConstructionRef = { kind: "datum", nodeId: ucs.id, member: "XY" };
        const dependent = add({ kind: "plane-offset", source: ref, distance: 5 });
        expect(planeZ(dependent)).toBe(8);
        origin.definition = { kind: "point-vertex", vertex: fixedPoint(4, 5, 6) };
        expect(planeZ(dependent)).toBe(11);
        const restored = Serializer.deserializeObject(
            doc,
            Serializer.serializeObject(dependent),
        ) as ConstructionNode;
        expect(restored.definition).toEqual(dependent.definition);
        expect(planeZ(restored)).toBe(11);
        const axis = new DocumentConstructionResolver(doc).resolve({
            kind: "datum",
            nodeId: ucs.id,
            member: "Z",
        });
        expect(axis.isOk).toBe(true);
        expect(axis.unchecked()!).toMatchObject({ kind: "axis", origin: xyz(4, 5, 6), direction: XYZ.unitZ });
    });

    test("group and node transforms are applied once to construction references", () => {
        const { doc, add } = setup();
        const source = add({ kind: "point-vertex", vertex: fixedPoint(1, 2, 3) });
        const group = new GroupNode({ document: doc, name: "Placement" });
        doc.modelManager.addNode(group);
        source.parent!.move(source, group);
        group.transform = Matrix4.fromTranslation(10, 20, 30);
        source.transform = Matrix4.fromTranslation(2, 3, 4);
        const dependent = add({ kind: "point-vertex", vertex: datum(source) });
        const result = dependent.geometry;
        expect(result.isOk).toBe(true);
        const geometry = result.unchecked()!;
        expect(geometry.kind).toBe("point");
        if (geometry.kind !== "point") throw new Error("Expected transformed point");
        expect(geometry.point.distanceTo(xyz(13, 25, 37))).toBeLessThan(1e-7);
    });

    test("group movement notifies downstream consumers and refreshes cached meshes", () => {
        const { doc, add } = setup();
        const source = add(offset(1));
        const group = new GroupNode({ document: doc, name: "Group" });
        doc.modelManager.addNode(group);
        source.parent!.move(source, group);
        const dependent = add({ kind: "plane-offset", source: datum(source), distance: 2 });
        expect(dependent.mesh.edges!.position[2]).toBe(3);
        const changed = rs.fn((property: string) => property);
        dependent.onPropertyChanged(changed);
        group.transform = Matrix4.fromTranslation(0, 0, 10);
        expect(changed.mock.calls.map(([property]) => property)).toContain("geometry");
        expect(dependent.mesh.edges!.position[2]).toBe(13);
    });

    test("watchers reattach when a saved node replaces an instance with the same ID", () => {
        const { doc, add } = setup();
        const original = add(offset(1));
        const dependent = add({ kind: "plane-offset", source: datum(original), distance: 2 });
        expect(dependent.mesh.edges!.position[2]).toBe(3);
        const saved = Serializer.serializeObject(original);
        original.parent!.remove(original);
        const restored = Serializer.deserializeObject(doc, saved) as ConstructionNode;
        doc.modelManager.addNode(restored);
        expect(dependent.mesh.edges!.position[2]).toBe(3);
        const changed = rs.fn((property: string) => property);
        dependent.onPropertyChanged(changed);
        restored.definition = offset(9);
        expect(changed.mock.calls.map(([property]) => property)).toContain("geometry");
        expect(dependent.mesh.edges!.position[2]).toBe(11);
    });

    test("deleting or undoing creation does not leave a ghost visual in the viewport", () => {
        const doc = new TestDocument({ application: createMockApplication() });
        // Mimic the viewport: its tree observer is registered before any construction node exists,
        // so on delete it removes the visual first, then the node's own tree handler runs.
        const displayed = new Set<INode>();
        doc.modelManager.addNodeObserver((records: NodeRecord[]) => {
            for (const record of records) {
                if (["add", "insertBefore", "insertAfter"].includes(record.action))
                    displayed.add(record.node);
                else if (record.action === "remove" || record.action === "transfer")
                    displayed.delete(record.node);
            }
        });
        doc.visual.context.redrawNode = (nodes: INode[]) => {
            for (const node of nodes) {
                displayed.delete(node);
                displayed.add(node);
            }
        };

        let node!: ConstructionNode;
        Transaction.execute(doc, "Create datum", () => {
            node = new ConstructionNode({ document: doc, definition: offset(5) });
            doc.modelManager.addNode(node);
        });
        expect(displayed.has(node)).toBe(true);

        doc.history.undo();
        expect(displayed.has(node)).toBe(false);
        doc.history.redo();
        expect(displayed.has(node)).toBe(true);

        Transaction.execute(doc, "Delete datum", () => node.parent!.remove(node));
        expect(displayed.has(node)).toBe(false);
        node.displaySize = 80;
        doc.modelManager.addNode(new GroupNode({ document: doc, name: "Later change" }));
        expect(displayed.has(node)).toBe(false);

        // Undo the two later edits, then the delete itself: the viewport's add path restores it.
        const undoCount = doc.history.undoCount();
        doc.history.undo();
        doc.history.undo();
        expect(displayed.has(node)).toBe(false);
        doc.history.undo();
        expect(doc.history.undoCount()).toBe(undoCount - 3);
        expect(node.parent).toBe(doc.modelManager.rootNode);
        expect(displayed.has(node)).toBe(true);
    });

    test("a node inside a deleted group is not redrawn", () => {
        const doc = new TestDocument({ application: createMockApplication() });
        const group = new GroupNode({ document: doc, name: "Group" });
        doc.modelManager.addNode(group);
        const node = new ConstructionNode({ document: doc, definition: offset(5) });
        group.add(node);
        const redrawn: INode[] = [];
        doc.visual.context.redrawNode = (nodes: INode[]) => redrawn.push(...nodes);
        node.displaySize = 60;
        expect(redrawn).toEqual([node]);
        group.parent!.remove(group);
        redrawn.length = 0;
        node.displaySize = 70;
        doc.modelManager.addNode(new GroupNode({ document: doc, name: "Later change" }));
        expect(redrawn).toEqual([]);
    });
});
