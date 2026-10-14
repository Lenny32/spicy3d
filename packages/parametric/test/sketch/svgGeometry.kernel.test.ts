// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Plane, parseSvg, XYZ } from "@spicy3d/core";
import { createMockApplication, createMockVisualWithDocument, TestDocument } from "@spicy3d/core/test-utils";
import { initWasm, ShapeFactory } from "@spicy3d/wasm";
import { sketchProfiles } from "../../src/features/profileBuilder";
import { ParametricBodyNode } from "../../src/parametricBodyNode";
import { SketchNode } from "../../src/sketch/sketchNode";
import { svgSketchClipboard } from "../../src/sketch/svgGeometry";
import { transformSketchSelection } from "../../src/sketch/utilityOperations";
import "./setup";

const previousFactory = Object.getOwnPropertyDescriptor(globalThis, "shapeFactory");
beforeAll(async () => {
    await initWasm({
        wasmBinary: readFileSync(resolve(import.meta.dirname, "../../../wasm/lib/spicy-wasm.wasm")),
    });
    Object.defineProperty(globalThis, "shapeFactory", {
        value: new ShapeFactory(),
        writable: true,
        configurable: true,
    });
});
afterAll(() => {
    if (previousFactory) Object.defineProperty(globalThis, "shapeFactory", previousFactory);
    else Reflect.deleteProperty(globalThis, "shapeFactory");
});

/** A 40 × 20 mm frame with a round hole, its right edge bulging out on a cubic. */
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="50mm" height="20mm" viewBox="0 0 50 20">
    <path d="M0 0 H40 C50 5 50 15 40 20 H0 Z"/><circle cx="10" cy="10" r="4"/></svg>`;

test("an imported drawing builds profiles with holes and extrudes off a face plane", () => {
    const drawing = parseSvg(SVG);
    expect(drawing.isOk).toBe(true);
    const clipboard = svgSketchClipboard(drawing.value, { scale: 1, angle: 0 });
    expect(clipboard.isOk).toBe(true);
    const pasted = transformSketchSelection(
        { entities: [], constraints: [] },
        [],
        { kind: "move", delta: [5, 5] },
        clipboard.value,
    );
    expect(pasted.isOk).toBe(true);

    const doc = new TestDocument({ application: createMockApplication() });
    doc.visual = createMockVisualWithDocument(doc);
    const face = new Plane({ origin: new XYZ({ x: 0, y: 0, z: 30 }), normal: XYZ.unitZ, xvec: XYZ.unitX });
    const sketch = new SketchNode({ document: doc, plane: face, data: pasted.value.data });
    doc.modelManager.addNode(sketch);
    const profiles = sketchProfiles(sketch);
    expect(profiles.isOk).toBe(true);
    expect(profiles.value.outer).toHaveLength(1);
    const area = profiles.value.outer[0].area();
    // the 40 × 20 frame, plus the bulge (∫ 30t(1−t) · y′(t) dt = 105 mm²), less the hole (a circle
    // the parser approximates with four cubics, 0.014 mm² larger)
    expect(area).toBeCloseTo(800 + 105 - Math.PI * 16, 1);

    const body = new ParametricBodyNode({
        document: doc,
        features: [{ id: "f1", type: "extrude", sketchId: sketch.id, depth: 5 }],
    });
    doc.modelManager.addNode(body);
    expect(body.shape.isOk).toBe(true);
    expect(body.shape.value.volume()).toBeCloseTo(area * 5, 3);
    const box = body.shape.value.boundingBox();
    expect(box.min.z).toBeCloseTo(30, 6);
    expect(box.max.z).toBeCloseTo(35, 6);
});
