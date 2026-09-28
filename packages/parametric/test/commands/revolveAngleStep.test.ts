// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import { AsyncController, Line, PubSub, Ray, type ShapeMeshData, XY, XYZ } from "@spicy3d/core";
import {
    createHandlerMockView,
    createMockVisualWithDocument,
    createPointerEvent,
    TestDocument,
} from "@spicy3d/core/test-utils";
import {
    MAX_REVOLVE_ANGLE,
    type RevolveAngleData,
    RevolveAngleHandler,
    revolveAngleAt,
    revolveHandleCircle,
    revolveHandlePose,
} from "../../src/commands/revolveAngleStep";

const Z_AXIS = new Line({ point: XYZ.zero, direction: XYZ.unitZ });
const ANCHOR = new XYZ({ x: 10, y: 0, z: 5 });

function circle() {
    const result = revolveHandleCircle(Z_AXIS, ANCHOR);
    expect(result).not.toBeUndefined();
    return result!;
}

const expectPoint = (actual: XYZ, x: number, y: number, z: number) => {
    expect(actual.x).toBeCloseTo(x);
    expect(actual.y).toBeCloseTo(y);
    expect(actual.z).toBeCloseTo(z);
};

describe("revolve handle geometry", () => {
    test("the circle is centred on the axis at the anchor's height", () => {
        const { center, radial, radius } = circle();
        expectPoint(center, 0, 0, 5);
        expectPoint(radial, 1, 0, 0);
        expect(radius).toBeCloseTo(10);
    });

    test("an anchor on the axis has no circle", () => {
        expect(revolveHandleCircle(Z_AXIS, new XYZ({ x: 0, y: 0, z: 3 }))).toBeUndefined();
    });

    test.each([
        [0, 10, 0, 0, 1],
        [90, 0, 10, -1, 0],
        [180, -10, 0, 0, -1],
    ])("at %d° the handle sits on the circle and points the way the angle grows", (deg, x, y, dx, dy) => {
        const { point, direction } = revolveHandlePose(circle(), deg);
        expectPoint(point, x, y, 5);
        expectPoint(direction, dx, dy, 0);
    });

    test("a negative angle points the handle back the other way", () => {
        const { direction } = revolveHandlePose(circle(), -90);
        expectPoint(direction, -1, 0, 0);
    });

    test("the angle of a point keeps turning past 180° instead of jumping", () => {
        const at = (deg: number, previous: number) => {
            const rad = (deg * Math.PI) / 180;
            return revolveAngleAt(
                circle(),
                new XYZ({ x: Math.cos(rad) * 7, y: Math.sin(rad) * 7, z: 5 }),
                previous,
            );
        };
        expect(at(90, 0)).toBeCloseTo(90);
        expect(at(-170, 170)).toBeCloseTo(190);
        expect(at(10, 350)).toBeCloseTo(360);
        expect(at(-10, -350)).toBeCloseTo(-MAX_REVOLVE_ANGLE);
    });
});

describe("RevolveAngleHandler", () => {
    const fakeMesh = (): ShapeMeshData => ({ position: new Float32Array(), range: [] });
    // The arrow is meshed through the kernel; a solid's face mesh is all it reads.
    const meshedSolid = () => ({ isOk: true, value: { mesh: { faces: fakeMesh() }, dispose: () => {} } });

    beforeEach(() => {
        rs.stubGlobal("shapeFactory", { cylinder: meshedSolid, cone: meshedSolid });
    });

    afterEach(() => {
        rs.unstubAllGlobals();
    });

    function setup(angle = 90) {
        const doc = new TestDocument();
        doc.visual = createMockVisualWithDocument(doc);
        const controller = new AsyncController();
        const data: RevolveAngleData = {
            axis: Z_AXIS,
            anchor: ANCHOR,
            angle,
            buildPreview: rs.fn((_angle: number, _dragging: boolean) => ({ meshes: [fakeMesh()] })),
            onAngle: rs.fn((_angle: number) => {}),
        };
        return { doc, controller, data };
    }

    test("dragging the arrow around the axis reports whole degrees and previews each step", () => {
        const { doc, controller, data } = setup(90);
        const pub = rs.spyOn(PubSub.default, "pub").mockImplementation(() => {});
        try {
            const handler = new RevolveAngleHandler(doc, controller, data);
            // Screen = world x/y; rays look straight down onto the handle circle's plane.
            const view = createHandlerMockView({
                document: doc,
                worldToScreen: (p: XYZ) => new XY({ x: p.x, y: p.y }),
                rayAt: (mx: number, my: number) =>
                    new Ray({ point: new XYZ({ x: mx, y: my, z: 50 }), direction: XYZ.unitZ.reverse() }),
            });
            // The arrow sits at 90° — (0, 10) — pointing towards -x.
            handler.pointerDown(view, createPointerEvent({ offsetX: -1, offsetY: 10 }));
            handler.pointerMove(view, createPointerEvent({ offsetX: -7.07, offsetY: 7.07 }));

            expect(handler.angle).toBe(135);
            expect(data.onAngle).toHaveBeenLastCalledWith(135);
            expect(data.buildPreview).toHaveBeenLastCalledWith(135, true);

            handler.pointerUp(view, createPointerEvent({ offsetX: -7.07, offsetY: 7.07 }));
            handler.keyDown(view, new KeyboardEvent("keydown", { key: "Enter" }));
            expect(controller.result?.status).toBe("success");
        } finally {
            pub.mockRestore();
            controller.dispose();
        }
    });

    test("a zero angle cannot be confirmed", () => {
        const { doc, controller, data } = setup(0);
        const pub = rs.spyOn(PubSub.default, "pub").mockImplementation(() => {});
        try {
            const handler = new RevolveAngleHandler(doc, controller, data);
            handler.keyDown(
                createHandlerMockView({ document: doc }),
                new KeyboardEvent("keydown", { key: "Enter" }),
            );
            expect(controller.result).toBeUndefined();
            // Nothing to preview at zero.
            expect(data.buildPreview).not.toHaveBeenCalled();
        } finally {
            pub.mockRestore();
            controller.dispose();
        }
    });
});
