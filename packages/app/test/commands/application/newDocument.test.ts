// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { describe, expect, rs, test } from "@rstest/core";
import { I18n, type I18nKeys } from "@spicy3d/core";
import { createMockApplication } from "@spicy3d/core/test-utils";
import { NewDocument } from "../../../src/commands/application/newDocument";

describe("NewDocument", () => {
    test("should have command metadata", () => {
        const data = (NewDocument as any).prototype.data;
        expect(data).not.toBeNull();
        expect(data.key).toBe("doc.new");
        expect(data.icon).toBe("icon-file-plus");
    });

    test("should have isApplicationCommand flag", () => {
        const data = (NewDocument as any).prototype.data;
        expect(data.isApplicationCommand).toBe(true);
    });

    test("names new documents with the localized Untitled N, counting up", async () => {
        const app = createMockApplication();
        const names: string[] = [];
        app.newDocument = async (name: string) => {
            names.push(name);
            return {} as any;
        };
        // The test locale echoes keys, so the placeholder is filled in here.
        const translate = rs
            .spyOn(I18n, "translate")
            .mockImplementation((key: I18nKeys, ...args: any[]) => `${key} ${args.join(" ")}`);

        try {
            const cmd = new NewDocument();
            await cmd.execute(app);
            await cmd.execute(app);
        } finally {
            translate.mockRestore();
        }

        expect(names).toHaveLength(2);
        const [first, second] = names.map((name) => /^document\.untitled (\d+)$/.exec(name));
        expect(first).not.toBeNull();
        expect(second).not.toBeNull();
        expect(Number(second![1])).toBe(Number(first![1]) + 1);
    });
});
