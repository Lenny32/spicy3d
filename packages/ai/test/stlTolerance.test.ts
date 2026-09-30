// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import { type DataExportOptions, VisualNode } from "@spicy3d/core";
import { createMockApplication, createMockDocument } from "@spicy3d/core/test-utils";
import { buildFileTools } from "../src/tools/fileTools";

function prepare() {
    const node = Object.create(VisualNode.prototype) as VisualNode;
    Object.defineProperties(node, { id: { value: "n1" }, name: { value: "part" } });
    const document = createMockDocument();
    Object.assign(document.modelManager, { findNodes: rs.fn(() => [node]) });
    const exportFile = rs.fn(async (_format: string, _nodes: VisualNode[], _options?: DataExportOptions) => [
        "stl",
    ]);
    const app = createMockApplication();
    Object.assign(app, {
        activeView: { document },
        dataExchange: {
            exportFormats: () => [".stl", ".stl binary", ".step"],
            export: exportFile,
        },
    });
    rs.stubGlobal("app", app);
    return { tool: buildFileTools()[0], node, exportFile };
}

afterEach(() => {
    rs.unstubAllGlobals();
});

test.each(["merged", "separate"])("passes STL tolerances to every %s output", async (mode) => {
    const { tool, node, exportFile } = prepare();
    const result = JSON.parse(
        (await tool.handler({
            format: ".stl binary",
            mode,
            delivery: "base64",
            linearTolerance: 0.05,
            angularTolerance: 5,
        })) as string,
    );
    expect(result.ok).toBe(true);
    expect(exportFile).toHaveBeenCalledTimes(1);
    expect(exportFile).toHaveBeenCalledWith(".stl binary", [node], {
        stl: { linearTolerance: 0.05, angularTolerance: 5 },
    });
});

test.each([
    { linearTolerance: 0 },
    { linearTolerance: -1 },
    { linearTolerance: Number.NaN },
    { linearTolerance: Number.POSITIVE_INFINITY },
    { linearTolerance: "0.1" },
    { angularTolerance: 0 },
    { angularTolerance: -10 },
    { angularTolerance: 181 },
    { angularTolerance: Number.NaN },
    { angularTolerance: Number.POSITIVE_INFINITY },
    { angularTolerance: "10" },
])("refuses invalid tolerance %j before exporting", async (options) => {
    const { tool, exportFile } = prepare();
    const result = JSON.parse(
        (await tool.handler({ format: ".stl", delivery: "base64", ...options })) as string,
    );
    expect(result.error).toContain("Tolerance must be a finite number");
    expect(exportFile).not.toHaveBeenCalled();
});

test("rejects STL tolerances on another format", async () => {
    const { tool, exportFile } = prepare();
    const result = JSON.parse((await tool.handler({ format: ".step", linearTolerance: 0.1 })) as string);
    expect(result.error).toContain("only to STL");
    expect(exportFile).not.toHaveBeenCalled();
});
