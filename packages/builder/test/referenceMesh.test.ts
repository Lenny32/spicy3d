// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import { type INode, Matrix4, MeshNode, Result, Serializer, Transaction } from "@spicy3d/core";
import { createMockDocument, TestDocument } from "@spicy3d/core/test-utils";
import { DefaultDataExchange } from "../src/defaultDataExchange";
import { parseReferenceStl } from "../src/referenceStl";

const ascii = `solid scan
facet normal 0 0 0
outer loop
vertex 0 0 0
vertex 1 0 0
vertex 0 1 0
endloop
endfacet
endsolid scan`;

function binary(): ArrayBuffer {
    const buffer = new ArrayBuffer(134);
    new Uint8Array(buffer).set(new TextEncoder().encode("solid binary header"));
    const view = new DataView(buffer);
    view.setUint32(80, 1, true);
    view.setFloat32(108, 1, true);
    view.setFloat32(124, 1, true);
    return buffer;
}

describe("reference STL import", () => {
    afterEach(() => {
        rs.unstubAllGlobals();
    });

    test.each([
        "ascii",
        "binary",
    ])("imports %s without a geometry kernel, preserving existing payloads", async (encoding) => {
        rs.stubGlobal("shapeFactory", undefined);
        rs.stubGlobal("shapeConverter", undefined);
        const addNode = rs.fn((_node: INode) => {});
        const document = createMockDocument({ modelManager: { addNode } });
        const content = encoding === "ascii" ? new TextEncoder().encode(ascii).buffer : binary();
        const result = await new DefaultDataExchange().importReferenceMesh(
            document,
            new File([content], "Scan.STL"),
        );
        expect(result.isOk).toBe(true);
        const node = result.value;
        expect(node).toBeInstanceOf(MeshNode);
        expect(node.mesh.meshType).toBe("surface");
        expect(Array.from(node.mesh.position!)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
        expect(Array.from(node.mesh.normal!)).toEqual([0, 0, 1, 0, 0, 1, 0, 0, 1]);
        expect(node.name).toBe("Scan.STL");
        expect(node.visible).toBe(true);
        expect(addNode).toHaveBeenCalledWith(node);
        expect(document.modelManager.materials.at(0)?.opacity).toBe(0.35);
        expect(document.modelManager.materials.at(0)?.id).toBe(node.materialId);
    });

    test("converts file units before applying placement and visibility", async () => {
        const document = createMockDocument();
        const transform = Matrix4.fromTranslation(10, 20, 30);
        const result = await new DefaultDataExchange().importReferenceMesh(
            document,
            new File([ascii], "scan.stl"),
            {
                lengthUnit: "in",
                transform,
                opacity: 0.2,
                visible: false,
            },
        );
        expect(result.isOk).toBe(true);
        expect(result.value.mesh.position![3]).toBeCloseTo(25.4);
        expect(result.value.transform.equals(transform)).toBe(true);
        expect(result.value.visible).toBe(false);
        expect(document.modelManager.materials.at(0)?.opacity).toBe(0.2);
    });

    test("rejects read-only documents and invalid appearance before adding geometry", async () => {
        const addNode = rs.fn((_node: INode) => {});
        const document = createMockDocument({ modelManager: { addNode } });
        const file = new File([ascii], "scan.stl");
        const exchange = new DefaultDataExchange();
        document.repository.isReadOnly = () => true;
        expect((await exchange.importReferenceMesh(document, file)).isOk).toBe(false);
        document.repository.isReadOnly = () => false;
        expect((await exchange.importReferenceMesh(document, file, { opacity: -0.1 })).isOk).toBe(false);
        expect((await exchange.importReferenceMesh(document, new File([ascii], "scan.obj"))).isOk).toBe(
            false,
        );
        expect(addNode).not.toHaveBeenCalled();
        expect(document.modelManager.materials.length).toBe(0);
    });

    test.each([
        ["missing end", ascii.replace("endsolid scan", "")],
        ["missing vertex", ascii.replace("vertex 0 1 0", "")],
        ["non-finite", ascii.replace("vertex 1 0 0", "vertex 1e999 0 0")],
        ["degenerate", ascii.replace("vertex 0 1 0", "vertex 0 0 0")],
        ["empty", "solid scan\nendsolid scan"],
        ["garbage", "not an stl"],
    ])("rejects %s without adding a node or material", async (_name, content) => {
        const addNode = rs.fn((_node: INode) => {});
        const document = createMockDocument({ modelManager: { addNode } });
        const result = await new DefaultDataExchange().importReferenceMesh(
            document,
            new File([content], "scan.stl"),
        );
        expect(result.isOk).toBe(false);
        expect(addNode).not.toHaveBeenCalled();
        expect(document.modelManager.materials.length).toBe(0);
    });

    test("round-trips geometry and ghost material through existing serialization", async () => {
        const document = createMockDocument();
        const result = await new DefaultDataExchange().importReferenceMesh(
            document,
            new File([ascii], "scan.stl"),
            {
                transform: Matrix4.fromTranslation(3, 4, 5),
                visible: false,
            },
        );
        expect(result.isOk).toBe(true);
        const serialized = JSON.parse(JSON.stringify(Serializer.serializeObject(result.value)));
        const restored = Serializer.deserializeObject(document, serialized) as MeshNode;
        expect(restored).toBeInstanceOf(MeshNode);
        expect(restored.mesh.position).toEqual(result.value.mesh.position);
        expect(restored.mesh.normal).toEqual(result.value.mesh.normal);
        expect(restored.transform.equals(result.value.transform)).toBe(true);
        expect(restored.visible).toBe(false);
        expect(restored.materialId).toBe(result.value.materialId);
        const material = document.modelManager.materials.at(0);
        expect(material).not.toBeUndefined();
        const restoredMaterial = Serializer.deserializeObject(
            document,
            JSON.parse(JSON.stringify(Serializer.serializeObject(material!))),
        );
        expect(restoredMaterial.opacity).toBe(0.35);
    });

    test("import transaction undoes and redoes scan and material together", async () => {
        const document = new TestDocument();
        const before = document.modelManager.materials.length;
        let nodeId = "";
        await Transaction.executeAsync(document, "import reference mesh", async () => {
            const result = await new DefaultDataExchange().importReferenceMesh(
                document,
                new File([ascii], "scan.stl"),
            );
            expect(result.isOk).toBe(true);
            nodeId = result.value.id;
        });
        expect(document.modelManager.findNode((node) => node.id === nodeId)).toBeInstanceOf(MeshNode);
        expect(document.modelManager.materials.length).toBe(before + 1);
        await document.history.undo();
        expect(document.modelManager.findNode((node) => node.id === nodeId)).toBeUndefined();
        expect(document.modelManager.materials.length).toBe(before);
        await document.history.redo();
        expect(document.modelManager.findNode((node) => node.id === nodeId)).toBeInstanceOf(MeshNode);
        expect(document.modelManager.materials.length).toBe(before + 1);
        document.dispose();
    });

    test("rejects truncated binary and non-finite binary coordinates", () => {
        expect(parseReferenceStl(binary().slice(0, 133)).isOk).toBe(false);
        const invalid = binary();
        new DataView(invalid).setFloat32(108, Number.NaN, true);
        expect(parseReferenceStl(invalid).isOk).toBe(false);
    });

    test("keeps ordinary STL imports on the BREP converter path", async () => {
        const document = createMockDocument();
        const shapeNode = new MeshNode({
            document,
            name: "imported",
            mesh: parseReferenceStl(binary()).value,
        });
        const convertFromSTL = rs.fn(async (_document: typeof document, _bytes: Uint8Array) =>
            Result.ok(shapeNode),
        );
        rs.stubGlobal("shapeConverter", { convertFromSTL });
        const exchange = new DefaultDataExchange();
        await exchange.import(document, [new File([ascii], "scan.stl")]);
        expect(convertFromSTL).toHaveBeenCalledTimes(1);
        expect(convertFromSTL.mock.calls[0][0]).toBe(document);
        expect(document.modelManager.materials.length).toBe(0);
        expect(exchange.referenceMeshFormats()).toEqual([".stl"]);
    });
});
