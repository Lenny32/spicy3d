// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { EditableShapeNode, type INode, type INodeLinkedList, type LengthUnit } from "@spicy3d/core";
import { createMockDocument } from "@spicy3d/core/test-utils";
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

/** Every shape node below `node`, depth first. */
function shapeNodes(node: INode | undefined): EditableShapeNode[] {
    const found: EditableShapeNode[] = [];
    for (let current = node; current !== undefined; current = current.nextSibling) {
        if (current instanceof EditableShapeNode) found.push(current);
        found.push(...shapeNodes((current as INodeLinkedList).firstChild));
    }
    return found;
}

/** The size, in millimetres, of what an importer reads back from `data`. */
function importedSize(data: string, format: "step" | "iges") {
    const bytes = new TextEncoder().encode(data);
    const document = createMockDocument();
    const result =
        format === "step"
            ? converter.convertFromSTEP(document, bytes)
            : converter.convertFromIGES(document, bytes);
    expect(result.isOk).toBe(true);
    const boxes = shapeNodes(result.value.firstChild).map((x) => x.shape.value.boundingBox());
    expect(boxes.length).toBeGreaterThan(0);
    const min = { x: Math.min(...boxes.map((b) => b.min.x)), y: Math.min(...boxes.map((b) => b.min.y)) };
    const max = { x: Math.max(...boxes.map((b) => b.max.x)), y: Math.max(...boxes.map((b) => b.max.y)) };
    return { x: max.x - min.x, y: max.y - min.y };
}

const UNITS: readonly LengthUnit[] = ["mm", "cm", "m", "in"];

describe("STEP export units", () => {
    test.each(UNITS)("a 10 mm box written in %s reads back as 10 mm", (unit) => {
        const box = createBox(factory, 10, 20, 30);
        const step = converter.convertToSTEP([box], { lengthUnit: unit }).value;

        const size = importedSize(step, "step");
        expect(size.x).toBeCloseTo(10, 4);
        expect(size.y).toBeCloseTo(20, 4);
    });

    test("records the unit and scales the coordinates into it", () => {
        const box = createBox(factory, 10, 20, 30);
        const step = converter.convertToSTEP([box], { lengthUnit: "cm" }).value;

        expect(step).toContain(".CENTI.");
        expect(step).toContain(".METRE.");
        // The far corner of a 10 × 20 × 30 mm box, in centimetres.
        expect(step).toMatch(/CARTESIAN_POINT\('[^']*',\(1\.?,2\.?,3\.?\)\)/);
    });

    test("stays in millimetres by default", () => {
        const box = createBox(factory, 10, 20, 30);
        const step = converter.convertToSTEP([box]).value;

        expect(step).toContain(".MILLI.");
        expect(step).toMatch(/CARTESIAN_POINT\('[^']*',\(10\.?,20\.?,30\.?\)\)/);
    });
});

describe("IGES export units", () => {
    test.each(UNITS)("a 10 mm box written in %s reads back as 10 mm", (unit) => {
        const box = createBox(factory, 10, 20, 30);
        const iges = converter.convertToIGES([box], { lengthUnit: unit }).value;

        const size = importedSize(iges, "iges");
        expect(size.x).toBeCloseTo(10, 4);
        expect(size.y).toBeCloseTo(20, 4);
    });

    test("records the unit in the global section", () => {
        const box = createBox(factory, 10, 20, 30);
        const iges = converter.convertToIGES([box], { lengthUnit: "in" }).value;

        // Unit flag 1 (inch) and its name; 30 mm is written as 1.181102.
        expect(iges).toMatch(/,1,4HINCH,/);
        expect(iges).toContain("1.181102");
    });
});
