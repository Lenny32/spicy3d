// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { KernelCrashedError, KernelState } from "../src";

describe("KernelState", () => {
    test("works until the first crash, which is kept", () => {
        const state = new KernelState();
        expect(state.status).toBe("ok");
        expect(state.message).toBeUndefined();
        expect(() => state.throwIfCrashed()).not.toThrow();

        expect(state.markCrashed("Aborted(undefined)")).toBe(true);
        expect(state.markCrashed("table index is out of bounds")).toBe(false);
        expect(state.status).toBe("crashed");
        expect(state.reason).toBe("Aborted(undefined)");
        expect(state.message).toBe("Kernel crashed (Aborted(undefined)); reload the page");
        expect(() => state.throwIfCrashed()).toThrow(new KernelCrashedError("Aborted(undefined)"));
    });

    test("notifies the status change once", () => {
        const state = new KernelState();
        const changes: string[] = [];
        state.onPropertyChanged((property) => changes.push(String(property)));
        state.markCrashed("x");
        state.markCrashed("y");
        expect(changes).toEqual(["status"]);
    });

    test("reset brings a fresh kernel back (tests)", () => {
        const state = new KernelState();
        state.markCrashed("x");
        state.reset();
        expect(state.status).toBe("ok");
        expect(state.reason).toBeUndefined();
    });
});
