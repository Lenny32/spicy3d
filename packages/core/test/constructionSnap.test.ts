// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Config, ConstructionNode, ObjectSnapTypes, XYZ } from "../src";
import { ObjectSnap } from "../src/snap/snaps/objectSnap";
import { createMockApplication, createMockView, createMouseAndDetected, TestDocument } from "../test-utils";

test("point picking returns the persistent construction identity and follows edits", () => {
    const previous = Config.instance.enableSnap;
    Config.instance.enableSnap = true;
    const doc = new TestDocument({ application: createMockApplication() });
    const node = new ConstructionNode({
        document: doc,
        definition: {
            kind: "point-vertex",
            vertex: { kind: "fixed", geometry: { kind: "point", point: XYZ.zero } },
        },
    });
    doc.modelManager.addNode(node);
    const view = createMockView({ document: doc });
    const snap = new ObjectSnap(ObjectSnapTypes.vertex);
    try {
        const initial = snap.snap(createMouseAndDetected(view, { mx: 400, my: 300, shapes: [] }));
        expect(initial).not.toBeUndefined();
        expect(initial!.point?.isEqualTo(XYZ.zero)).toBe(true);
        expect(initial!.constructionRef).toEqual({ kind: "datum", nodeId: node.id });
        node.definition = {
            kind: "point-vertex",
            vertex: { kind: "fixed", geometry: { kind: "point", point: new XYZ({ x: 30, y: 20, z: 0 }) } },
        };
        const moved = snap.snap(createMouseAndDetected(view, { mx: 430, my: 320, shapes: [] }));
        expect(moved).not.toBeUndefined();
        expect(moved!.point?.x).toBeCloseTo(30);
        expect(moved!.point?.y).toBeCloseTo(20);
        expect(moved!.constructionRef).toEqual(initial!.constructionRef);
        node.visible = false;
        expect(snap.snap(createMouseAndDetected(view, { mx: 430, my: 320, shapes: [] }))).toBeUndefined();
        expect(node.geometry.isOk).toBe(true);
    } finally {
        snap.clear();
        Config.instance.enableSnap = previous;
    }
});
