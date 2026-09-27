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
import { sourceEntityIds } from "../../src/features/profileEntities";
import { shapeEntityIds } from "../../src/sketch/sketchModel";
import { SketchNode } from "../../src/sketch/sketchNode";
import { splineParams } from "../../src/sketch/splineGeometry";

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

test.each([Plane.XY, Plane.YZ])("spline profiles preserve entity identity on %j", (plane) => {
    const params = splineParams([
        [0, 0],
        [5, 5],
        [10, 0],
    ]);
    expect(params.isOk).toBe(true);
    const node = new SketchNode({
        document: createMockDocument(),
        plane,
        data: {
            entities: [
                { id: 1, type: "spline", params: params.value },
                { id: 2, type: "line", params: [10, 0, 0, 0] },
            ],
            constraints: [],
        },
    });
    const shape = node.generateShape();
    expect(shape.isOk).toBe(true);
    expect(shape.value.findSubShapes(ShapeTypes.edge)).toHaveLength(3);
    expect(shapeEntityIds(node.data)).toEqual([1, 1, 2]);
    expect(sourceEntityIds([0, 1, 2], shapeEntityIds(node.data), node)).toEqual([1, 2]);
    expect(shape.value.edgesMeshPosition().position.length).toBeGreaterThan(18);
    const profiles = sketchProfiles(node);
    expect(profiles.isOk).toBe(true);
    expect(profiles.value.outer).toHaveLength(1);
    expect(profiles.value.outerEntities).toEqual([[1, 2]]);
});
