// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import { type IDocument, Mesh, MeshNode, type ReferenceMeshImportOptions, Result } from "@spicy3d/core";
import { createMockApplication, createMockDocument } from "@spicy3d/core/test-utils";
import { buildReferenceMeshImportTool } from "../src/tools/fileTools";

describe("import_reference_mesh", () => {
    afterEach(() => {
        rs.unstubAllGlobals();
    });

    function setup() {
        const document = createMockDocument();
        const node = new MeshNode({
            document,
            name: "scan.stl",
            mesh: new Mesh({ meshType: "surface", position: new Float32Array(9) }),
        });
        const importer = rs.fn(
            async (
                _document: IDocument,
                _file: File,
                _options?: ReferenceMeshImportOptions,
            ): Promise<Result<MeshNode>> => Result.ok(node),
        );
        const application = createMockApplication({ dataExchange: { importReferenceMesh: importer } });
        Object.defineProperty(application, "activeView", { value: { document } });
        rs.stubGlobal("app", application);
        return { importer, document, tool: buildReferenceMeshImportTool(), node };
    }

    test("decodes STL bytes and passes validated placement and appearance options", async () => {
        const { importer, document, tool, node } = setup();
        const response = JSON.parse(
            (await tool.handler({
                filename: "scan.stl",
                base64: btoa("solid bytes"),
                lengthUnit: "cm",
                translation: [1, 2, 3],
                visible: false,
                opacity: 0.2,
            })) as string,
        );
        expect(response).toEqual({ ok: true, id: node.id, name: "scan.stl", triangles: 1, lengthUnit: "cm" });
        expect(importer).toHaveBeenCalledTimes(1);
        const [passedDocument, file, options] = importer.mock.calls[0];
        expect(passedDocument).toBe(document);
        expect(await file.text()).toBe("solid bytes");
        expect(file.type).toBe("model/stl");
        expect(options?.lengthUnit).toBe("cm");
        expect(options?.opacity).toBe(0.2);
        expect(options?.visible).toBe(false);
        expect(options?.transform?.translationPart()).toMatchObject({ x: 1, y: 2, z: 3 });
    });

    test.each([
        ["unsupported filename", { filename: "scan.obj" }],
        ["data URL", { base64: "data:model/stl;base64,YWJj" }],
        ["base64 characters", { base64: "%%%=" }],
        ["base64 length", { base64: "YWJ" }],
        ["over size limit", { base64: "A".repeat(Math.ceil((32 * 1024 * 1024) / 3) * 4 + 4) }],
        ["unit", { lengthUnit: "ft" }],
        ["non-finite placement", { translation: [0, Number.NaN, 0] }],
        ["placement length", { translation: [0, 0] }],
        ["opacity", { opacity: 2 }],
        ["visibility", { visible: "false" }],
    ])("rejects %s before importing", async (_label, invalid) => {
        const { importer, tool } = setup();
        const response = JSON.parse(
            (await tool.handler({
                filename: "scan.stl",
                base64: btoa("solid bytes"),
                ...(invalid as Record<string, unknown>),
            })) as string,
        );
        expect(typeof response.error).toBe("string");
        expect(importer).not.toHaveBeenCalled();
    });

    test("returns parser errors without claiming import success", async () => {
        const { importer, tool } = setup();
        importer.mockResolvedValueOnce(Result.err("Invalid STL facet"));
        const response = JSON.parse(
            (await tool.handler({ filename: "scan.stl", base64: btoa("malformed") })) as string,
        );
        expect(response).toEqual({ error: "Invalid STL facet" });
    });

    test("refuses mutation of a read-only document", async () => {
        const { importer, document, tool } = setup();
        document.repository.isReadOnly = () => true;
        const response = JSON.parse(
            (await tool.handler({ filename: "scan.stl", base64: btoa("solid bytes") })) as string,
        );
        expect(response).toEqual({ error: "Document is read-only" });
        expect(importer).not.toHaveBeenCalled();
    });
});
