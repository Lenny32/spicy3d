// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { describe, expect, test } from "@rstest/core";
import { createMockApplication, createMockDocument } from "@spicy3d/core/test-utils";
import { Redo } from "../../src/commands/redo";

describe("Redo", () => {
    test("should have command metadata", () => {
        const data = (Redo as any).prototype.data;
        expect(data).not.toBeNull();
        expect(data.key).toBe("edit.redo");
        expect(data.icon).toBe("icon-redo");
    });

    test("should call history.redo and visual.update when document exists", async () => {
        const doc = createMockDocument();
        let redoCallCount = 0;
        let visualUpdateCallCount = 0;

        doc.history.redo = async () => {
            redoCallCount++;
        };
        doc.visual.update = () => {
            visualUpdateCallCount++;
        };

        const app = createMockApplication();
        app.activeView = { document: doc } as any;

        const cmd = new Redo();
        await cmd.execute(app);

        expect(redoCallCount).toBe(1);
        expect(visualUpdateCallCount).toBe(1);
    });

    test("should do nothing when activeView is undefined", async () => {
        const app = createMockApplication();
        app.activeView = undefined;

        const cmd = new Redo();
        await expect(cmd.execute(app)).resolves.toBeUndefined();

        // Application state stays unchanged: no view is created
        expect(app.activeView).toBeUndefined();
        expect(app.views.length).toBe(0);
    });

    test("should do nothing when document is undefined", async () => {
        const app = createMockApplication();
        const view = { document: undefined } as any;
        app.activeView = view;

        const cmd = new Redo();
        await expect(cmd.execute(app)).resolves.toBeUndefined();

        // The view is left untouched: still no document attached
        expect(app.activeView).toBe(view);
        expect(view.document).toBeUndefined();
    });
});
