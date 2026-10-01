// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import { VisualNode } from "@spicy3d/core";
import { createMockApplication, createMockDocument } from "@spicy3d/core/test-utils";
import { buildFileTools } from "../src/tools/fileTools";
import { withImageByteBudget } from "../src/tools/imageEncoding";

function prepare(data: BlobPart[] = [Uint8Array.of(0, 255), "é", new Blob(["tail"])]) {
    const node = Object.create(VisualNode.prototype) as VisualNode;
    Object.defineProperties(node, { id: { value: "n1" }, name: { value: "part" } });
    const document = createMockDocument();
    Object.assign(document.modelManager, { findNodes: rs.fn(() => [node]) });
    const exportFile = rs.fn(async (_format: string, _nodes: VisualNode[]) => data);
    const app = createMockApplication();
    Object.assign(app, {
        activeView: { document },
        dataExchange: { exportFormats: () => [".step", ".stl binary", ".brep"], export: exportFile },
    });
    rs.stubGlobal("app", app);
    const download = rs.spyOn(URL, "createObjectURL").mockReturnValue("blob:export-test");
    rs.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const tool = buildFileTools().find((candidate) => candidate.name === "export_nodes");
    expect(tool).not.toBeUndefined();
    if (!tool) throw new Error("export tool missing");
    return { tool, exportFile, download };
}

describe("MCP export byte delivery", () => {
    afterEach(() => {
        rs.restoreAllMocks();
        rs.unstubAllGlobals();
    });

    test("returns exact mixed binary/UTF-8/blob bytes with metadata and no download", async () => {
        const { tool, download } = prepare();
        const result = JSON.parse((await tool.handler({ format: ".step", delivery: "base64" })) as string);
        expect(result).toEqual({
            ok: true,
            filename: "part.step",
            mimeType: "model/step",
            bytes: 8,
            nodes: ["n1"],
            encoding: "base64",
            data: "AP/DqXRhaWw=",
        });
        expect(download).not.toHaveBeenCalled();
    });

    test.each([
        [".stl binary", "model/stl", "part.stl"],
        [".brep", "application/octet-stream", "part.brep"],
    ])("reports metadata for %s", async (format, mimeType, filename) => {
        const { tool } = prepare(["x"]);
        const result = JSON.parse((await tool.handler({ format, delivery: "base64" })) as string);
        expect(result.mimeType).toBe(mimeType);
        expect(result.filename).toBe(filename);
        expect(result.data).toBe("eA==");
    });

    test("keeps default browser download", async () => {
        const { tool, download } = prepare(["abc"]);
        const result = JSON.parse((await tool.handler({ format: ".step" })) as string);
        expect(result.ok).toBe(true);
        expect(result.bytes).toBe(3);
        expect(result.data).toBeUndefined();
        expect(download).toHaveBeenCalledTimes(1);
    });

    test("accepts the exact decoded-byte boundary and refuses excess without downloading", async () => {
        const { tool, download } = prepare(["abc"]);
        const exact = JSON.parse(
            (await tool.handler({ format: ".step", delivery: "base64", maxBytes: 3 })) as string,
        );
        expect(exact.data).toBe("YWJj");
        const excess = JSON.parse(
            (await tool.handler({ format: ".step", delivery: "base64", maxBytes: 2 })) as string,
        );
        expect(excess.error).toContain("exceeds maxBytes");
        expect(excess.bytes).toBe(3);
        expect(excess.maxBytes).toBe(2);
        expect(excess.data).toBeUndefined();
        expect(download).not.toHaveBeenCalled();
    });

    test.each([
        { delivery: "path" },
        { delivery: null },
        { maxBytes: null },
        { maxBytes: 0 },
        { maxBytes: 1.5 },
        { maxBytes: 8388609 },
        { maxBytes: NaN },
        { maxBytes: "100" },
        { filename: "C:\\tmp\\part.step" },
        { filename: "../part.step" },
        { filename: 23 },
        { filename: "bad\nname.step" },
    ])("rejects invalid delivery options before export: %j", async (options) => {
        const { tool, exportFile, download } = prepare();
        const result = JSON.parse((await tool.handler({ format: ".step", ...options })) as string);
        expect(typeof result.error).toBe("string");
        expect(exportFile).not.toHaveBeenCalled();
        expect(download).not.toHaveBeenCalled();
    });

    test("bounds the escaped relay response and restores the budget after the call", async () => {
        const { tool, download } = prepare(["abc"]);
        const limited = JSON.parse(
            await withImageByteBudget(
                100,
                async () => (await tool.handler({ format: ".step", delivery: "base64" })) as string,
            ),
        );
        expect(limited.error).toContain("relay response limit");
        expect(limited.responseBytes).toBeGreaterThan(100);
        expect(limited.data).toBeUndefined();
        const normal = JSON.parse((await tool.handler({ format: ".step", delivery: "base64" })) as string);
        expect(normal.data).toBe("YWJj");
        expect(download).not.toHaveBeenCalled();
    });
});
