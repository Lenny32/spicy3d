// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IView } from "../src";
import type { MouseAndDetected } from "../src/snap/snap";

export function createPointerEvent(overrides?: Partial<PointerEvent>): PointerEvent {
    return {
        button: 0,
        isPrimary: true,
        offsetX: 100,
        offsetY: 200,
        clientX: 150,
        clientY: 250,
        pointerId: 1,
        pointerType: "mouse",
        shiftKey: false,
        preventDefault: () => {},
        stopImmediatePropagation: () => {},
        ...overrides,
    } as PointerEvent;
}

export function createMouseAndDetected(view: IView, overrides?: Partial<MouseAndDetected>): MouseAndDetected {
    return {
        view,
        mx: 400,
        my: 300,
        shapes: [],
        ...overrides,
    };
}
