// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import {
    type DataExport,
    type DataExportError,
    type DataExportOptions,
    DocumentRebuilds,
    type INode,
    Result,
    VisualNode,
} from "@spicy3d/core";
import { createMockApplication, createMockDocument } from "@spicy3d/core/test-utils";
import { buildFileTools, EXPORT_REBUILD_WAIT_MS } from "../src/tools/fileTools";

type ExportResult = Result<DataExport, DataExportError>;

function prepare(exportResult: (nodes: VisualNode[], options?: DataExportOptions) => Promise<ExportResult>) {
    const document = createMockDocument();
    const nodes = ["a", "b"].map((id) => {
        const node = Object.create(VisualNode.prototype) as VisualNode;
        Object.defineProperties(node, {
            id: { value: id },
            name: { value: `Body ${id}` },
            parent: { value: document.modelManager.rootNode },
            document: { value: document },
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
            const pending = () =>
                resolve(Result.err({ kind: "rebuild-pending", message: "the model is still rebuilding" }));
            if (signal?.aborted) pending();
            else signal?.addEventListener("abort", pending);
        });
}

const written = async (skipped: string[] = []): Promise<ExportResult> =>
    Result.ok({ data: [new Uint8Array([1, 2])], skipped });

describe("export_nodes while the model rebuilds", () => {
    let releaseJob: (() => void) | undefined;

    function pendingRebuild(document: ReturnType<typeof prepare>["document"]) {
        releaseJob = DocumentRebuilds.add(document, {
            settled: new Promise(() => {}),
            featureIndex: 7,
            flush: () => {},
        });
    }

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
        pendingRebuild(document);

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
    });

    test("counts the time the call waited in the tool queue", async () => {
        rs.useFakeTimers();
        const { tool, document } = prepare(waitsForAbort());
        pendingRebuild(document);
        const queued = 50_000;

        let answered = false;
        const call = tool
            .handler({ format: ".stl binary", ids: ["a"] }, undefined, {
                receivedAt: performance.now() - queued,
            })
            .then((text) => {
                answered = true;
                return JSON.parse(text as string);
            });
        await rs.advanceTimersByTimeAsync(EXPORT_REBUILD_WAIT_MS - queued - 1);
        expect(answered).toBe(false);
        await rs.advanceTimersByTimeAsync(1);

        expect((await call).error).toMatch(/^Rebuild in progress, nothing was exported /);
    });

    test("a cancelled call is reported as cancelled, not as retry advice", async () => {
        const { tool } = prepare(waitsForAbort());
        const controller = new AbortController();

        const call = tool.handler({ format: ".stl binary", ids: ["a"] }, controller.signal);
        controller.abort();
        const result = JSON.parse((await call) as string);

        expect(result.error).toBe(
            "Export cancelled while the model was rebuilding (the model is still rebuilding)",
        );
    });

    test("separate mode waits for every node's rebuild before writing any file", async () => {
        rs.useFakeTimers();
        const { tool, document, exportFile } = prepare(() => written());
        pendingRebuild(document);

        const call = tool.handler({ format: ".stl binary", mode: "separate", delivery: "base64" });
        await rs.advanceTimersByTimeAsync(EXPORT_REBUILD_WAIT_MS);
        const result = JSON.parse((await call) as string);

        expect(exportFile).not.toHaveBeenCalled();
        expect(result.error).toMatch(/^Rebuild in progress, nothing was exported /);
        expect(result.rebuild).toEqual({ pending: 1, featureIndexes: [7] });
    });

    test("separate mode writes every node once the batch's rebuilds settled", async () => {
        const { tool, document, exportFile } = prepare(() => written());
        let settle!: () => void;
        releaseJob = DocumentRebuilds.add(document, {
            settled: new Promise((resolve) => {
                settle = resolve;
            }),
            flush: () => {},
        });

        const call = tool.handler({ format: ".stl binary", mode: "separate", delivery: "base64" });
        await Promise.resolve();
        expect(exportFile).not.toHaveBeenCalled();
        releaseJob();
        releaseJob = undefined;
        settle();
        const result = JSON.parse((await call) as string);

        expect(result.nodes).toEqual(["a", "b"]);
        expect(exportFile).toHaveBeenCalledTimes(2);
    });

    test("a merged export names the nodes it left out", async () => {
        const { tool } = prepare(() => written(["b"]));

        const result = JSON.parse(
            (await tool.handler({ format: ".stl binary", ids: ["a", "b"], delivery: "base64" })) as string,
        );

        expect(result.ok).toBe(true);
        expect(result.nodes).toEqual(["a"]);
        expect(result.skipped).toEqual(["b"]);
        expect(result.warning).toBe(
            "Nodes without geometry after their rebuild were left out; check their rebuild errors",
        );
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

    test("separate mode reports a node's failure with the same message", async () => {
        const { tool } = prepare(async (nodes) =>
            nodes[0].id === "a" ? Result.err({ kind: "failed", message: "BRepMesh failed" }) : written(),
        );

        const result = JSON.parse(
            (await tool.handler({ format: ".stl binary", mode: "separate", delivery: "base64" })) as string,
        );

        expect(result.outputs[0].error).toBe("Export failed: BRepMesh failed");
        expect(result.nodes).toEqual(["b"]);
    });

    test("clears the wait timer once the export finished", async () => {
        rs.useFakeTimers();
        const { tool } = prepare(() => written());

        const result = JSON.parse(
            (await tool.handler({ format: ".stl binary", ids: ["a"], delivery: "base64" })) as string,
        );

        expect(result.ok).toBe(true);
        expect(rs.getTimerCount()).toBe(0);
    });
});
