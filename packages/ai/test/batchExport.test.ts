// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import { type INode, VisualNode } from "@spicy3d/core";
import { createMockApplication, createMockDocument } from "@spicy3d/core/test-utils";
import JSZip from "jszip";
import { buildFileTools } from "../src/tools/fileTools";

function prepare(failures: string[] = []) {
    const document = createMockDocument();
    const nodes = [
        ["a", "Part"],
        ["b", "part"],
        ["c", "folder/third"],
    ].map(([id, name]) => {
        const node = Object.create(VisualNode.prototype) as VisualNode;
        Object.defineProperties(node, {
            id: { value: id },
            name: { value: name },
            parent: { value: document.modelManager.rootNode },
        });
        return node;
    });
    Object.assign(document.modelManager, {
        findNodes: (filter?: (node: INode) => boolean) => (filter ? nodes.filter(filter) : nodes),
    });
    const exportFile = rs.fn(
        async (_format: string, selected: VisualNode[]): Promise<BlobPart[] | undefined> => {
            if (failures.includes(selected[0].id)) {
                if (selected[0].id === "b") throw new Error("native error");
                return undefined;
            }
            return [Uint8Array.of(0, 255), selected[0].id];
        },
    );
    const app = createMockApplication();
    Object.assign(app, {
        activeView: { document },
        dataExchange: { exportFormats: () => [".step"], export: exportFile },
    });
    rs.stubGlobal("app", app);
    const download = rs.spyOn(URL, "createObjectURL").mockReturnValue("blob:batch-test");
    rs.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const tool = buildFileTools().find((candidate) => candidate.name === "export_nodes");
    expect(tool).not.toBeUndefined();
    if (!tool) throw new Error("missing export tool");
    return { tool, exportFile, download, nodes };
}

describe("separate MCP model exports", () => {
    afterEach(() => {
        rs.restoreAllMocks();
        rs.unstubAllGlobals();
    });

    test("returns one archive with distinct exact files and deterministic safe names", async () => {
        const { tool, exportFile, download, nodes } = prepare();
        const result = JSON.parse(
            (await tool.handler({ format: ".step", mode: "separate", delivery: "base64" })) as string,
        );
        expect(result.ok).toBe(true);
        expect(result.filename).toBe("models.zip");
        expect(result.mimeType).toBe("application/zip");
        expect(result.nodes).toEqual(["a", "b", "c"]);
        const archive = await JSZip.loadAsync(result.data, { base64: true });
        expect(Object.keys(archive.files)).toEqual(["Part.step", "part (2).step", "folder_third.step"]);
        for (const [index, filename] of Object.keys(archive.files).entries()) {
            const bytes = await archive.files[filename].async("uint8array");
            expect(Array.from(bytes)).toEqual([0, 255, nodes[index].id.charCodeAt(0)]);
        }
        expect(result.outputs).toEqual([
            { id: "a", filename: "Part.step", mimeType: "model/step", bytes: 3 },
            { id: "b", filename: "part (2).step", mimeType: "model/step", bytes: 3 },
            { id: "c", filename: "folder_third.step", mimeType: "model/step", bytes: 3 },
        ]);
        expect(exportFile.mock.calls.map((call) => call[1].map((node) => node.id))).toEqual([
            ["a"],
            ["b"],
            ["c"],
        ]);
        expect(download).not.toHaveBeenCalled();
    });

    test("downloads just one named archive", async () => {
        const { tool, download } = prepare();
        const result = JSON.parse(
            (await tool.handler({ format: ".step", mode: "separate", filename: "parts" })) as string,
        );
        expect(result.filename).toBe("parts.zip");
        expect(result.outputs).toHaveLength(3);
        expect(download).toHaveBeenCalledTimes(1);
        const blob = download.mock.calls[0][0];
        expect(blob).toBeInstanceOf(Blob);
        if (!(blob instanceof Blob)) throw new Error("expected an archive Blob");
        const archive = await JSZip.loadAsync(await blob.arrayBuffer());
        expect(Object.keys(archive.files)).toHaveLength(3);
    });

    test("reports missing, thrown and failed outputs while retaining successful files", async () => {
        const { tool, download } = prepare(["b", "c"]);
        const result = JSON.parse(
            (await tool.handler({
                format: ".step",
                mode: "separate",
                delivery: "base64",
                ids: ["missing", "b", "a", "c"],
            })) as string,
        );
        expect(result.nodes).toEqual(["a"]);
        expect(
            result.outputs.map((output: { id: string; error?: string }) => [output.id, output.error]),
        ).toEqual([
            ["missing", "Node not found"],
            ["b", "Export failed"],
            ["a", undefined],
            ["c", "Export failed: no exportable geometry for this format"],
        ]);
        const archive = await JSZip.loadAsync(result.data, { base64: true });
        expect(Object.keys(archive.files)).toEqual(["Part.step"]);
        expect(download).not.toHaveBeenCalled();
    });

    test("returns every error and creates no empty archive when all exports fail", async () => {
        const { tool, download } = prepare(["a", "b", "c"]);
        const result = JSON.parse((await tool.handler({ format: ".step", mode: "separate" })) as string);
        expect(result.error).toBe("No batch outputs exported");
        expect(result.outputs).toHaveLength(3);
        expect(result.outputs.every((output: { error?: string }) => typeof output.error === "string")).toBe(
            true,
        );
        expect(download).not.toHaveBeenCalled();
    });

    test("reports completed outputs and stops before archiving when the byte limit is exceeded", async () => {
        const { tool, download } = prepare();
        const result = JSON.parse(
            (await tool.handler({
                format: ".step",
                mode: "separate",
                delivery: "base64",
                maxBytes: 1,
            })) as string,
        );
        expect(result.error).toContain("exceeds maxBytes");
        expect(result.outputs).toHaveLength(1);
        expect(result.bytes).toBeGreaterThan(1);
        expect(result.data).toBeUndefined();
        expect(download).not.toHaveBeenCalled();
    });

    test.each([
        { mode: "invalid" },
        { mode: null },
        { mode: "separate", ids: "a" },
        { mode: "separate", ids: [1] },
    ])("rejects malformed batch options before geometry export: %j", async (options) => {
        const { tool, exportFile } = prepare();
        const result = JSON.parse((await tool.handler({ format: ".step", ...options })) as string);
        expect(typeof result.error).toBe("string");
        expect(exportFile).not.toHaveBeenCalled();
    });
});

test("batch export rejects excessive ids and stops at the uncompressed byte budget", async () => {
    const { tool, exportFile } = prepare();
    try {
        const excessive = JSON.parse(
            (await tool.handler({ format: ".step", mode: "separate", ids: Array(257).fill("a") })) as string,
        );
        expect(excessive.error).toContain("256");
        expect(exportFile).not.toHaveBeenCalled();
        const limited = JSON.parse(
            (await tool.handler({ format: ".step", mode: "separate", maxBytes: 4 })) as string,
        );
        expect(limited.error).toContain("before archiving");
        expect(exportFile).toHaveBeenCalledTimes(2);
        expect(limited.bytes).toBe(6);
    } finally {
        rs.restoreAllMocks();
        rs.unstubAllGlobals();
    }
});
