// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import { Plane, XYZ } from "@spicy3d/core";
import { type CanvasTexture, OrthographicCamera, PerspectiveCamera, type Sprite } from "three";
import { gridLabels } from "../src/gridLabels";
import { ThreeGrid } from "../src/threeGrid";
import { ThreeGridLabels } from "../src/threeGridLabels";

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
        expect(labels.some((label) => label.text === "0 mm" || label.text === "0")).toBe(false);
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
        expect(labels.find((label) => label.text === "500")).toMatchObject({
            axis: "x",
            text: "500",
            x: 400,
            y: 412,
        });
    });

    test("hides labels when the workplane is edge on", () => {
        expect(gridLabels(cameraOn(Plane.YZ), Plane.XY, 800, 800)).toEqual([]);
    });

    test.each([-1, 1])("thins perspective labels while continuing along the axis (%s)", (sign) => {
        const camera = new PerspectiveCamera(60, 1, 0.1, 2000);
        camera.position.set(0, -200 * sign, 200);
        camera.lookAt(0, 0, 0);
        const labels = gridLabels(camera, Plane.XY, 1200, 1200);
        const receding = labels.filter((label) => label.axis === "y" && Number(label.text) * sign > 0);
        const values = receding.map((label) => Number(label.text) * sign);
        expect(values).toContain(50);
        expect(Math.max(...values)).toBeGreaterThanOrEqual(300);
        expect(receding.length).toBeLessThan(Math.max(...values) / 50);
        expect(receding.length).toBeGreaterThan(1);
        for (let index = 1; index < receding.length; index++) {
            const previous = receding[index - 1];
            const current = receding[index];
            expect(Math.hypot(current.x - previous.x, current.y - previous.y)).toBeGreaterThanOrEqual(65);
        }
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

describe("rendered grid labels", () => {
    beforeEach(() => {
        rs.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
            measureText: (text: string) => ({ width: text.length * 12 }),
            fillText: rs.fn(),
        } as unknown as CanvasRenderingContext2D);
    });

    afterEach(() => {
        rs.restoreAllMocks();
    });

    test.each(["orthographic", "perspective"])("keeps text screen sized with a %s camera", (type) => {
        const camera = type === "orthographic" ? cameraOn(Plane.XY) : new PerspectiveCamera(45, 1, 0.1, 2000);
        camera.position.set(0, 0, 1000);
        camera.lookAt(0, 0, 0);
        const group = new ThreeGridLabels();
        try {
            group.update(camera, Plane.XY, 800, 800, "#333333");
            expect(group.children.length).toBeGreaterThan(0);
            for (const child of group.children) {
                const sprite = child as Sprite;
                const projected = sprite.position.clone().project(camera);
                const right = sprite.position.clone();
                right.x += sprite.scale.x;
                right.project(camera);
                const texture = sprite.material.map as CanvasTexture;
                expect((right.x - projected.x) * 400).toBeCloseTo(texture.image.width / 2);
                expect(sprite.material.depthTest).toBe(true);
                expect(sprite.material.depthWrite).toBe(false);
                expect(sprite.renderOrder).toBe(-1);
            }
        } finally {
            group.dispose();
        }
    });

    test("reuses textures and releases them when the workplane goes edge on", () => {
        const group = new ThreeGridLabels();
        try {
            const camera = cameraOn(Plane.XY);
            group.update(camera, Plane.XY, 800, 800, "#333333");
            expect(group.children.length).toBeGreaterThan(0);
            const texture = (group.children[0] as Sprite).material.map as CanvasTexture;
            const dispose = rs.spyOn(texture, "dispose");
            group.update(camera, Plane.XY, 800, 800, "#333333");
            expect((group.children[0] as Sprite).material.map).toBe(texture);
            group.update(camera, Plane.YZ, 800, 800, "#333333");
            expect(group.children).toHaveLength(0);
            expect(dispose).toHaveBeenCalledOnce();
        } finally {
            group.dispose();
        }
    });
});
