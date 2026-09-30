// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Plane, XYZ } from "@spicy3d/core";
import { OrthographicCamera } from "three";
import { gridLabels } from "../src/gridLabels";
import { ThreeGrid } from "../src/threeGrid";

function cameraOn(plane: Plane, extent = 200) {
    const camera = new OrthographicCamera(-extent, extent, extent, -extent, 0.1, 2000);
    camera.position.copy(plane.origin.add(plane.normal.multiply(1000)));
    camera.up.copy(plane.yvec);
    camera.lookAt(plane.origin.x, plane.origin.y, plane.origin.z);
    camera.updateMatrixWorld();
    return camera;
}

describe("grid coordinates", () => {
    test.each([
        Plane.XY,
        Plane.YZ,
        Plane.ZX,
        Plane.YZ.translateTo(new XYZ(30, 70, -20)),
    ])("labels signed millimetres relative to the workplane", (plane) => {
        const labels = gridLabels(cameraOn(plane), plane, 800, 800);
        for (const axis of ["x", "y"] as const) {
            const values = labels.filter((label) => label.axis === axis).map((label) => label.text);
            expect(values).toContain("-100");
            expect(values).toContain("-50");
            expect(values).toContain("50");
            expect(values).toContain("100");
        }
        expect(labels.filter((label) => label.text === "0 mm")).toHaveLength(1);
        const x50 = labels.find((label) => label.axis === "x" && label.text === "50");
        expect(x50).toMatchObject({ axis: "x", text: "50" });
        expect(x50?.x).toBeCloseTo(500);
        expect(x50?.y).toBeCloseTo(412);
    });

    test("coarsens in multiples of 50 when zoomed out", () => {
        const labels = gridLabels(cameraOn(Plane.XY, 2000), Plane.XY, 800, 800);
        const values = labels.filter((label) => label.axis === "x").map((label) => label.text);
        expect(values).toContain("-500");
        expect(values).toContain("500");
        expect(values).not.toContain("50");
        expect(labels.length).toBeLessThan(30);
    });

    test("panning preserves coordinates when the origin moves offscreen", () => {
        const camera = cameraOn(Plane.XY);
        camera.position.x = 500;
        camera.lookAt(500, 0, 0);
        const labels = gridLabels(camera, Plane.XY, 800, 800);
        expect(labels.some((label) => label.axis === "y")).toBe(false);
        expect(labels.find((label) => label.text === "500")).toEqual({
            axis: "x",
            text: "500",
            x: 400,
            y: 412,
        });
    });

    test("hides labels when the workplane is edge on", () => {
        expect(gridLabels(cameraOn(Plane.YZ), Plane.XY, 800, 800)).toEqual([]);
    });

    test("grid follows an offset vertical workplane", () => {
        const plane = Plane.YZ.translateTo(new XYZ(30, 70, -20));
        const grid = new ThreeGrid();
        try {
            grid.setWorkplane(plane);
            grid.onBeforeRender(undefined, undefined, cameraOn(plane));
            expect(grid.position.toArray()).toEqual([30, 70, -20]);
            expect(grid.material.uniforms["uOrigin"].value.toArray()).toEqual([30, 70, -20]);
            expect(grid.material.uniforms["uPlaneNormal"].value.toArray()).toEqual([1, 0, 0]);
        } finally {
            grid.dispose();
        }
    });
});
