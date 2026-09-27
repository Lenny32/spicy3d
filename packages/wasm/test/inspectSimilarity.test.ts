// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    EditableShapeNode,
    I18n,
    type IApplication,
    type IShape,
    Matrix4,
    Plane,
    Result,
    ShapeNode,
    XYZ,
} from "@spicy3d/core";
import { createMockView, TestDocument } from "@spicy3d/core/test-utils";
import { registerPrerequisiteInspectAnalyses } from "../../app/src/analysis/prerequisites";
import { describeShape, similarityScore } from "../../app/src/analysis/similarity";
import { createTestFactory, unwrapOk } from "./helpers";
import "./setup";
import { InspectAddToLibraryCommand } from "../../app/src/commands/inspect";
import { AnalysisPanel } from "../../ui/src/project/analysisPanel";

class SourceNode extends ShapeNode {
    display(): "common.cancel" {
        return "common.cancel";
    }
}
const factory = createTestFactory();
let doc: TestDocument;
beforeEach(() => {
    doc = new TestDocument();
    doc.application = { documents: new Set([doc]), views: [] } as unknown as IApplication;
    registerPrerequisiteInspectAnalyses(doc.analyses);
});
afterEach(() => doc.dispose());
function source(name: string, shape: IShape) {
    const node = new SourceNode({ document: doc, name });
    node.shape = Result.ok(shape);
    doc.modelManager.rootNode.add(node);
    return node;
}
async function search(query: SourceNode, settings: Record<string, unknown> = {}) {
    const node = doc.analyses.add({
        name: "Search",
        kind: "similarComponents",
        sources: [{ nodeId: query.id }],
        settings,
        visible: false,
    });
    node.visible = true;
    await doc.analyses.evaluate(node);
    return node;
}

test("labeled local corpus ranks rigid duplicates before altered boxes, cylinders and spheres", async () => {
    const query = source("Query", unwrapOk(factory.box(Plane.XY, 10, 20, 30)));
    const duplicate = source("Rigid duplicate", unwrapOk(factory.box(Plane.XY, 10, 20, 30)));
    const c = Math.SQRT1_2;
    duplicate.transform = Matrix4.fromArray([c, c, 0, 0, -c, c, 0, 0, 0, 0, 1, 0, 31, 7, 2, 1]);
    const altered = source("Similar box", unwrapOk(factory.box(Plane.XY, 11, 20, 30)));
    const cylinder = source("Cylinder", unwrapOk(factory.cylinder(XYZ.unitZ, XYZ.zero, 10, 20)));
    const sphere = source("Sphere", unwrapOk(factory.sphere(XYZ.zero, 10)));
    doc.userData = { inspectLibrary: [sphere.id, cylinder.id, altered.id, duplicate.id] };
    const node = await search(query);
    expect(node.error).toBeUndefined();
    const rows = doc.analyses.result(node)?.rows;
    expect(rows).toHaveLength(4);
    expect(rows?.[0].nodeId).toBe(duplicate.id);
    expect(rows?.[1].nodeId).toBe(altered.id);
    expect(rows?.[0].overlays?.[0].position.length).toBeGreaterThan(0);
    expect(query.shape.value.volume()).toBeCloseTo(6000, 6);
});

test("optional scale invariance removes uniform scale from the descriptor score", () => {
    const box = source("Box", unwrapOk(factory.box(Plane.XY, 10, 20, 30)));
    const scaled = source("Scaled", box.shape.value.transformedMul(Matrix4.fromScale(2, 2, 2)));
    const a = unwrapOk(describeShape(box.shape.value));
    const b = unwrapOk(describeShape(scaled.shape.value));
    expect(similarityScore(a, b, true)).toBeLessThan(1e-6);
    expect(similarityScore(a, b, false)).toBeGreaterThan(1);
});

test("an empty explicit local library is an actionable invalid state", async () => {
    const query = source("Query", unwrapOk(factory.box(Plane.XY, 10, 20, 30)));
    const node = await search(query);
    expect(node.status).toBe("invalid");
    expect(node.error).toMatch(/empty|No other indexed bodies/);
    expect(doc.analyses.result(node)).toBeUndefined();
});

test("editing a library candidate updates ranking without editing the query definition", async () => {
    const query = source("Query", unwrapOk(factory.box(Plane.XY, 10, 20, 30)));
    const first = source("First", unwrapOk(factory.box(Plane.XY, 10, 20, 30)));
    const second = source("Second", unwrapOk(factory.box(Plane.XY, 11, 20, 30)));
    doc.userData = { inspectLibrary: [first.id, second.id] };
    const node = await search(query);
    expect(doc.analyses.result(node)?.rows?.[0].nodeId).toBe(first.id);
    first.shape = factory.sphere(XYZ.zero, 10);
    await settle();
    expect(doc.analyses.result(node)?.rows?.[0].nodeId).toBe(second.id);
    second.parent?.remove(second);
    await settle();
    expect(doc.analyses.result(node)?.rows?.map((row) => row.nodeId)).toEqual([first.id]);
});

async function settle() {
    for (let i = 0; i < 100; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        if (doc.analyses.items.every((item) => item.status !== "running")) return;
    }
}

test("editing and deleting a candidate in another open document invalidates the ranking", async () => {
    const library = new TestDocument();
    try {
        const application = { documents: new Set([doc, library]), views: [] } as unknown as IApplication;
        doc.application = application;
        library.application = application;
        const query = source("Query", unwrapOk(factory.box(Plane.XY, 10, 20, 30)));
        const local = source("Local altered", unwrapOk(factory.box(Plane.XY, 11, 20, 30)));
        const remote = new SourceNode({ document: library, name: "Remote duplicate" });
        remote.shape = factory.box(Plane.XY, 10, 20, 30);
        library.modelManager.rootNode.add(remote);
        doc.userData = { inspectLibrary: [local.id] };
        library.userData = { inspectLibrary: [remote.id] };
        const analysis = await search(query);
        expect(doc.analyses.result(analysis)?.rows?.[0].nodeId).toBe(remote.id);
        remote.shape = factory.sphere(XYZ.zero, 10);
        await settle();
        expect(doc.analyses.result(analysis)?.rows?.[0].nodeId).toBe(local.id);
        remote.parent?.remove(remote);
        await settle();
        expect(doc.analyses.result(analysis)?.rows?.map((row) => row.nodeId)).toEqual([local.id]);
    } finally {
        library.dispose();
    }
});

test("inserting a library result creates an inspectable transformed independent copy", async () => {
    const query = source("Query", unwrapOk(factory.box(Plane.XY, 10, 20, 30)));
    const candidate = source("Candidate", unwrapOk(factory.box(Plane.XY, 10, 20, 30)));
    candidate.transform = Matrix4.fromTranslation(50, 0, 0);
    doc.userData = { inspectLibrary: [candidate.id] };
    const analysis = await search(query);
    const panel = new AnalysisPanel(analysis);
    document.body.append(panel);
    try {
        const insert = Array.from(panel.querySelectorAll("button")).find(
            (button) => button.textContent === I18n.translate("analysis.panel.insert"),
        );
        expect(insert).not.toBeUndefined();
        if (!insert) throw new Error("Missing insert action");
        insert.click();
        const copy = doc.modelManager.findNode((node) => node.name === "Candidate_copy");
        expect(copy).toBeInstanceOf(EditableShapeNode);
        if (!(copy instanceof EditableShapeNode)) throw new Error("Expected editable copy");
        expect(copy.id).not.toBe(candidate.id);
        expect(copy.shape.value.boundingBox().min.x).toBeCloseTo(50, 5);
        const resolved = doc.analyses.resolveSource({ nodeId: copy.id });
        expect(resolved.isOk).toBe(true);
        if (!resolved.isOk) throw new Error(resolved.error);
        resolved.value.dispose();
        doc.history.undo();
        expect(doc.modelManager.findNode((node) => node.id === copy.id)).toBeUndefined();
        doc.history.redo();
        expect(doc.modelManager.findNode((node) => node.id === copy.id)).toBe(copy);
    } finally {
        panel.remove();
    }
});

test("library membership command undo and redo refresh the saved search", async () => {
    const query = source("Query", unwrapOk(factory.box(Plane.XY, 10, 20, 30)));
    const candidate = source("Candidate", unwrapOk(factory.box(Plane.XY, 10, 20, 30)));
    const analysis = await search(query);
    expect(analysis.status).toBe("invalid");
    doc.application.activeView = createMockView({ document: doc });
    class AddMembership extends InspectAddToLibraryCommand {
        override get application() {
            return doc.application;
        }
        run() {
            this.stepDatas = [
                { view: doc.application.activeView!, type: "input", shapes: [], nodes: [candidate] },
            ];
            this.executeMainTask();
        }
    }
    new AddMembership().run();
    await settle();
    expect(doc.userData?.["inspectLibrary"]).toEqual([candidate.id]);
    expect(doc.analyses.result(analysis)?.rows?.[0].nodeId).toBe(candidate.id);
    doc.history.undo();
    await settle();
    expect(doc.userData?.["inspectLibrary"]).toEqual([]);
    expect(analysis.status).toBe("invalid");
    doc.history.redo();
    await settle();
    expect(doc.analyses.result(analysis)?.rows?.[0].nodeId).toBe(candidate.id);
});
