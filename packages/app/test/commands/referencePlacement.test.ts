// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { afterEach, describe, expect, rs, test } from "@rstest/core";
import {
    BoundingBox,
    EditSessions,
    type IDocument,
    Matrix4,
    Mesh,
    MeshNode,
    PubSub,
    Result,
    SidePanels,
    Transaction,
    XYZ,
} from "@spicy3d/core";
import { createMockApplication, createMockView, TestDocument } from "@spicy3d/core/test-utils";
import { ImportReferenceMesh } from "../../src/commands/importExport";
import {
    ReferencePlacementCommand,
    type ReferencePlacementPreset,
    referencePlacementTransform,
    showReferencePlacement,
} from "../../src/commands/referencePlacement";

function fixture() {
    const application = createMockApplication();
    const document = new TestDocument({ application });
    application.activeView = createMockView({ document });
    const node = new MeshNode({
        document,
        name: "reference.stl",
        mesh: new Mesh({
            meshType: "surface",
            position: new Float32Array([10, 20, 30, 14, 20, 30, 10, 26, 38]),
        }),
    });
    document.modelManager.addNode(node);
    return { application, document, node };
}

function click(panel: HTMLElement, text: string) {
    const button = Array.from(panel.querySelectorAll("button")).find((item) => item.textContent === text);
    expect(button).not.toBeUndefined();
    button?.click();
}

function input(panel: HTMLElement, name: string, value: string) {
    const element = panel.querySelector<HTMLInputElement>(`input[name="${name}"]`);
    expect(element).not.toBeNull();
    if (!element) throw new Error("Missing input");
    element.value = value;
}

afterEach(() => {
    PubSub.default.pub("activeViewChanged", undefined);
    rs.restoreAllMocks();
});

describe("Reference mesh placement", () => {
    test("a reference import opens the panel after committing the imported node", async () => {
        const { application, document, node } = fixture();
        const importer = rs.fn(async (_document: IDocument, _file: File) => Result.ok(node));
        application.dataExchange.importReferenceMesh = importer;
        const fit = rs.fn(() => {});
        application.activeView!.cameraController.fitContent = fit;
        const file = new File(["solid reference\nendsolid reference"], "reference.stl");
        rs.spyOn(HTMLInputElement.prototype, "click").mockImplementation(function (this: HTMLInputElement) {
            const transfer = new DataTransfer();
            transfer.items.add(file);
            this.files = transfer.files;
            this.dispatchEvent(new Event("change"));
        });
        const count = SidePanels.items.length;
        await new ImportReferenceMesh().execute(application);
        expect(importer).toHaveBeenCalledWith(document, file);
        expect(fit).toHaveBeenCalledTimes(1);
        expect(SidePanels.items.length).toBe(count + 1);
        const panel = SidePanels.items.at(-1);
        expect(panel).not.toBeUndefined();
        expect(panel?.textContent).toContain("reference.stl");
        expect(panel?.querySelectorAll('input[type="number"]').length).toBe(6);
        expect(node.transform.equals(Matrix4.identity())).toBe(true);
    });

    test("a batch opens placement for its last successful mesh, even when the last file fails", async () => {
        const { application, document, node } = fixture();
        const fit = rs.fn(() => {});
        application.activeView!.cameraController.fitContent = fit;
        const last = new MeshNode({ document, mesh: node.mesh, name: "second.stl" });
        const files = ["first.stl", "second.stl", "failed.stl"].map((name) => new File(["mesh"], name));
        const importer = rs.fn(async (_document: IDocument, file: File) => {
            if (file.name === "failed.stl") return Result.err("invalid mesh");
            const imported = file.name === "second.stl" ? last : node;
            document.modelManager.addNode(imported);
            return Result.ok(imported);
        });
        application.dataExchange.importReferenceMesh = importer;
        rs.spyOn(HTMLInputElement.prototype, "click").mockImplementation(function (this: HTMLInputElement) {
            const transfer = new DataTransfer();
            for (const file of files) transfer.items.add(file);
            this.files = transfer.files;
            this.dispatchEvent(new Event("change"));
        });
        const count = SidePanels.items.length;
        await new ImportReferenceMesh().execute(application);
        expect(importer).toHaveBeenCalledTimes(3);
        expect(fit).toHaveBeenCalledTimes(1);
        expect(SidePanels.items.length).toBe(count + 1);
        expect(SidePanels.items.at(-1)?.textContent).toContain("second.stl");
    });

    test("the placement command reopens a selected mesh without point picking", async () => {
        const { application, document, node } = fixture();
        document.selection.getSelectedNodes = () => [node];
        const count = SidePanels.items.length;
        await new ReferencePlacementCommand().execute(application);
        expect(SidePanels.items.length).toBe(count + 1);
        expect(SidePanels.items.at(-1)?.textContent).toContain("reference.stl");
    });

    test.each([
        ["center", [-2, -3, -4], [2, 3, 4]],
        ["minimum", [0, 0, 0], [4, 6, 8]],
        ["floor", [-2, -3, 0], [2, 3, 8]],
    ] as [
        ReferencePlacementPreset,
        number[],
        number[],
    ][])("%s places the mesh bounds at the origin", (preset, min, max) => {
        const { node } = fixture();
        node.transform = Matrix4.fromEuler(0, 0, Math.PI).multiply(Matrix4.fromTranslation(100, -50, 5));
        const result = referencePlacementTransform(node, XYZ.zero, XYZ.zero, preset);
        expect(result.isOk).toBe(true);
        const bounds = BoundingBox.fromNumbers(result.value.ofPoints(node.mesh.position!));
        expect(bounds).not.toBeUndefined();
        expect(bounds?.min.x).toBeCloseTo(min[0]);
        expect(bounds?.min.y).toBeCloseTo(min[1]);
        expect(bounds?.min.z).toBeCloseTo(min[2]);
        expect(bounds?.max.x).toBeCloseTo(max[0]);
        expect(bounds?.max.y).toBeCloseTo(max[1]);
        expect(bounds?.max.z).toBeCloseTo(max[2]);
    });

    test("offsets follow world axes under a rotated parent", () => {
        const { node } = fixture();
        const parent = Matrix4.fromEuler(0, 0, Math.PI / 2).multiply(Matrix4.fromTranslation(30, 40, 50));
        node.transform = Matrix4.fromTranslation(2, 3, 4);
        rs.spyOn(node, "worldTransform").mockImplementation(() => node.transform.multiply(parent));
        const before = node.worldTransform().ofPoint(new XYZ(10, 20, 30));
        const result = referencePlacementTransform(node, new XYZ(5, 6, 7));
        expect(result.isOk).toBe(true);
        const after = result.value.multiply(parent).ofPoint(new XYZ(10, 20, 30));
        expect(after.x - before.x).toBeCloseTo(5);
        expect(after.y - before.y).toBeCloseTo(6);
        expect(after.z - before.z).toBeCloseTo(7);
    });

    test("rotation keeps the bounds center fixed and translates it by the offset", () => {
        const { node } = fixture();
        const result = referencePlacementTransform(node, new XYZ(5, 0, 0), new XYZ(0, 0, 90));
        expect(result.isOk).toBe(true);
        const center = result.value.ofPoint(new XYZ(12, 23, 34));
        expect(center.x).toBeCloseTo(17);
        expect(center.y).toBeCloseTo(23);
        expect(center.z).toBeCloseTo(34);
        const point = result.value.ofPoint(new XYZ(10, 20, 30));
        expect(point.x).toBeCloseTo(20);
        expect(point.y).toBeCloseTo(21);
        expect(point.z).toBeCloseTo(30);
    });

    test("combined Euler angles rotate about global Z, then Y, then X", () => {
        const { node } = fixture();
        const result = referencePlacementTransform(node, XYZ.zero, new XYZ(90, 90, 90));
        expect(result.isOk).toBe(true);
        // Relative to the center: (-2, -3, -4) -> (3, -2, -4) -> (-4, -2, -3) -> (-4, 3, -2).
        const point = result.value.ofPoint(new XYZ(10, 20, 30));
        expect(point.x).toBeCloseTo(8);
        expect(point.y).toBeCloseTo(26);
        expect(point.z).toBeCloseTo(32);
    });

    test("Apply is one undo step, retains mesh data and does not repeat old offsets", () => {
        const { node, document } = fixture();
        const mesh = node.mesh;
        const original = node.transform;
        const count = document.history.undoCount();
        const panel = showReferencePlacement(node);
        expect(SidePanels.items.contains(panel)).toBe(true);
        input(panel, "offsetX", "5");
        click(panel, "placement.apply");
        expect(node.transform.ofPoint(XYZ.zero).x).toBeCloseTo(5);
        expect(node.mesh).toBe(mesh);
        expect(document.history.undoCount()).toBe(count + 1);
        click(panel, "placement.apply");
        expect(document.history.undoCount()).toBe(count + 1);
        document.history.undo();
        expect(node.transform.equals(original)).toBe(true);
        document.history.redo();
        expect(node.transform.ofPoint(XYZ.zero).x).toBeCloseTo(5);
    });

    test("invalid input is refused and presets still work", () => {
        const { node } = fixture();
        const panel = showReferencePlacement(node);
        input(panel, "offsetX", "");
        click(panel, "placement.apply");
        expect(node.transform.equals(Matrix4.identity())).toBe(true);
        const error = panel.querySelector('[role="alert"]');
        expect(error).not.toBeNull();
        expect(error?.textContent).toBe("placement.invalid");
        click(panel, "placement.center");
        expect(BoundingBox.center(node.boundingBox()).x).toBeCloseTo(0);
        expect(BoundingBox.center(node.boundingBox()).y).toBeCloseTo(0);
        expect(BoundingBox.center(node.boundingBox()).z).toBeCloseTo(0);
        expect(error?.textContent).toBe("");
    });

    test("read-only and deleted nodes cannot be changed", () => {
        const { node, document } = fixture();
        const panel = showReferencePlacement(node);
        document.repository.isReadOnly = () => true;
        click(panel, "placement.center");
        expect(node.transform.equals(Matrix4.identity())).toBe(true);
        const error = panel.querySelector('[role="alert"]');
        expect(error).not.toBeNull();
        expect(error?.textContent).toBe("placement.unavailable");
        document.repository.isReadOnly = () => false;
        expect(SidePanels.items.contains(panel)).toBe(true);
        node.parent?.remove(node);
        expect(SidePanels.items.contains(panel)).toBe(false);
        expect(EditSessions.isActive(document)).toBe(false);
        click(panel, "placement.center");
        expect(node.transform.equals(Matrix4.identity())).toBe(true);
    });

    test("document replacement ends the placement session and releases its observer", () => {
        const { node, document } = fixture();
        const removeObserver = rs.spyOn(document.modelManager, "removeNodeObserver");
        const panel = showReferencePlacement(node);
        expect(EditSessions.isActive(document)).toBe(true);
        EditSessions.endAll(document);
        expect(SidePanels.items.contains(panel)).toBe(false);
        expect(EditSessions.isActive(document)).toBe(false);
        expect(removeObserver).toHaveBeenCalledTimes(1);
        input(panel, "offsetX", "5");
        click(panel, "placement.apply");
        expect(node.transform.equals(Matrix4.identity())).toBe(true);
        EditSessions.endAll(document);
        expect(removeObserver).toHaveBeenCalledTimes(1);
    });

    test("replacing a mesh with the same id closes its stale placement panel", () => {
        const { node, document } = fixture();
        const panel = showReferencePlacement(node);
        const data = document.modelManager.serialize();
        const record = data.nodes.find((item) => item["id"] === node.id);
        expect(record).not.toBeUndefined();
        if (!record) throw new Error("Missing mesh record");
        record["name"] = "replacement.stl";
        document.modelManager.applyContent(data);
        const replacement = document.modelManager.findNodes().find((item) => item.id === node.id);
        expect(replacement).not.toBeUndefined();
        expect(replacement).not.toBe(node);
        expect(replacement?.name).toBe("replacement.stl");
        expect(SidePanels.items.contains(panel)).toBe(false);
        expect(EditSessions.isActive(document)).toBe(false);
    });

    test("undoing an import closes placement, while undoing a placement keeps it open", () => {
        const { node, document } = fixture();
        node.parent?.remove(node);
        Transaction.execute(document, "import reference mesh", () => document.modelManager.addNode(node));
        const panel = showReferencePlacement(node);
        input(panel, "offsetX", "5");
        click(panel, "placement.apply");
        document.history.undo();
        expect(SidePanels.items.contains(panel)).toBe(true);
        document.history.undo();
        expect(document.modelManager.findNodes().includes(node)).toBe(false);
        expect(SidePanels.items.contains(panel)).toBe(false);
        expect(EditSessions.isActive(document)).toBe(false);
    });

    test("only one panel remains open, and closing or switching documents leaves placement intact", () => {
        const first = fixture();
        const panel = showReferencePlacement(first.node);
        const next = showReferencePlacement(first.node);
        expect(SidePanels.items.contains(panel)).toBe(false);
        expect(SidePanels.items.contains(next)).toBe(true);
        click(next, "placement.close");
        expect(SidePanels.items.contains(next)).toBe(false);
        expect(first.node.transform.equals(Matrix4.identity())).toBe(true);
        const reopened = showReferencePlacement(first.node);
        PubSub.default.pub("activeViewChanged", fixture().application.activeView);
        expect(SidePanels.items.contains(reopened)).toBe(false);
        const last = showReferencePlacement(first.node);
        PubSub.default.pub("documentClosed", first.document);
        expect(SidePanels.items.contains(last)).toBe(false);
    });
});
