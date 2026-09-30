// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Matrix4 } from "@spicy3d/core";
import { createMockApplication, MockShape, TestDocument } from "@spicy3d/core/test-utils";
import { previewMeshes } from "../src/commands/featureEditPreview";
import { ParametricBodyNode } from "../src/parametricBodyNode";

function host() {
    const document = new TestDocument({ application: createMockApplication() });
    return new ParametricBodyNode({ document, features: [] });
}
afterEach(() => {
    rs.restoreAllMocks();
});

test("a failed world transformation disposes the owned preview input", () => {
    const body = host();
    const shape = new MockShape();
    const dispose = rs.spyOn(shape, "dispose");
    rs.spyOn(body, "worldTransform").mockReturnValue(Matrix4.fromTranslation(3, 0, 0));
    const transform = rs.spyOn(shape, "transformedMul").mockImplementation(() => {
        throw new Error("Preview transform failed");
    });
    expect(() => previewMeshes(body, shape)).toThrow("Preview transform failed");
    expect(transform).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
});

test("a failed host placement lookup still disposes its owned preview", () => {
    const body = host();
    const shape = new MockShape();
    const dispose = rs.spyOn(shape, "dispose");
    rs.spyOn(body, "worldTransform").mockImplementation(() => {
        throw new Error("Placement unavailable");
    });
    expect(() => previewMeshes(body, shape)).toThrow("Placement unavailable");
    expect(dispose).toHaveBeenCalledTimes(1);
});

test("a transformed preview mesh failure disposes both distinct shapes", () => {
    const body = host();
    const shape = new MockShape();
    const world = new MockShape();
    const disposeInput = rs.spyOn(shape, "dispose");
    const disposeWorld = rs.spyOn(world, "dispose");
    rs.spyOn(body, "worldTransform").mockReturnValue(Matrix4.fromTranslation(1, 0, 0));
    rs.spyOn(shape, "transformedMul").mockReturnValue(world);
    rs.spyOn(world, "mesh", "get").mockImplementation(() => {
        throw new Error("Meshing failed");
    });
    expect(() => previewMeshes(body, shape)).toThrow("Meshing failed");
    expect(disposeInput).toHaveBeenCalledTimes(1);
    expect(disposeWorld).toHaveBeenCalledTimes(1);
});

test("identity placement returns the original mesh buffers and disposes once", () => {
    const body = host();
    const shape = new MockShape();
    const mesh = shape.mesh;
    const dispose = rs.spyOn(shape, "dispose");
    const transform = rs.spyOn(shape, "transformedMul");
    rs.spyOn(body, "worldTransform").mockReturnValue(Matrix4.identity());
    expect(previewMeshes(body, shape)).toEqual([mesh.faces, mesh.edges]);
    expect(transform).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledTimes(1);
});
