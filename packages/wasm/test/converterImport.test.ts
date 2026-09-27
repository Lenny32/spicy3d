// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { EditableShapeNode, type INodeLinkedList, ShapeTypes, XYZ } from "@spicy3d/core";
import { createMockDocument, MockShape } from "@spicy3d/core/test-utils";
import type { OccShapeConverter } from "../src/converter";
import type { ShapeFactory } from "../src/factory";
import { createBox, createTestConverter, createTestFactory } from "./helpers";
import "./setup";

let factory: ShapeFactory;
let converter: OccShapeConverter;

beforeEach(() => {
    factory = createTestFactory();
    converter = createTestConverter();
});

describe("STEP import", () => {
    test("should convert box to STEP and import back as a solid node", () => {
        const box = createBox(factory, 10, 20, 30);
        const stepStr = converter.convertToSTEP([box]).value;
        expect(stepStr).toContain("ISO-10303-21");

        const stepBytes = new TextEncoder().encode(stepStr);
        const doc = createMockDocument();
        const result = converter.convertFromSTEP(doc, stepBytes);
        expect(result.isOk).toBe(true);
        const folder = result.value;
        const node = folder.firstChild;
        expect(node).toBeInstanceOf(EditableShapeNode);
        const shape = (node as EditableShapeNode).shape;
        expect(shape.isOk).toBe(true);
        expect(shape.value.shapeType).toBe(ShapeTypes.solid);
    });

    test("should return error for invalid STEP data", () => {
        const invalidData = new TextEncoder().encode("not a valid step file");
        const doc = createMockDocument();
        const result = converter.convertFromSTEP(doc, invalidData);
        expect(result.isOk).toBe(false);
    });

    test("should import STEP containing a comment longer than the OCCT lexer buffer", () => {
        const box = createBox(factory, 10, 20, 30);
        const stepStr = converter.convertToSTEP([box]).value;
        // OCCT's STEP lexer cannot match tokens longer than its 16KB input buffer,
        // so a long comment line must be stripped before reading
        const longComment = `/*${"x".repeat(32 * 1024)}*/`;
        const stepWithComment = stepStr.replace("ISO-10303-21;", `ISO-10303-21;\n${longComment}`);

        const stepBytes = new TextEncoder().encode(stepWithComment);
        const doc = createMockDocument();
        const result = converter.convertFromSTEP(doc, stepBytes);
        expect(result.isOk).toBe(true);
        const node = result.value.firstChild;
        expect(node).toBeInstanceOf(EditableShapeNode);
    });

    test("should handle cylinder STEP import", () => {
        const cyl = factory.cylinder(XYZ.unitZ, XYZ.zero, 5, 20).value;
        const stepStr = converter.convertToSTEP([cyl]).value;

        const stepBytes = new TextEncoder().encode(stepStr);
        const doc = createMockDocument();
        const result = converter.convertFromSTEP(doc, stepBytes);
        expect(result.isOk).toBe(true);
        const node = result.value.firstChild;
        expect(node).toBeInstanceOf(EditableShapeNode);
        const shape = (node as EditableShapeNode).shape;
        expect(shape.isOk).toBe(true);
        expect(shape.value.shapeType).toBe(ShapeTypes.solid);
    });
});

describe("IGES import", () => {
    test("should convert box to IGES and import back as face nodes", () => {
        const box = createBox(factory, 10, 20, 30);
        const igesStr = converter.convertToIGES([box]).value;
        expect(igesStr.length).toBeGreaterThan(0);

        const igesBytes = new TextEncoder().encode(igesStr);
        const doc = createMockDocument();
        const result = converter.convertFromIGES(doc, igesBytes);
        expect(result.isOk).toBe(true);
        const folder = result.value;
        // IGES stores each face as its own entity, grouped under a compound node
        const group = folder.firstChild;
        expect(group).toBeDefined();
        const faceNode = (group as INodeLinkedList).firstChild;
        expect(faceNode).toBeInstanceOf(EditableShapeNode);
        const shape = (faceNode as EditableShapeNode).shape;
        expect(shape.isOk).toBe(true);
        expect(shape.value.shapeType).toBe(ShapeTypes.face);
    });

    test("should return error for invalid IGES data", () => {
        const invalidData = new TextEncoder().encode("invalid iges");
        const doc = createMockDocument();
        const result = converter.convertFromIGES(doc, invalidData);
        expect(result.isOk).toBe(false);
    });
});

describe("STL import", () => {
    test("should convert box to STL and import back as a shape node", () => {
        const box = createBox(factory, 10, 20, 30);
        const stlResult = converter.convertToSTL([box], { binary: true });
        expect(stlResult.isOk).toBe(true);

        const doc = createMockDocument();
        const importResult = converter.convertFromSTL(doc, stlResult.value);
        expect(importResult.isOk).toBe(true);
        const node = importResult.value.firstChild;
        expect(node).toBeInstanceOf(EditableShapeNode);
        const shape = (node as EditableShapeNode).shape;
        expect(shape.isOk).toBe(true);
        expect(shape.value.shapeType).toBe(ShapeTypes.compound);
    });

    test("should return error for invalid STL data", () => {
        const invalidData = new Uint8Array([0, 0, 0, 0]);
        const doc = createMockDocument();
        const result = converter.convertFromSTL(doc, invalidData);
        expect(result.isOk).toBe(false);
    });
});

describe("STL conversion edge cases", () => {
    test("multiple boxes to STL", () => {
        const box1 = createBox(factory, 10, 10, 10);
        const box2 = createBox(factory, 10, 20, 30);
        const result = converter.convertToSTL([box1, box2], { binary: true });
        expect(result.isOk).toBe(true);
        expect(result.value.length).toBeGreaterThan(84);
    });

    test("STL conversion returns error when a shape cannot provide mesh data", () => {
        const fakeShape = new MockShape({ shapeType: ShapeTypes.solid });
        // Simulate a shape whose tessellation is unavailable
        Object.defineProperty(fakeShape, "mesh", {
            get: () => {
                throw new Error("mesh unavailable");
            },
        });
        const result = converter.convertToSTL([fakeShape], { binary: true });
        expect(result.isOk).toBe(false);
    });
});
