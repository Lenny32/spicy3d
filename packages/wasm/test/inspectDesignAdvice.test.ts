// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import { Plane, Result, ShapeNode, ShapeTypes } from "@spicy3d/core";
import { TestDocument } from "@spicy3d/core/test-utils";
import { registerPrerequisiteInspectAnalyses } from "../../app/src/analysis/prerequisites";
import { createTestFactory, unwrapOk } from "./helpers";
import "./setup";

class SourceNode extends ShapeNode {
    display(): "common.cancel" {
        return "common.cancel";
    }
}
const factory = createTestFactory();
let doc: TestDocument;
beforeEach(() => {
    doc = new TestDocument();
    registerPrerequisiteInspectAnalyses(doc.analyses);
});
afterEach(() => doc.dispose());
const defaults = {
    minimumWall: 1,
    nominalWall: 2,
    wallVariation: 100,
    minimumDraft: 0,
    minimumRadius: 0.1,
    pullDirection: { x: 0, y: 0, z: 1 },
};
async function slab(thickness: number, settings: Record<string, unknown> = {}) {
    const source = new SourceNode({ document: doc, name: "Slab" });
    source.shape = factory.box(Plane.XY, 20, 20, thickness);
    doc.modelManager.rootNode.add(source);
    const analysis = doc.analyses.add({
        name: "Advice",
        kind: "designAdvice",
        sources: [{ nodeId: source.id }],
        settings: { ...defaults, ...settings },
        visible: false,
    });
    analysis.visible = true;
    await doc.analyses.evaluate(analysis);
    return analysis;
}

test.each([
    [0.5, true],
    [2, false],
])("wall checks classify an analytic %s mm slab", async (thickness, thin) => {
    const analysis = await slab(thickness);
    expect(analysis.error).toBeUndefined();
    expect(analysis.status).toBe("ready");
    const walls = doc.analyses.result(analysis)?.rows?.filter((row) => row.label.startsWith("Wall")) ?? [];
    expect(walls.length > 0).toBe(thin);
});

test("changing minimum wall recomputes the same saved analysis", async () => {
    const analysis = await slab(0.5);
    expect(
        doc.analyses.result(analysis)?.rows?.some((row) => String(row.value).includes("below minimum")),
    ).toBe(true);
    doc.analyses.update(analysis, { settings: { ...analysis.settings, minimumWall: 0.25 } });
    await doc.analyses.evaluate(analysis);
    expect(analysis.error).toBeUndefined();
    expect(doc.analyses.result(analysis)?.rows?.filter((row) => row.label.startsWith("Wall"))).toEqual([]);
});

test("zero draft walls are flagged when a positive draft threshold is requested", async () => {
    const analysis = await slab(2, { minimumDraft: 2 });
    expect(analysis.error).toBeUndefined();
    const rows = doc.analyses.result(analysis)?.rows?.filter((row) => row.label.startsWith("Draft")) ?? [];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((row) => String(row.value).includes("0.00"))).toBe(true);
});

test("opposing slab face reports negative draft for a fixed pull direction", async () => {
    const analysis = await slab(2, { minimumDraft: 2 });
    expect(analysis.error).toBeUndefined();
    const undercuts =
        doc.analyses
            .result(analysis)
            ?.rows?.filter((row) => String(row.value).includes("negative undercut")) ?? [];
    expect(undercuts.length).toBeGreaterThan(0);
    expect(undercuts.every((row) => String(row.value).includes("-90.00"))).toBe(true);
});

test("unavailable surface queries produce inconclusive guidance without a green success indicator", async () => {
    const box = unwrapOk(factory.box(Plane.XY, 2, 2, 2));
    const faces = box.findSubShapes(ShapeTypes.face);
    const spy = rs
        .spyOn(Object.getPrototypeOf(faces[0]), "inspectionUVBounds")
        .mockReturnValue(Result.err("unsupported surface"));
    try {
        const analysis = await slab(2);
        expect(analysis.error).toBeUndefined();
        const result = doc.analyses.result(analysis);
        expect(result?.rows?.some((row) => String(row.value).includes("Inconclusive"))).toBe(true);
        expect(result?.legend?.find((item) => item.label === "Findings")?.color).not.toBe(0x2bad4b);
    } finally {
        spy.mockRestore();
        faces.forEach((face) => face.dispose());
        box.dispose();
    }
});
