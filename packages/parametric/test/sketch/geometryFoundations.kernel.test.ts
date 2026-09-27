// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rs } from "@rstest/core";
import { Plane, ShapeTypes } from "@spicy3d/core";
import { createMockDocument } from "@spicy3d/core/test-utils";
import { initWasm, ShapeFactory } from "@spicy3d/wasm";
import { sketchProfiles } from "../../src/features/profileBuilder";
import { addPolygon } from "../../src/sketch/commands/sketchPolygon";
import { shapeEntityIds } from "../../src/sketch/sketchModel";
import { SketchNode } from "../../src/sketch/sketchNode";
import { SketchSolver } from "../../src/sketch/solver";
import "./setup";

beforeAll(async () => {
    await initWasm({
        wasmBinary: readFileSync(
            path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../wasm/lib/spicy-wasm.wasm"),
        ),
    });
    rs.stubGlobal("shapeFactory", new ShapeFactory());
});
afterAll(() => {
    rs.unstubAllGlobals();
});

test.each([
    true,
    false,
])("polygon profile excludes construction circles and points (inscribed=%s)", (inscribed) => {
    const solver = new SketchSolver(Plane.XY);
    try {
        const polygon = addPolygon(solver, [0, 0], [10, 0], 6, inscribed);
        expect(polygon.isOk).toBe(true);
        solver.addPoint(30, 40);
        const node = new SketchNode({
            document: createMockDocument(),
            plane: Plane.XY,
            data: solver.toData(),
        });
        const shape = node.generateShape();
        expect(shape.isOk).toBe(true);
        expect(shape.value.findSubShapes(ShapeTypes.edge)).toHaveLength(6);
        expect(shapeEntityIds(node.data)).toEqual(polygon.value.edges);
        const profiles = sketchProfiles(node);
        expect(profiles.isOk).toBe(true);
        expect(profiles.value.outer).toHaveLength(1);
        expect(profiles.value.inner).toHaveLength(0);
        expect(profiles.value.outerEntities).toEqual([polygon.value.edges]);
    } finally {
        solver.dispose();
    }
});

test.each([
    [0, 0, 10, 0, 0, 4],
    [3, 7, 9, 15, -1, 10],
    [0, 0, 4, 0, 0, 10],
    [0, 0, 4, 0, 0, 4],
])("exact ellipse %j builds one closed profile", (...params) => {
    const node = new SketchNode({
        document: createMockDocument(),
        plane: Plane.YZ,
        data: { entities: [{ id: 1, type: "ellipse", params }], constraints: [] },
    });
    const shape = node.generateShape();
    expect(shape.isOk).toBe(true);
    const profiles = sketchProfiles(node);
    expect(profiles.isOk).toBe(true);
    expect(profiles.value.outer).toHaveLength(1);
    expect(profiles.value.inner).toHaveLength(0);
    expect(profiles.value.outerEntities).toEqual([[1]]);
});

test("degenerate ellipse is rejected before entering the kernel", () => {
    const node = new SketchNode({
        document: createMockDocument(),
        plane: Plane.XY,
        data: { entities: [{ id: 1, type: "ellipse", params: [0, 0, 5, 0, 0, 0] }], constraints: [] },
    });
    const shape = node.generateShape();
    expect(shape.isOk).toBe(false);
    expect(shape.error).toBe("Ellipse radii are too small");
});
