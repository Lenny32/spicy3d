// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { I18n, Matrix4, Result, ShapeNode } from "@spicy3d/core";
import { MockShape, TestDocument } from "@spicy3d/core/test-utils";
import { AnalysisPanel } from "../../ui/src/project/analysisPanel";
import { registerPrerequisiteInspectAnalyses } from "../src/analysis/prerequisites";

class SourceNode extends ShapeNode {
    display(): "common.cancel" {
        return "common.cancel";
    }
}
let doc: TestDocument;
beforeEach(() => {
    doc = new TestDocument();
    registerPrerequisiteInspectAnalyses(doc.analyses);
});
afterEach(() => doc.dispose());
function fixture() {
    const sources = ["bolt", "part", "nut"].map((name) => {
        const node = new SourceNode({ document: doc, name });
        node.shape = Result.ok(new MockShape({ id: name }));
        doc.modelManager.rootNode.add(node);
        return node;
    });
    const axis = (z: number) => ({ point: { x: 0, y: 0, z }, direction: { x: 0, y: 0, z: 1 } });
    const settings = {
        nominalLength: 14,
        threadLength: 14,
        minEngagement: 4,
        maxEngagement: 4,
        members: [
            { nodeId: sources[0].id, role: "bolt", diameter: 6, axis: axis(0) },
            { nodeId: sources[1].id, role: "part", holeDiameter: 6.5, thickness: 10, axis: axis(0) },
            { nodeId: sources[2].id, role: "nut", holeDiameter: 6, thickness: 4, axis: axis(10) },
        ],
    };
    return { sources, settings };
}
async function analyze(sources: SourceNode[], settings: Record<string, unknown>) {
    const node = doc.analyses.add({
        name: "Stack",
        kind: "fastenerStack",
        sources: sources.map((source) => ({ nodeId: source.id })),
        settings,
        visible: false,
    });
    node.visible = true;
    await doc.analyses.evaluate(node);
    return node;
}

test("flush bolt end fully engages a nut instead of subtracting nut thickness from engagement", async () => {
    const { sources, settings } = fixture();
    const node = await analyze(sources, settings);
    expect(node.error).toBeUndefined();
    const result = doc.analyses.result(node);
    expect(result?.legend?.find((entry) => entry.label === "Failed checks")?.value).toBe("0");
    const engagement = result?.rows?.find((row) => row.label === "Thread engagement");
    expect(Number.parseFloat(engagement?.value ?? "NaN")).toBeCloseTo(4, 6);
    expect(engagement?.value).toContain("pass");
});

test("missing thread metadata is incomplete instead of silently assuming a fully threaded bolt", async () => {
    const { sources, settings } = fixture();
    const incomplete: Record<string, unknown> = { ...settings };
    delete incomplete["threadLength"];
    const node = await analyze(sources, incomplete);
    expect(node.error).toBeUndefined();
    const result = doc.analyses.result(node);
    expect(
        Number(result?.legend?.find((entry) => entry.label === "Incomplete checks")?.value),
    ).toBeGreaterThan(0);
    expect(result?.rows?.find((row) => row.label === "Thread engagement")?.value).toContain("Incomplete");
});

test("moving a member off the common axis invalidates alignment and recomputes the stack", async () => {
    const { sources, settings } = fixture();
    const node = await analyze(sources, settings);
    sources[1].transform = Matrix4.fromTranslation(2, 0, 0);
    await doc.analyses.evaluate(node);
    const alignment = doc.analyses.result(node)?.rows?.find((row) => row.label === "part alignment");
    expect(alignment?.value).toContain("2.000 mm radial");
    expect(alignment?.value).toContain("misaligned");
});

test.each([-1, Infinity, NaN])("invalid bolt diameter %s is an explicit invalid result", async (diameter) => {
    const { sources, settings } = fixture();
    settings.members[0].diameter = diameter;
    const node = await analyze(sources, settings);
    expect(node.status).toBe("invalid");
    expect(node.error).toContain("dimensions");
});

test("a nut moved beyond the bolt along its axis cannot pass engagement", async () => {
    const { sources, settings } = fixture();
    sources[2].transform = Matrix4.fromTranslation(0, 0, 100);
    const node = await analyze(sources, settings);
    expect(node.error).toBeUndefined();
    const result = doc.analyses.result(node);
    expect(Number(result?.legend?.find((entry) => entry.label === "Failed checks")?.value)).toBeGreaterThan(
        0,
    );
    const engagement = result?.rows?.find((row) => row.label === "Thread engagement");
    expect(Number.parseFloat(engagement?.value ?? "NaN")).toBeCloseTo(0, 6);
    expect(engagement?.value).toContain("outside limits");
});

test("sequential focused fastener controls preserve prior edits across members", async () => {
    const { sources, settings } = fixture();
    const node = await analyze(sources, settings);
    const panel = new AnalysisPanel(node);
    document.body.append(panel);
    try {
        const controls = Array.from(
            panel.querySelectorAll<HTMLInputElement | HTMLSelectElement>("input,select"),
        );
        const edit = (label: string, value: string) => {
            const input = controls.find((item) => item.ariaLabel === label);
            expect(input).not.toBeUndefined();
            if (!input) throw new Error(label);
            input.focus();
            input.value = value;
            input.dispatchEvent(new Event("change"));
        };
        edit("bolt role", "washer");
        edit(`bolt ${I18n.translate("analysis.panel.boltDiameter")}`, "8");
        edit(`bolt ${I18n.translate("analysis.panel.axisPoint")}`, "1,2,3");
        edit(`bolt ${I18n.translate("analysis.panel.axisDirection")}`, "1,0,0");
        edit(`part ${I18n.translate("analysis.panel.axialThickness")}`, "12");
        const members = node.settings["members"] as Array<Record<string, unknown>>;
        const bolt = members.find((member) => member["nodeId"] === sources[0].id);
        expect(bolt).toMatchObject({
            role: "washer",
            diameter: 8,
            axis: { point: { x: 1, y: 2, z: 3 }, direction: { x: 1, y: 0, z: 0 } },
        });
        expect(members.find((member) => member["nodeId"] === sources[1].id)?.["thickness"]).toBe(12);
    } finally {
        panel.remove();
    }
});

test("sequential obstruction checkboxes preserve prior focused selections", async () => {
    const { sources } = fixture();
    doc.analyses.registerEvaluator("accessibility", () => Result.ok({}));
    const node = doc.analyses.add({
        name: "Access",
        kind: "accessibility",
        sources: sources.map((source) => ({ nodeId: source.id })),
        settings: {},
        visible: true,
    });
    await doc.analyses.evaluate(node);
    const panel = new AnalysisPanel(node);
    document.body.append(panel);
    try {
        const labels = Array.from(panel.querySelectorAll("label")).filter(
            (item) => item.textContent === I18n.translate("analysis.panel.obstruction", "bolt"),
        );
        expect(labels).toHaveLength(3);
        const select = (index: number) => {
            const label = labels[index];
            expect(label).not.toBeUndefined();
            const input = label?.querySelector("input");
            expect(input).not.toBeNull();
            if (!input) throw new Error("Missing obstruction input");
            input.focus();
            input.checked = true;
            input.dispatchEvent(new Event("change"));
        };
        select(0);
        select(1);
        expect(node.settings["obstructionSourceIndexes"]).toEqual([0, 1]);
    } finally {
        panel.remove();
    }
});
