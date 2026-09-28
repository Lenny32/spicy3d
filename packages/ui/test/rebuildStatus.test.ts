// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { I18n, PubSub } from "@spicy3d/core";
import { TestDocument } from "@spicy3d/core/test-utils";
import { RebuildIndicator } from "../src/statusbar/rebuildStatus";

test("rebuild status aggregates concurrent bodies and removes completed/cancelled work", () => {
    const doc = new TestDocument();
    const indicator = new RebuildIndicator();
    document.body.append(indicator);
    try {
        PubSub.default.pub("rebuildProgress", doc, "a", { completed: 2, total: 12 });
        PubSub.default.pub("rebuildProgress", doc, "b", { completed: 5, total: 20 });
        expect(indicator.textContent).toBe(I18n.translate("model.rebuilding{0}{1}", 7, 32));
        PubSub.default.pub("rebuildProgress", doc, "a", undefined);
        expect(indicator.textContent).toBe(I18n.translate("model.rebuilding{0}{1}", 5, 20));
        PubSub.default.pub("documentClosed", doc);
        expect(indicator.textContent).toBe("");
        indicator.remove();
        PubSub.default.pub("rebuildProgress", doc, "b", { completed: 6, total: 20 });
        expect(indicator.textContent).toBe("");
    } finally {
        indicator.remove();
        doc.dispose();
    }
});
