// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import {
    type DataExportError,
    type DataExportOptions,
    DocumentRebuilds,
    type INode,
    Result,
    VisualNode,
} from "@spicy3d/core";
import { createMockApplication, createMockDocument } from "@spicy3d/core/test-utils";
import { buildFileTools, EXPORT_REBUILD_WAIT_MS } from "../src/tools/fileTools";

type ExportResult = Result<BlobPart[], DataExportError>;

function prepare(exportResult: (nodes: VisualNode[], options?: DataExportOptions) => Promise<ExportResult>) {
    const document = createMockDocument();
    const nodes = ["a", "b"].map((id) => {
        const node = Object.create(VisualNode.prototype) as VisualNode;
        Object.defineProperties(node, {
            id: { value: id },
            name: { value: `Body ${id}` },
            parent: { value: document.modelManager.rootNode },
        });
        return node;
    });
    Object.assign(document.modelManager, {
        findNodes: (filter?: (node: INode) => boolean) => (filter ? nodes.filter(filter) : nodes),
    });
    const exportFile = rs.fn(
        (_format: string, selected: VisualNode[], options?: DataExportOptions): Promise<ExportResult> =>
            exportResult(selected, options),
    );
    const app = createMockApplication();
    Object.assign(app, {
        activeView: { document },
        dataExchange: { exportFormats: () => [".stl binary"], export: rs.fn(), exportResult: exportFile },
    });
    rs.stubGlobal("app", app);
    const tool = buildFileTools().find((candidate) => candidate.name === "export_nodes");
    if (!tool) throw new Error("missing export tool");
    return { tool, document, exportFile };
}

/** Resolves like the real exchange: settled geometry, or `rebuild-pending` once the wait is aborted. */
function waitsForAbort(): (nodes: VisualNode[], options?: DataExportOptions) => Promise<ExportResult> {
    return (_nodes, options) =>
        new Promise((resolve) => {
            const signal = options?.signal;
            expect(signal).toBeInstanceOf(AbortSignal);
            signal?.addEventListener("abort", () =>
                resolve(Result.err({ kind: "rebuild-pending", message: "the model is still rebuilding" })),
            );
        });
}

describe("export_nodes while the model rebuilds", () => {
    let releaseJob: (() => void) | undefined;

    afterEach(() => {
        releaseJob?.();
        releaseJob = undefined;
        rs.useRealTimers();
        rs.restoreAllMocks();
        rs.unstubAllGlobals();
    });

    test("gives up after the bounded wait and tells the agent to retry", async () => {
        rs.useFakeTimers();
        const { tool, document, exportFile } = prepare(waitsForAbort());
        releaseJob = DocumentRebuilds.add(document, {
            settled: new Promise(() => {}),
            featureIndex: 7,
            flush: () => {},
        });

        let answered = false;
        const call = tool.handler({ format: ".stl binary", ids: ["a"], delivery: "base64" }).then((text) => {
            answered = true;
            return JSON.parse(text as string);
        });
        await rs.advanceTimersByTimeAsync(EXPORT_REBUILD_WAIT_MS - 1);
        expect(answered).toBe(false);
        await rs.advanceTimersByTimeAsync(1);
        const result = await call;

        expect(exportFile).toHaveBeenCalledTimes(1);
        expect(result.error).toBe(
            "Rebuild in progress, nothing was exported (the model is still rebuilding); retry export_nodes once get_rebuild_status reports pending 0",
        );
        expect(result.rebuild).toEqual({ pending: 1, featureIndexes: [7] });
        expect(result.error).not.toContain("no exportable geometry");
    });

    test("stops waiting as soon as the call is cancelled", async () => {
        const { tool } = prepare(waitsForAbort());
        const controller = new AbortController();

        const call = tool.handler({ format: ".stl binary", ids: ["a"] }, controller.signal);
        controller.abort();
        const result = JSON.parse((await call) as string);

        expect(result.error).toMatch(/^Rebuild in progress, nothing was exported /);
    });

    test("separate mode stops the batch at the first pending rebuild", async () => {
        rs.useFakeTimers();
        const { tool, exportFile } = prepare(waitsForAbort());

        const call = tool.handler({ format: ".stl binary", mode: "separate", delivery: "base64" });
        await rs.advanceTimersByTimeAsync(EXPORT_REBUILD_WAIT_MS);
        const result = JSON.parse((await call) as string);

        expect(exportFile).toHaveBeenCalledTimes(1);
        expect(result.error).toMatch(/^Rebuild in progress, nothing was exported /);
        expect(result.outputs).toEqual([{ id: "a", filename: "Body a.stl", mimeType: "model/stl" }]);
    });

    test.each([
        {
            error: { kind: "failed", message: "BRepMesh failed" },
            expected: { error: "Export failed: BRepMesh failed" },
        },
        {
            error: {
                kind: "no-geometry",
                message: "No selected node has geometry after its rebuild",
                nodes: ["a"],
            },
            expected: {
                error: "Export failed: No selected node has geometry after its rebuild; check the nodes' rebuild errors",
                nodes: ["a"],
            },
        },
    ] as const)("reports the $error.kind cause instead of a generic message", async ({ error, expected }) => {
        const { tool } = prepare(async () => Result.err(error));

        const result = JSON.parse((await tool.handler({ format: ".stl binary", ids: ["a"] })) as string);

        expect(result).toEqual(expected);
    });

    test("clears the wait timer once the export finished", async () => {
        rs.useFakeTimers();
        const { tool } = prepare(async () => Result.ok([new Uint8Array([1, 2])]));

        const result = JSON.parse(
            (await tool.handler({ format: ".stl binary", ids: ["a"], delivery: "base64" })) as string,
        );

        expect(result.ok).toBe(true);
        expect(rs.getTimerCount()).toBe(0);
    });
});
