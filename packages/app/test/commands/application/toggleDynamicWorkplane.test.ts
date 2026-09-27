// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { describe, expect, test } from "@rstest/core";
import { Config } from "@spicy3d/core";
import { createMockApplication } from "@spicy3d/core/test-utils";
import { ToggleDynamicWorkplaneCommand } from "../../../src/commands/application/toggleDynamicWorkplane";

describe("ToggleDynamicWorkplaneCommand", () => {
    test("should have command metadata", () => {
        const data = (ToggleDynamicWorkplaneCommand as any).prototype.data;
        expect(data).not.toBeNull();
        expect(data.key).toBe("workingPlane.toggleDynamic");
        expect(data.icon).toBe("icon-dynamicPlane");
    });

    test("should toggle dynamicWorkplane config", async () => {
        const app = createMockApplication();
        const cmd = new ToggleDynamicWorkplaneCommand();

        const before = Config.instance.dynamicWorkplane;
        await cmd.execute(app);
        expect(Config.instance.dynamicWorkplane).toBe(!before);

        // Toggle back
        await cmd.execute(app);
        expect(Config.instance.dynamicWorkplane).toBe(before);
    });
});
