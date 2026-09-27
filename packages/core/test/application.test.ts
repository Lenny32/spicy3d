// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { getCurrentApplication, setCurrentApplication } from "../src";
import { createMockApplication } from "../test-utils";

describe("getCurrentApplication", () => {
    // The application is a process-wide singleton that can only be set once, so the
    // "unset" assertion must run before any test installs an instance. Keeping both
    // assertions in a single test avoids order dependencies between tests.
    test("should throw before an application is set and return it afterwards", () => {
        expect(() => getCurrentApplication()).toThrowError();

        const mockApp = createMockApplication();
        setCurrentApplication(mockApp);

        expect(getCurrentApplication()).toBe(mockApp);
        expect(getCurrentApplication()).toBe(mockApp);
    });
});
