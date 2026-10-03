// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { I18n, PubSub } from "@spicy3d/core";
import { TestDocument } from "@spicy3d/core/test-utils";
import { Permanent } from "../src/permanent";

test.each([false, true])("loading progress and listeners are cleaned up (failure: %s)", async (fail) => {
    const doc = new TestDocument();
    const action = Promise.withResolvers<void>();
    const remove = rs.spyOn(PubSub.default, "remove");
    const loading = Permanent.show(() => action.promise, "command.doc.open");
    const outcome = loading.catch((error: Error) => error.message);
    try {
        const dialog = document.querySelector("dialog");
        expect(dialog).not.toBeNull();
        const status = dialog!.querySelector('[role="status"]');
        expect(status).not.toBeNull();
        PubSub.default.pub("rebuildProgress", doc, "visual-load", { completed: 1, total: 4 });
        expect(status!.textContent).toBe(I18n.translate("model.rebuilding{0}{1}", 1, 4));
        PubSub.default.pub("rebuildProgress", doc, "body", { completed: 2, total: 12 });
        expect(status!.textContent).toBe(I18n.translate("model.rebuilding{0}{1}", 3, 16));
        PubSub.default.pub("rebuildProgress", doc, "visual-load", undefined);
        expect(status!.textContent).toBe(I18n.translate("model.rebuilding{0}{1}", 2, 12));
        if (fail) action.reject(new Error("load failed"));
        else action.resolve();
        expect(await outcome).toBe(fail ? "load failed" : undefined);
        expect(document.querySelector("dialog")).toBeNull();
        expect(remove.mock.calls.some(([event]) => event === "rebuildProgress")).toBe(true);
        PubSub.default.pub("rebuildProgress", doc, "body", { completed: 3, total: 12 });
        expect(status!.textContent).toBe(I18n.translate("model.rebuilding{0}{1}", 2, 12));
    } finally {
        action.resolve();
        await outcome;
        remove.mockRestore();
        doc.dispose();
    }
});
