// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { ICameraController } from "@spicy3d/core";
import { Config, type Navigation3DType } from "@spicy3d/core";
import { createHandlerMockView, createPointerEvent } from "@spicy3d/core/test-utils";
import { ThreeViewHandler } from "../src/threeViewEventHandler";

/**
 * Core test-utils has no camera controller mock; the view comes from
 * createHandlerMockView and only its cameraController is overridden here.
 */
function createMockCameraController(): ICameraController {
    return {
        zoom(_x: number, _y: number, _delta: number) {},
        pan(_dx: number, _dy: number) {},
        rotate(_dx: number, _dy: number) {},
        startRotate(_x: number, _y: number) {},
        fitContent() {},
        lookAt(_eye: any, _target: any, _up: any) {},
        get cameraType() {
            return "perspective";
        },
        get target() {
            return { x: 0, y: 0, z: 0 };
        },
        get cameraPosition() {
            return { x: 0, y: 0, z: 1000 };
        },
        get cameraTarget() {
            return { x: 0, y: 0, z: 0 };
        },
        get cameraUp() {
            return { x: 0, y: 0, z: 1 };
        },
    } as unknown as ICameraController;
}

// helper to access protected members
function mapsOf(h: ThreeViewHandler) {
    return h as any as {
        lastPointerEventMap: Map<number, PointerEvent>;
        currentPointerEventMap: Map<number, PointerEvent>;
    };
}

function offsetPointOf(h: ThreeViewHandler): { x: number; y: number } | undefined {
    return (h as any)._offsetPoint;
}

// ============================================================================
// ThreeViewHandler — lifecycle
// ============================================================================

describe("ThreeViewHandler — lifecycle", () => {
    test("creates handler with defaults", () => {
        const handler = new ThreeViewHandler();
        expect(handler.canRotate).toBe(true);
        expect(handler.isEnabled).toBe(true);
    });

    test("dispose clears internal pointer state", () => {
        const handler = new ThreeViewHandler();
        const view = createHandlerMockView();

        handler.pointerDown(view, createPointerEvent({ pointerType: "touch", pointerId: 1 }));
        expect(mapsOf(handler).lastPointerEventMap.size).toBe(1);

        handler.dispose();
        expect(mapsOf(handler).lastPointerEventMap.size).toBe(0);
        expect(mapsOf(handler).currentPointerEventMap.size).toBe(0);
    });

    test("canRotate flag can be toggled", () => {
        const handler = new ThreeViewHandler();
        handler.canRotate = false;
        expect(handler.canRotate).toBe(false);
        handler.canRotate = true;
        expect(handler.canRotate).toBe(true);
    });

    test("isEnabled flag can be toggled", () => {
        const handler = new ThreeViewHandler();
        handler.isEnabled = false;
        expect(handler.isEnabled).toBe(false);
    });
});

// ============================================================================
// ThreeViewHandler — mouseWheel
// ============================================================================

describe("ThreeViewHandler — mouseWheel", () => {
    test("mouseWheel triggers zoom with the raw deltaY by default", () => {
        const handler = new ThreeViewHandler();
        let receivedDelta: number | undefined;
        const cc = createMockCameraController();
        cc.zoom = (_x, _y, delta) => {
            receivedDelta = delta;
        };
        const view = createHandlerMockView({ cameraController: cc });

        handler.mouseWheel(view, new WheelEvent("wheel", { deltaY: 120 }));
        expect(receivedDelta).toBe(120);
    });

    test.each([
        "Solidworks",
        "Creo",
    ] as Navigation3DType[])("mouseWheel with %s navigation inverts deltaY sign", (navigation) => {
        const handler = new ThreeViewHandler();
        let receivedDelta: number | undefined;
        const cc = createMockCameraController();
        cc.zoom = (_x, _y, delta) => {
            receivedDelta = delta;
        };
        const view = createHandlerMockView({ cameraController: cc });

        const origNav = Config.instance.navigation3D;
        (Config.instance as any)._navigation3D = navigation;

        try {
            handler.mouseWheel(view, new WheelEvent("wheel", { deltaY: 120 }));
        } finally {
            (Config.instance as any)._navigation3D = origNav;
        }
        expect(receivedDelta).toBe(-120);
    });
});

// ============================================================================
// ThreeViewHandler — pointerMove (mouse)
// ============================================================================

describe("ThreeViewHandler — pointerMove (mouse)", () => {
    test("pointerMove with no buttons pressed triggers no navigation", () => {
        const handler = new ThreeViewHandler();
        let gestureCalled = false;
        const cc = createMockCameraController();
        cc.pan = () => {
            gestureCalled = true;
        };
        cc.rotate = () => {
            gestureCalled = true;
        };
        cc.zoom = () => {
            gestureCalled = true;
        };
        const view = createHandlerMockView({ cameraController: cc });

        handler.pointerMove(view, createPointerEvent({ pointerType: "mouse", buttons: 0 }));
        expect(gestureCalled).toBe(false);
    });

    test("pointerMove with middle button but no prior pointerDown pans with zero delta", () => {
        const handler = new ThreeViewHandler();
        const panArgs: number[][] = [];
        let rotateCalled = false;
        const cc = createMockCameraController();
        cc.pan = (dx, dy) => {
            panArgs.push([dx, dy]);
        };
        cc.rotate = () => {
            rotateCalled = true;
        };
        const view = createHandlerMockView({ cameraController: cc });

        handler.pointerMove(
            view,
            createPointerEvent({ pointerType: "mouse", buttons: 4, offsetX: 10, offsetY: 10 }),
        );
        expect(panArgs).toEqual([[0, 0]]);
        expect(rotateCalled).toBe(false);
    });

    test("middle-button drag pans with the movement delta (default navigation)", () => {
        const handler = new ThreeViewHandler();
        const panArgs: number[][] = [];
        let rotateCalled = false;
        const cc = createMockCameraController();
        cc.pan = (dx, dy) => {
            panArgs.push([dx, dy]);
        };
        cc.rotate = () => {
            rotateCalled = true;
        };
        const view = createHandlerMockView({ cameraController: cc });

        handler.pointerDown(
            view,
            createPointerEvent({ pointerType: "mouse", buttons: 4, offsetX: 100, offsetY: 200 }),
        );
        handler.pointerMove(
            view,
            createPointerEvent({ pointerType: "mouse", buttons: 4, offsetX: 110, offsetY: 210 }),
        );
        expect(panArgs).toEqual([[10, 10]]);
        expect(rotateCalled).toBe(false);

        // The offset point advances, so the next delta is relative to the previous event
        handler.pointerMove(
            view,
            createPointerEvent({ pointerType: "mouse", buttons: 4, offsetX: 115, offsetY: 215 }),
        );
        expect(panArgs).toEqual([
            [10, 10],
            [5, 5],
        ]);
    });

    test("shift + middle-button drag rotates instead of panning (default navigation)", () => {
        const handler = new ThreeViewHandler();
        const rotateArgs: number[][] = [];
        let panCalled = false;
        const cc = createMockCameraController();
        cc.pan = () => {
            panCalled = true;
        };
        cc.rotate = (dx, dy) => {
            rotateArgs.push([dx, dy]);
        };
        const view = createHandlerMockView({ cameraController: cc });

        handler.pointerDown(
            view,
            createPointerEvent({ pointerType: "mouse", buttons: 4, offsetX: 100, offsetY: 200 }),
        );
        handler.pointerMove(
            view,
            createPointerEvent({
                pointerType: "mouse",
                buttons: 4,
                shiftKey: true,
                offsetX: 110,
                offsetY: 210,
            }),
        );
        expect(rotateArgs).toEqual([[10, 10]]);
        expect(panCalled).toBe(false);
    });

    test("shift + middle-button drag does not rotate when canRotate is false", () => {
        const handler = new ThreeViewHandler();
        handler.canRotate = false;
        let gestureCalled = false;
        const cc = createMockCameraController();
        cc.pan = () => {
            gestureCalled = true;
        };
        cc.rotate = () => {
            gestureCalled = true;
        };
        const view = createHandlerMockView({ cameraController: cc });

        handler.pointerDown(
            view,
            createPointerEvent({ pointerType: "mouse", buttons: 4, offsetX: 100, offsetY: 200 }),
        );
        handler.pointerMove(
            view,
            createPointerEvent({
                pointerType: "mouse",
                buttons: 4,
                shiftKey: true,
                offsetX: 110,
                offsetY: 210,
            }),
        );
        expect(gestureCalled).toBe(false);
    });
});

// ============================================================================
// ThreeViewHandler — pointerDown
// ============================================================================

describe("ThreeViewHandler — pointerDown", () => {
    test("pointerDown with touch type adds to pointer event map", () => {
        const handler = new ThreeViewHandler();
        const view = createHandlerMockView();

        handler.pointerDown(view, createPointerEvent({ pointerType: "touch", pointerId: 1 }));

        expect(mapsOf(handler).lastPointerEventMap.size).toBe(1);
    });

    test("pointerDown with mouse middle button starts rotate at the event offset", () => {
        const handler = new ThreeViewHandler();
        const startRotateArgs: number[][] = [];
        const cc = createMockCameraController();
        cc.startRotate = (x, y) => {
            startRotateArgs.push([x, y]);
        };
        const view = createHandlerMockView({ cameraController: cc });

        handler.pointerDown(
            view,
            createPointerEvent({ pointerType: "mouse", buttons: 4, offsetX: 100, offsetY: 200 }),
        );

        expect(startRotateArgs).toEqual([[100, 200]]);
        expect(offsetPointOf(handler)).toEqual({ x: 100, y: 200 });
    });

    test("double-click middle button triggers fitContent", () => {
        const handler = new ThreeViewHandler();
        let fitContentCalled = false;
        const cc = createMockCameraController();
        cc.fitContent = () => {
            fitContentCalled = true;
        };
        const view = createHandlerMockView({ cameraController: cc });

        handler.pointerDown(
            view,
            createPointerEvent({ pointerType: "mouse", buttons: 4, offsetX: 100, offsetY: 200 }),
        );
        handler.pointerDown(
            view,
            createPointerEvent({ pointerType: "mouse", buttons: 4, offsetX: 100, offsetY: 200 }),
        );

        expect(fitContentCalled).toBe(true);
    });
});

// ============================================================================
// ThreeViewHandler — pointerUp / pointerOut
// ============================================================================

describe("ThreeViewHandler — pointerUp / pointerOut", () => {
    test("pointerUp clears last pointer events", () => {
        const handler = new ThreeViewHandler();
        const view = createHandlerMockView();

        handler.pointerDown(view, createPointerEvent({ pointerType: "touch", pointerId: 1 }));
        expect(mapsOf(handler).lastPointerEventMap.size).toBe(1);

        handler.pointerUp(view, createPointerEvent({ pointerType: "touch", pointerId: 1 }));

        expect(mapsOf(handler).lastPointerEventMap.has(1)).toBe(false);
    });

    test("pointerOut clears pointer data", () => {
        const handler = new ThreeViewHandler();
        const view = createHandlerMockView();

        handler.pointerDown(view, createPointerEvent({ pointerType: "touch", pointerId: 1 }));

        handler.pointerOut(view, createPointerEvent({ pointerType: "touch", pointerId: 1 }));

        expect(mapsOf(handler).lastPointerEventMap.has(1)).toBe(false);
        expect(mapsOf(handler).currentPointerEventMap.has(1)).toBe(false);
    });

    test("pointerUp with middle button clears the pan offset point", () => {
        const handler = new ThreeViewHandler();
        const view = createHandlerMockView({ cameraController: createMockCameraController() });

        handler.pointerDown(
            view,
            createPointerEvent({ pointerType: "mouse", buttons: 4, offsetX: 100, offsetY: 200 }),
        );
        expect(offsetPointOf(handler)).toEqual({ x: 100, y: 200 });

        handler.pointerUp(
            view,
            createPointerEvent({ pointerType: "mouse", buttons: 4, offsetX: 100, offsetY: 200 }),
        );
        expect(offsetPointOf(handler)).toBeUndefined();

        handler.dispose();
    });
});

// ============================================================================
// ThreeViewHandler — touch handling
// ============================================================================

describe("ThreeViewHandler — touch handling", () => {
    test("pointerMove with new touch registers in currentPointerEventMap", () => {
        const handler = new ThreeViewHandler();
        const view = createHandlerMockView();

        handler.pointerDown(
            view,
            createPointerEvent({ pointerType: "touch", pointerId: 1, offsetX: 0, offsetY: 0 }),
        );
        handler.pointerDown(
            view,
            createPointerEvent({ pointerType: "touch", pointerId: 2, offsetX: 10, offsetY: 10 }),
        );

        handler.pointerMove(
            view,
            createPointerEvent({ pointerType: "touch", pointerId: 1, offsetX: 5, offsetY: 5 }),
        );

        expect(mapsOf(handler).currentPointerEventMap.size).toBe(1);
        expect(mapsOf(handler).currentPointerEventMap.has(1)).toBe(true);
    });

    test("keyDown triggers no navigation", () => {
        const handler = new ThreeViewHandler();
        let gestureCalled = false;
        const cc = createMockCameraController();
        cc.pan = () => {
            gestureCalled = true;
        };
        cc.rotate = () => {
            gestureCalled = true;
        };
        cc.zoom = () => {
            gestureCalled = true;
        };
        const view = createHandlerMockView({ cameraController: cc });

        handler.keyDown(view, new KeyboardEvent("keydown", { key: "a" }));
        expect(gestureCalled).toBe(false);
    });
});

// ============================================================================
// ThreeViewHandler — touch multi-finger gestures
// ============================================================================

describe("ThreeViewHandler — touch multi-finger gestures", () => {
    test("first pointerMove for a new touch registers in currentPointerEventMap", () => {
        const handler = new ThreeViewHandler();
        const view = createHandlerMockView();

        handler.pointerDown(
            view,
            createPointerEvent({ pointerType: "touch", pointerId: 1, offsetX: 0, offsetY: 0 }),
        );
        expect(mapsOf(handler).currentPointerEventMap.size).toBe(0);

        handler.pointerMove(
            view,
            createPointerEvent({ pointerType: "touch", pointerId: 1, offsetX: 5, offsetY: 5 }),
        );
        expect(mapsOf(handler).currentPointerEventMap.size).toBe(1);
    });

    test("two-finger move with dominating center shift pans, never zooms", () => {
        const handler = new ThreeViewHandler();
        const panArgs: number[][] = [];
        let zoomCalled = false;
        const cc = createMockCameraController();
        cc.zoom = () => {
            zoomCalled = true;
        };
        cc.pan = (dx, dy) => {
            panArgs.push([dx, dy]);
        };
        const view = createHandlerMockView({ cameraController: cc });

        handler.pointerDown(
            view,
            createPointerEvent({ pointerType: "touch", pointerId: 10, offsetX: 0, offsetY: 0 }),
        );
        handler.pointerDown(
            view,
            createPointerEvent({ pointerType: "touch", pointerId: 20, offsetX: 10, offsetY: 10 }),
        );

        handler.pointerMove(
            view,
            createPointerEvent({ pointerType: "touch", pointerId: 10, offsetX: 1, offsetY: 1 }),
        );
        handler.pointerMove(
            view,
            createPointerEvent({ pointerType: "touch", pointerId: 20, offsetX: 11, offsetY: 11 }),
        );

        handler.pointerMove(
            view,
            createPointerEvent({ pointerType: "touch", pointerId: 10, offsetX: 5, offsetY: 5 }),
        );

        // Center moved from (5, 5) to (6, 6) while the pinch distance stayed the same
        expect(panArgs).toEqual([[1, 1]]);
        expect(zoomCalled).toBe(false);

        handler.dispose();
    });

    test("two-finger pinch with dominating distance change zooms, never pans", () => {
        const handler = new ThreeViewHandler();
        let panCalled = false;
        let zoomCalled = false;
        const cc = createMockCameraController();
        cc.zoom = () => {
            zoomCalled = true;
        };
        cc.pan = () => {
            panCalled = true;
        };
        const view = createHandlerMockView({ cameraController: cc });

        handler.pointerDown(
            view,
            createPointerEvent({ pointerType: "touch", pointerId: 10, offsetX: 0, offsetY: 0 }),
        );
        handler.pointerDown(
            view,
            createPointerEvent({ pointerType: "touch", pointerId: 20, offsetX: 10, offsetY: 0 }),
        );

        handler.pointerMove(
            view,
            createPointerEvent({ pointerType: "touch", pointerId: 10, offsetX: 0, offsetY: 0 }),
        );
        handler.pointerMove(
            view,
            createPointerEvent({ pointerType: "touch", pointerId: 20, offsetX: 30, offsetY: 0 }),
        );

        // Distance grew 10 -> 30 while the center stayed on the same point
        handler.pointerMove(
            view,
            createPointerEvent({ pointerType: "touch", pointerId: 10, offsetX: 0, offsetY: 0 }),
        );

        expect(zoomCalled).toBe(true);
        expect(panCalled).toBe(false);

        handler.dispose();
    });

    test("three-finger gesture triggers rotate", () => {
        const handler = new ThreeViewHandler();
        let rotateCalled = false;
        const cc = createMockCameraController();
        cc.rotate = () => {
            rotateCalled = true;
        };
        const view = createHandlerMockView({ cameraController: cc });

        handler.pointerDown(
            view,
            createPointerEvent({
                pointerType: "touch",
                pointerId: 100,
                offsetX: 0,
                offsetY: 0,
                isPrimary: true,
            }),
        );
        handler.pointerDown(
            view,
            createPointerEvent({
                pointerType: "touch",
                pointerId: 200,
                offsetX: 10,
                offsetY: 0,
                isPrimary: false,
            }),
        );
        handler.pointerDown(
            view,
            createPointerEvent({
                pointerType: "touch",
                pointerId: 300,
                offsetX: 5,
                offsetY: 10,
                isPrimary: false,
            }),
        );

        handler.pointerMove(
            view,
            createPointerEvent({
                pointerType: "touch",
                pointerId: 100,
                offsetX: 1,
                offsetY: 1,
                isPrimary: true,
            }),
        );
        handler.pointerMove(
            view,
            createPointerEvent({
                pointerType: "touch",
                pointerId: 200,
                offsetX: 11,
                offsetY: 1,
                isPrimary: false,
            }),
        );
        handler.pointerMove(
            view,
            createPointerEvent({
                pointerType: "touch",
                pointerId: 300,
                offsetX: 6,
                offsetY: 11,
                isPrimary: false,
            }),
        );

        handler.pointerMove(
            view,
            createPointerEvent({
                pointerType: "touch",
                pointerId: 100,
                offsetX: 3,
                offsetY: 3,
                isPrimary: true,
            }),
        );
        expect(rotateCalled).toBe(true);

        handler.dispose();
    });

    test("single finger touch move does not trigger gestures", () => {
        const handler = new ThreeViewHandler();
        let gestureCalled = false;
        const cc = createMockCameraController();
        cc.zoom = () => {
            gestureCalled = true;
        };
        cc.pan = () => {
            gestureCalled = true;
        };
        cc.rotate = () => {
            gestureCalled = true;
        };
        const view = createHandlerMockView({ cameraController: cc });

        handler.pointerDown(
            view,
            createPointerEvent({ pointerType: "touch", pointerId: 50, offsetX: 0, offsetY: 0 }),
        );
        handler.pointerMove(
            view,
            createPointerEvent({ pointerType: "touch", pointerId: 50, offsetX: 5, offsetY: 5 }),
        );

        expect(gestureCalled).toBe(false);
    });
});
