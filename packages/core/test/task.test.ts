// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { AsyncController } from "../src";

describe("AsyncController", () => {
    test("should set result to cancel after cancel()", () => {
        const controller = new AsyncController();
        expect(controller.result?.status).not.toBe("cancel");

        controller.cancel();

        expect(controller.result?.status).toBe("cancel");
    });

    test("should set result to fail with message after fail()", () => {
        const controller = new AsyncController();
        expect(controller.result?.status).not.toBe("fail");

        controller.fail("fail msg");

        expect(controller.result?.status).toBe("fail");
        expect(controller.result?.message).toBe("fail msg");
    });

    test("should set result to success after success()", () => {
        const controller = new AsyncController();
        expect(controller.result?.status).not.toBe("success");

        controller.success();

        expect(controller.result?.status).toBe("success");
    });
});
