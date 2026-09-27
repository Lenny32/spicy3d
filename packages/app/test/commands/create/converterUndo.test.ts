// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EditableShapeNode, type IDocument, ShapeTypes, XYZ } from "@spicy3d/core";
import { createMockVisualWithDocument, TestDocument } from "@spicy3d/core/test-utils";
import { initWasm, ShapeFactory } from "@spicy3d/wasm";
import { WireNode } from "../../../src/bodys/wire";
import { ConvertToWire } from "../../../src/commands/create/converter";
import { SelectionManager } from "../../../src/selectionManager";

const WASM_BINARY = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../wasm/lib/spicy-wasm.wasm"),
);

let restoreApp: () => void;
let factory: ShapeFactory;

beforeAll(async () => {
    await initWasm({ wasmBinary: WASM_BINARY });
    factory = new ShapeFactory();

    const previous = Object.getOwnPropertyDescriptor(globalThis, "app");
    Object.defineProperty(globalThis, "app", {
        configurable: true,
        get: () => ({ shapeProvider: { factory } }),
    });
    restoreApp = () => {
        if (previous) Object.defineProperty(globalThis, "app", previous);
    };
});

afterAll(() => restoreApp?.());

function lineNode(document: IDocument, name: string, x1: number, y1: number, x2: number, y2: number) {
    const edge = factory.line(new XYZ({ x: x1, y: y1, z: 0 }), new XYZ({ x: x2, y: y2, z: 0 }));
    if (!edge.isOk) throw new Error(edge.error);
    return new EditableShapeNode({ document, name, shape: edge.value });
}

function createDocument() {
    const doc = new TestDocument();
    doc.visual = createMockVisualWithDocument(doc);
    (doc.visual as any).document = doc;
    doc.selection = new SelectionManager(doc);
    return doc;
}

async function runConvertToWire(doc: IDocument) {
    const cmd = new ConvertToWire();
    (cmd as any)._application = { activeView: { document: doc } };
    await cmd.executeAsync();
}

function rootChildren(doc: IDocument) {
    return (doc.modelManager.rootNode as any).children() as unknown[];
}

describe("ConvertToWire undo then redo conversion (real wasm)", () => {
    test("convert two edges to wire, undo, convert again", async () => {
        const doc = createDocument();
        const n1 = lineNode(doc, "l1", 0, 0, 10, 0);
        const n2 = lineNode(doc, "l2", 10, 0, 10, 10);
        doc.modelManager.rootNode.add(n1, n2);

        doc.selection.setSelectedNodes([n1, n2], false);
        await runConvertToWire(doc);

        let children = rootChildren(doc);
        expect(children.length).toBe(1);
        expect(children[0]).toBeInstanceOf(WireNode);

        doc.history.undo();
        children = rootChildren(doc);
        expect(children.length).toBe(2);

        doc.selection.setSelectedNodes([n1, n2], false);
        await runConvertToWire(doc);

        children = rootChildren(doc);
        expect(children.length).toBe(1);
        expect(children[0]).toBeInstanceOf(WireNode);
        expect((children[0] as WireNode).shape.isOk).toBe(true);
        expect((children[0] as WireNode).shape.value.shapeType).toBe(ShapeTypes.wire);
    });

    test("convert wire+edge, undo, convert again", async () => {
        const doc = createDocument();
        const n1 = lineNode(doc, "l1", 0, 0, 10, 0);
        const n2 = lineNode(doc, "l2", 10, 0, 10, 10);
        const n3 = lineNode(doc, "l3", 10, 10, 20, 10);
        doc.modelManager.rootNode.add(n1, n2, n3);

        // l1 + l2 -> W12
        doc.selection.setSelectedNodes([n1, n2], false);
        await runConvertToWire(doc);
        let children = rootChildren(doc);
        expect(children.length).toBe(2);
        const w12 = children.find((x) => x instanceof WireNode) as WireNode;
        expect(w12).toBeDefined();

        // W12 + l3 -> W123
        doc.selection.setSelectedNodes([w12, n3], false);
        await runConvertToWire(doc);
        children = rootChildren(doc);
        expect(children.length).toBe(1);
        expect(children[0]).toBeInstanceOf(WireNode);

        // undo -> W12 and l3 restored
        doc.history.undo();
        children = rootChildren(doc);
        expect(children.length).toBe(2);

        // W12 + l3 -> W123 again
        doc.selection.setSelectedNodes([w12, n3], false);
        await runConvertToWire(doc);
        children = rootChildren(doc);
        expect(children.length).toBe(1);
        expect(children[0]).toBeInstanceOf(WireNode);
        const w123 = children[0] as WireNode;
        expect(w123.shape.isOk).toBe(true);
        expect(w123.shape.value.findSubShapes(ShapeTypes.edge).length).toBe(3);
    });
});
