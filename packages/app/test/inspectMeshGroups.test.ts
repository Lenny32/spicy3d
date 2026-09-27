// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type FaceMeshData, I18n, Matrix4, Mesh, MeshNode, Serializer } from "@spicy3d/core";
import { TestDocument } from "@spicy3d/core/test-utils";
import { AnalysisPanel } from "../../ui/src/project/analysisPanel";
import { registerPrerequisiteInspectAnalyses } from "../src/analysis/prerequisites";

const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 2, 0, 0, 3, 0, 0, 2, 1, 0]);
const groups = [
    { id: "first", name: "First", startTriangle: 0, triangleCount: 1, color: 0xff0000 },
    { id: "second", name: "Second", startTriangle: 1, triangleCount: 1, color: 0x0000ff },
];
let doc: TestDocument;
beforeEach(() => {
    doc = new TestDocument();
    registerPrerequisiteInspectAnalyses(doc.analyses);
});
afterEach(() => doc.dispose());

function mesh(grouped = true) {
    return new Mesh({
        meshType: "surface",
        position: new Float32Array(positions),
        normal: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
        semanticFaceGroups: grouped ? groups : [],
    });
}
async function analyze(value: Mesh) {
    const source = new MeshNode({ document: doc, name: "Mesh", mesh: value });
    doc.modelManager.rootNode.add(source);
    const node = doc.analyses.add({
        name: "Groups",
        kind: "meshFaceGroups",
        sources: [{ nodeId: source.id }],
        settings: {},
        visible: false,
    });
    node.visible = true;
    await doc.analyses.evaluate(node);
    return { source, node };
}

test("semantic groups roundtrip independently from render draw groups", () => {
    const original = mesh();
    expect(original.semanticGroupsAreCurrent()).toBe(true);
    let serialized = Serializer.serializeObject(original);
    for (let i = 0; i < 2; i++) {
        const copy = Serializer.deserializeObject(doc, JSON.parse(JSON.stringify(serialized))) as Mesh;
        expect(copy.semanticFaceGroups).toEqual(groups);
        expect(copy.semanticGroupsAreCurrent()).toBe(true);
        expect(copy.groups).toEqual([]);
        serialized = Serializer.serializeObject(copy);
    }
});

test("known groups produce separate colors, transformed positions and normals", async () => {
    const { source, node } = await analyze(mesh());
    source.transform = Matrix4.fromArray([1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 10, 20, 30, 1]);
    await doc.analyses.evaluate(node);
    expect(node.error).toBeUndefined();
    const result = doc.analyses.result(node);
    expect(result?.overlays).toHaveLength(2);
    const first = result?.overlays?.[0] as FaceMeshData;
    const second = result?.overlays?.[1] as FaceMeshData;
    expect(first.color).toBe(0xff0000);
    expect(second.color).toBe(0x0000ff);
    expect(Array.from(first.index)).toEqual([0, 1, 2]);
    expect(Array.from(second.index)).toEqual([3, 4, 5]);
    expect(Array.from(first.position.slice(0, 3))).toEqual([10, 20, 30]);
    expect(Array.from(first.normal.slice(0, 3))).toEqual([0, -1, 0]);
});

test("ungrouped meshes report unavailable instead of inventing face groups", async () => {
    const { node } = await analyze(mesh(false));
    expect(node.status).toBe("invalid");
    expect(node.error).toContain("no semantic face groups");
    expect(doc.analyses.result(node)).toBeUndefined();
});

test("in-place topology edits invalidate the old semantic grouping", async () => {
    const value = mesh();
    const { node } = await analyze(value);
    expect(node.status).toBe("ready");
    expect(value.position).not.toBeUndefined();
    if (!value.position) throw new Error("Expected mesh positions");
    value.position[0] = 7;
    expect(value.semanticGroupsAreCurrent()).toBe(false);
    await doc.analyses.evaluate(node);
    expect(node.status).toBe("invalid");
    expect(node.error).toContain("topology changed");
});

test("nonindexed mesh constructor rejects out-of-range or overlapping semantic groups", () => {
    expect(
        () =>
            new Mesh({
                meshType: "surface",
                position: new Float32Array(positions),
                semanticFaceGroups: [{ id: "bad", name: "Bad", startTriangle: 2, triangleCount: 1 }],
            }),
    ).toThrow("invalid triangle range");
    expect(
        () =>
            new Mesh({
                meshType: "surface",
                position: new Float32Array(positions),
                semanticFaceGroups: [groups[0], { ...groups[1], startTriangle: 0 }],
            }),
    ).toThrow("overlap");
});

test("manual face-group UI assigns persistent groups with undo and redo", async () => {
    const { source, node } = await analyze(mesh(false));
    const panel = new AnalysisPanel(node);
    document.body.append(panel);
    try {
        const name = Array.from(panel.querySelectorAll("input")).find(
            (input) => input.ariaLabel === "Mesh face group name",
        );
        const start = Array.from(panel.querySelectorAll("input")).find(
            (input) => input.ariaLabel === "First triangle",
        );
        const count = Array.from(panel.querySelectorAll("input")).find(
            (input) => input.ariaLabel === "Triangle count",
        );
        expect(name).not.toBeUndefined();
        expect(start).not.toBeUndefined();
        expect(count).not.toBeUndefined();
        if (!name || !start || !count) throw new Error("Missing face-group controls");
        name.value = "First patch";
        start.value = "0";
        count.value = "1";
        const assign = Array.from(panel.querySelectorAll("button")).find(
            (button) => button.textContent === I18n.translate("analysis.panel.assignGroup"),
        );
        expect(assign).not.toBeUndefined();
        if (!assign) throw new Error("Missing group assignment");
        assign.click();
        await doc.analyses.evaluate(node);
        expect(node.status).toBe("ready");
        expect(source.mesh.semanticFaceGroups[0].name).toBe("First patch");
        const saved = JSON.parse(JSON.stringify(Serializer.serializeObject(source.mesh)));
        const copy = Serializer.deserializeObject(doc, saved) as Mesh;
        expect(copy.semanticFaceGroups).toEqual(source.mesh.semanticFaceGroups);
        doc.history.undo();
        expect(source.mesh.semanticFaceGroups).toEqual([]);
        doc.history.redo();
        expect(source.mesh.semanticFaceGroups[0].name).toBe("First patch");
    } finally {
        panel.remove();
    }
});
