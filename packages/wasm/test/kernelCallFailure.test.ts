// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { kernelCallFailure } from "../src/factory";

class RuntimeError extends Error {
    override name = "RuntimeError";
}

describe("kernelCallFailure", () => {
    test.each([
        [
            "an abort, without Emscripten's -sASSERTIONS advice",
            new RuntimeError("Aborted(undefined). Build with -sASSERTIONS for more info."),
            "MakeThickSolidByJoin failed: RuntimeError: Aborted(undefined)",
        ],
        [
            "a plain Error thrown by a binding, by its message alone",
            new Error("Shape.findSubShapes: Standard_NullObject"),
            "MakeThickSolidByJoin failed: Shape.findSubShapes: Standard_NullObject",
        ],
        [
            "a named error without a message, by its name",
            new RuntimeError(""),
            "MakeThickSolidByJoin failed: RuntimeError",
        ],
        ["a thrown non-error value, as text", "BindingError", "MakeThickSolidByJoin failed: BindingError"],
    ])("formats %s", (_case, error, expected) => {
        expect(kernelCallFailure("MakeThickSolidByJoin", error)).toBe(expected);
    });
});
