// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { rs } from "@rstest/core";
import { VisualNode } from "@spicy3d/core";
import { createMockApplication, createMockDocument } from "@spicy3d/core/test-utils";
import { createMcpServer } from "../src/mcp/server";
import { buildExportChunkTool, forgetExports, retainExport } from "../src/tools/exportChunks";
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

describe("chunked export delivery", () => {
    afterEach(() => {
        forgetExports("chunks-test");
        rs.restoreAllMocks();
        rs.unstubAllGlobals();
    });

    test.each([
        ".stl binary",
        ".step",
    ])("saves a multi-MB %s through MCP ranges with only metadata in the export result", async (format) => {
        const bytes = new Uint8Array(84 + 50000 * 50);
        for (let i = 84; i < bytes.length; i++) bytes[i] = i % 256;
        new DataView(bytes.buffer).setUint32(80, 50000, true);
        const { tool, download } = prepare([bytes]);
        const server = createMcpServer({
            tools: [tool, buildExportChunkTool()],
            instructions: "x",
            imageByteBudget: () => 8192,
        });
        const client = new Client({ name: "file-client", version: "1" });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        const directory = await mkdtemp(join(tmpdir(), "spicy-export-"));
        try {
            await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
            const call = async (name: string, args: Record<string, unknown>) => {
                const response = await client.callTool({ name, arguments: args });
                expect(response.isError).not.toBe(true);
                expect(new TextEncoder().encode(JSON.stringify(response)).length).toBeLessThanOrEqual(8192);
                const content = response.content as { type: string; text: string }[];
                expect(content[0].type).toBe("text");
                return JSON.parse(content[0].text);
            };
            const metadata = await call("export_nodes", { format, delivery: "chunks" });
            expect(metadata.bytes).toBe(bytes.length);
            expect(metadata.data).toBeUndefined();
            expect(metadata.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
            expect(metadata.triangles).toBe(format === ".stl binary" ? 50000 : undefined);
            expect(JSON.stringify(metadata).length).toBeLessThan(512);
            const path = join(directory, metadata.filename);
            let offset = 0;
            let eof = false;
            while (!eof) {
                const chunk = await call("read_export_chunk", { exportId: metadata.exportId, offset });
                const decoded = Buffer.from(chunk.data, "base64");
                expect(decoded.length).toBe(chunk.bytes);
                expect(chunk.offset).toBe(offset);
                expect(chunk.bytes).toBeGreaterThan(0);
                await writeFile(path, decoded, { flag: offset === 0 ? "w" : "a" });
                offset += chunk.bytes;
                eof = chunk.eof;
            }
            expect(offset).toBe(bytes.length);
            expect(await readFile(path)).toEqual(Buffer.from(bytes));
            expect(await call("read_export_chunk", { exportId: metadata.exportId, release: true })).toEqual({
                ok: true,
                released: true,
            });
            expect(download).not.toHaveBeenCalled();
        } finally {
            await client.close();
            await server.close();
            await rm(directory, { recursive: true, force: true });
        }
    });

    test("keeps exact ranges, supports eof reads and enforces session ownership and release", async () => {
        const { tool } = prepare([Uint8Array.of(0, 255), "é", new Blob(["tail"])]);
        const owner = { caller: "chunks-test" };
        const metadata = JSON.parse(
            (await tool.handler({ format: ".step", delivery: "chunks" }, undefined, owner)) as string,
        );
        const reader = buildExportChunkTool();
        const read = async (args: Record<string, unknown>, caller = owner.caller) =>
            JSON.parse(
                (await reader.handler({ exportId: metadata.exportId, ...args }, undefined, {
                    caller,
                })) as string,
            );
        expect((await read({ offset: 1, length: 3 })).data).toBe("/8Op");
        expect(await read({ offset: 8 })).toMatchObject({ bytes: 0, data: "", eof: true });
        expect((await read({}, "someone-else")).error).toContain("not found");
        for (const args of [
            { offset: -1 },
            { offset: 9 },
            { offset: 0.5 },
            { offset: null },
            { length: 0 },
            { length: 49153 },
            { length: null },
            { release: "true" },
        ]) {
            expect(typeof (await read(args)).error).toBe("string");
        }
        expect(await read({ release: true })).toEqual({ ok: true, released: true });
        expect((await read({})).error).toContain("not found");
    });

    test("a binary STL header beginning with solid still uses its binary triangle count", async () => {
        const bytes = new Uint8Array(84 + 2 * 50);
        bytes.set(new TextEncoder().encode("solid facet normal"));
        new DataView(bytes.buffer).setUint32(80, 2, true);
        const { tool } = prepare([bytes]);
        const result = JSON.parse(
            (await tool.handler({ format: ".stl binary", delivery: "chunks" }, undefined, {
                caller: "chunks-test",
            })) as string,
        );
        expect(result.triangles).toBe(2);
        expect(result.bytes).toBe(bytes.length);
    });

    test("reports ASCII STL triangles and retrieves separate ZIP exports", async () => {
        const { tool } = prepare(["solid p\nfacet normal 0 0 1\nendfacet\nendsolid p"]);
        const owner = { caller: "chunks-test" };
        const ascii = JSON.parse(
            (await tool.handler({ format: ".stl binary", delivery: "chunks" }, undefined, owner)) as string,
        );
        expect(ascii.triangles).toBe(1);
        const zipped = JSON.parse(
            (await tool.handler(
                { format: ".step", delivery: "chunks", mode: "separate" },
                undefined,
                owner,
            )) as string,
        );
        expect(zipped.mimeType).toBe("application/zip");
        expect(zipped.filename).toBe("models.zip");
        expect(zipped.outputs).toEqual([
            { id: "n1", filename: "part.step", mimeType: "model/step", bytes: 46 },
        ]);
        const reader = buildExportChunkTool();
        const chunk = JSON.parse(
            (await reader.handler({ exportId: zipped.exportId }, undefined, owner)) as string,
        );
        const { default: JSZip } = await import("jszip");
        const zip = await JSZip.loadAsync(Buffer.from(chunk.data, "base64"));
        expect(await zip.file("part.step")!.async("string")).toBe(
            "solid p\nfacet normal 0 0 1\nendfacet\nendsolid p",
        );
    });

    test("refuses metadata that cannot fit the relay", async () => {
        const { tool } = prepare(["abc"]);
        const limited = JSON.parse(
            await withImageByteBudget(
                100,
                async () =>
                    (await tool.handler({ format: ".step", delivery: "chunks" }, undefined, {
                        caller: "chunks-test",
                    })) as string,
            ),
        );
        expect(limited).toEqual({ error: "Export metadata exceeds the relay response limit" });
    });

    test("expires and forgets retained exports", async () => {
        const { tool } = prepare(["abc"]);
        const owner = { caller: "chunks-test" };
        const create = async () =>
            JSON.parse(
                (await tool.handler({ format: ".step", delivery: "chunks" }, undefined, owner)) as string,
            );
        const reader = buildExportChunkTool();
        const first = await create();
        forgetExports(owner.caller);
        expect(
            JSON.parse((await reader.handler({ exportId: first.exportId }, undefined, owner)) as string)
                .error,
        ).toContain("not found");
        const second = await create();
        const read = JSON.parse(
            (await reader.handler({ exportId: second.exportId }, undefined, owner)) as string,
        );
        expect(read.data).toBe(btoa("abc"));
        const now = Date.now();
        rs.spyOn(Date, "now").mockReturnValue(now + 600001);
        expect(
            JSON.parse((await reader.handler({ exportId: second.exportId }, undefined, owner)) as string)
                .error,
        ).toContain("expired");
    });

    test("successful reads extend expiry, but rejected reads do not", async () => {
        const owner = { caller: "chunks-test" };
        const clock = rs.spyOn(Date, "now").mockReturnValue(1000);
        const metadata = JSON.parse(
            await retainExport(
                new Blob(["abc"]),
                { filename: "a.step", mimeType: "model/step", bytes: 3 },
                3,
                owner.caller,
            ),
        );
        const reader = buildExportChunkTool();
        clock.mockReturnValue(500000);
        const first = JSON.parse(
            (await reader.handler({ exportId: metadata.exportId }, undefined, owner)) as string,
        );
        expect(first.data).toBe(btoa("abc"));
        clock.mockReturnValue(700000);
        const second = JSON.parse(
            (await reader.handler({ exportId: metadata.exportId }, undefined, owner)) as string,
        );
        expect(second.data).toBe(first.data);
        clock.mockReturnValue(1200000);
        const rejected = JSON.parse(
            (await reader.handler({ exportId: metadata.exportId, offset: -1 }, undefined, owner)) as string,
        );
        expect(rejected.error).toContain("offset");
        clock.mockReturnValue(1300001);
        const expired = JSON.parse(
            (await reader.handler({ exportId: metadata.exportId }, undefined, owner)) as string,
        );
        expect(expired.error).toContain("expired");
    });

    test("rejects size, cache and relay limits without inline bytes", async () => {
        const { tool } = prepare(["abc"]);
        const owner = { caller: "chunks-test" };
        const limited = JSON.parse(
            (await tool.handler(
                { format: ".step", delivery: "chunks", maxBytes: 2 },
                undefined,
                owner,
            )) as string,
        );
        expect(limited).toMatchObject({ error: "Export exceeds maxBytes", bytes: 3, maxBytes: 2 });
        const metadata = JSON.parse(
            (await tool.handler({ format: ".step", delivery: "chunks" }, undefined, owner)) as string,
        );
        const reader = buildExportChunkTool();
        const tiny = JSON.parse(
            await withImageByteBudget(
                10,
                async () =>
                    (await reader.handler({ exportId: metadata.exportId }, undefined, owner)) as string,
            ),
        );
        expect(tiny.error).toContain("cannot fit");
        expect(tiny.data).toBeUndefined();
        const tooBig = new Blob([new Uint8Array(32 * 1024 * 1024 + 1)]);
        expect(
            JSON.parse(
                await retainExport(
                    tooBig,
                    { filename: "big.step", mimeType: "model/step", bytes: tooBig.size },
                    32 * 1024 * 1024,
                    owner.caller,
                ),
            ).error,
        ).toContain("maxBytes");
        const full = new Blob([new Uint8Array(32 * 1024 * 1024)]);
        const details = { filename: "big.step", mimeType: "model/step", bytes: full.size };
        forgetExports(owner.caller);
        const first = JSON.parse(await retainExport(full, details, full.size, owner.caller));
        const second = JSON.parse(await retainExport(full, details, full.size, "other-agent"));
        expect(first.delivery).toBe("chunks");
        expect(second.delivery).toBe("chunks");
        forgetExports("other-agent");
        expect(
            JSON.parse(await retainExport(new Blob(["x"]), { ...details, bytes: 1 }, 1, owner.caller)).error,
        ).toContain("cache is full");
    });
});
