// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { Plane } from "@spicy3d/core";
import { TestDocument } from "@spicy3d/core/test-utils";
import { registerBasicInspectAnalyses } from "../src/analysis/basic";

test("flipping a section reverses the retained side without moving its signed-offset plane", async () => {
    const document = new TestDocument();
    const planes: Plane[] = [];
    document.visual.context.acquireAnalysisClip = (_owner, plane) => {
        planes.push(plane);
        return () => {};
    };
    registerBasicInspectAnalyses(document.analyses);
    try {
        const node = document.analyses.add({
            name: "Section",
            kind: "section",
            sources: [],
            settings: { plane: "xy", offset: 7, rotation: 25 },
            visible: false,
        });
        node.visible = true;
        await document.analyses.evaluate(node);
        expect(node.status).toBe("ready");
        const before = planes.at(-1);
        expect(before).not.toBeUndefined();
        document.analyses.update(node, { settings: { ...node.settings, flip: true } });
        await document.analyses.evaluate(node);
        const after = planes.at(-1);
        expect(after).not.toBeUndefined();
        if (!before || !after) throw new Error("Expected section clipping planes");
        expect(after.origin.distanceTo(before.origin)).toBeCloseTo(0, 8);
        expect(after.normal.dot(before.normal)).toBeCloseTo(-1, 8);
    } finally {
        document.dispose();
    }
});
