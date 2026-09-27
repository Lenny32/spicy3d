// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import {
    type CadExportOptions,
    EditableShapeNode,
    type IDocument,
    type IMeshExporter,
    type INode,
    type IShape,
    type Matrix4,
    PubSub,
    Result,
    type VisualNode,
    XYZ,
} from "@spicy3d/core";
import { createMockDocument, MockShape, TestNode } from "@spicy3d/core/test-utils";
import { DefaultDataExchange } from "../src/defaultDataExchange";

describe("DefaultDataExchange", () => {
    let exchange: DefaultDataExchange;

    beforeEach(() => {
        exchange = new DefaultDataExchange();
    });

    describe("importFormats", () => {
        test("should return supported import formats", () => {
            const formats = exchange.importFormats();
            expect(formats).toContain(".step");
            expect(formats).toContain(".stp");
            expect(formats).toContain(".iges");
            expect(formats).toContain(".igs");
            expect(formats).toContain(".brep");
            expect(formats).toContain(".stl");
        });

        test("should return an array of strings", () => {
            const formats = exchange.importFormats();
            expect(Array.isArray(formats)).toBe(true);
            for (const f of formats) {
                expect(typeof f).toBe("string");
            }
        });
    });

    describe("exportFormats", () => {
        test("should return supported export formats", () => {
            const formats = exchange.exportFormats();
            expect(formats).toContain(".step");
            expect(formats).toContain(".iges");
            expect(formats).toContain(".brep");
            expect(formats).toContain(".stl");
            expect(formats).toContain(".stl binary");
            expect(formats).toContain(".ply");
            expect(formats).toContain(".ply binary");
            expect(formats).toContain(".obj");
        });

        test("should return an array of strings", () => {
            const formats = exchange.exportFormats();
            expect(Array.isArray(formats)).toBe(true);
            for (const f of formats) {
                expect(typeof f).toBe("string");
            }
        });
    });

    describe("extensionIs (private)", () => {
        // NOTE: extensionIs does NOT lowercase internally — the caller
        // (handleSingleFileImport) lowercases the fileName before passing it in.
        test("should match exact extension (already lowercased by caller)", () => {
            expect((exchange as any).extensionIs("model.step", ".step")).toBe(true);
        });

        test("should return false for non-matching extension", () => {
            expect((exchange as any).extensionIs("model.stl", ".step")).toBe(false);
        });

        test("should match against multiple extensions", () => {
            expect((exchange as any).extensionIs("model.stp", ".step", ".stp")).toBe(true);
        });

        test("should return false when none match", () => {
            expect((exchange as any).extensionIs("model.obj", ".step", ".iges")).toBe(false);
        });

        test("should match .stl extension", () => {
            expect((exchange as any).extensionIs("model.stl", ".stl")).toBe(true);
        });

        test("should match .brep extension", () => {
            expect((exchange as any).extensionIs("model.brep", ".brep")).toBe(true);
        });
    });

    describe("handleImportResult (private)", () => {
        afterEach(() => {
            rs.unstubAllGlobals();
        });

        test("should show alert when nodeResult is undefined", () => {
            const alertSpy = rs.fn();
            rs.stubGlobal("alert", alertSpy);

            (exchange as any).handleImportResult(createMockDocument(), "test.step", undefined);

            expect(alertSpy).toHaveBeenCalled();
        });

        test("should show alert when nodeResult is not ok", () => {
            const alertSpy = rs.fn();
            rs.stubGlobal("alert", alertSpy);

            (exchange as any).handleImportResult(createMockDocument(), "test.step", Result.err("some error"));

            expect(alertSpy).toHaveBeenCalled();
        });

        test("should add node and set its name on success", () => {
            const addNodeSpy = rs.fn();
            const updateSpy = rs.fn();
            const node = { name: "" } as unknown as INode;
            const doc = createMockDocument({ modelManager: { addNode: addNodeSpy } });
            doc.visual.update = updateSpy;

            (exchange as any).handleImportResult(doc, "model.step", Result.ok(node));

            expect(node.name).toBe("model.step");
            expect(addNodeSpy).toHaveBeenCalledWith(node);
            expect(updateSpy).toHaveBeenCalled();
        });
    });

    describe("handleExportResult (private)", () => {
        test("should return array with value when result is ok", () => {
            const blobPart = "blob-data";
            const result = (exchange as any).handleExportResult(Result.ok(blobPart));
            expect(result).toEqual([blobPart]);
        });

        test("should return undefined when result is undefined", () => {
            const result = (exchange as any).handleExportResult(undefined);
            expect(result).toBeUndefined();
        });

        test("should return undefined when result is err", () => {
            const result = (exchange as any).handleExportResult(Result.err("error"));
            expect(result).toBeUndefined();
        });
    });

    describe("import", () => {
        test("should handle empty file list", async () => {
            const doc = {
                modelManager: { rootNode: { add: rs.fn() }, addNode: rs.fn() },
                visual: { update: rs.fn() },
            } as unknown as IDocument;
            await expect(exchange.import(doc, [])).resolves.toBeUndefined();
        });
    });

    describe("import routing (handleSingleFileImport)", () => {
        afterEach(() => {
            rs.unstubAllGlobals();
        });

        function setup() {
            const node = { name: "" } as unknown as INode;
            const converter = {
                convertFromBrep: rs.fn((_text: string) => Result.ok(new MockShape({ id: "brep-shape" }))),
                convertFromSTL: rs.fn(
                    (_doc: IDocument, _content: Uint8Array) => Result.ok(node) as Result<INode>,
                ),
                convertFromIGES: rs.fn(
                    (_doc: IDocument, _content: Uint8Array) => Result.ok(node) as Result<INode>,
                ),
                convertFromSTEP: rs.fn(
                    (_doc: IDocument, _content: Uint8Array) => Result.ok(node) as Result<INode>,
                ),
            };
            rs.stubGlobal("shapeConverter", converter);
            const addNodeSpy = rs.fn();
            const updateSpy = rs.fn();
            const doc = createMockDocument({ modelManager: { addNode: addNodeSpy } });
            doc.visual.update = updateSpy;
            return { converter, node, doc, addNodeSpy, updateSpy };
        }

        test("should route .brep through convertFromBrep with the file text", async () => {
            const { converter, doc, addNodeSpy, updateSpy } = setup();

            await exchange.import(doc, [new File(["brep content"], "model.brep")]);

            expect(converter.convertFromBrep).toHaveBeenCalledTimes(1);
            expect(converter.convertFromBrep).toHaveBeenCalledWith("brep content");
            expect(addNodeSpy).toHaveBeenCalledTimes(1);
            const addedNode = addNodeSpy.mock.calls[0][0] as INode;
            expect(addedNode.name).toBe("model.brep");
            expect(updateSpy).toHaveBeenCalledTimes(1);
        });

        test.each([
            { file: "model.step", method: "convertFromSTEP" },
            { file: "model.stp", method: "convertFromSTEP" },
            { file: "model.iges", method: "convertFromIGES" },
            { file: "model.igs", method: "convertFromIGES" },
            { file: "model.stl", method: "convertFromSTL" },
        ] as const)("should route $file to shapeConverter.$method", async ({ file, method }) => {
            const { converter, node, doc, addNodeSpy } = setup();

            await exchange.import(doc, [new File([new Uint8Array([1, 2, 3])], file)]);

            expect(converter[method]).toHaveBeenCalledTimes(1);
            const [docArg, contentArg] = converter[method].mock.calls[0];
            expect(docArg).toBe(doc);
            expect(contentArg).toBeInstanceOf(Uint8Array);
            expect(converter.convertFromBrep).not.toHaveBeenCalled();
            expect(addNodeSpy).toHaveBeenCalledWith(node);
            expect(node.name).toBe(file);
        });

        test("should lowercase the file name before routing", async () => {
            const { converter, node, doc, addNodeSpy } = setup();

            await exchange.import(doc, [new File([new Uint8Array([1])], "MODEL.STEP")]);

            expect(converter.convertFromSTEP).toHaveBeenCalledTimes(1);
            expect(addNodeSpy).toHaveBeenCalledWith(node);
            expect(node.name).toBe("model.step");
        });

        test("should alert and not call any converter for an unsupported extension", async () => {
            const alertSpy = rs.fn();
            rs.stubGlobal("alert", alertSpy);
            const { converter, doc, addNodeSpy } = setup();

            await exchange.import(doc, [new File(["data"], "model.obj")]);

            expect(alertSpy).toHaveBeenCalledTimes(1);
            expect(converter.convertFromBrep).not.toHaveBeenCalled();
            expect(converter.convertFromSTL).not.toHaveBeenCalled();
            expect(converter.convertFromIGES).not.toHaveBeenCalled();
            expect(converter.convertFromSTEP).not.toHaveBeenCalled();
            expect(addNodeSpy).not.toHaveBeenCalled();
        });

        test("should import every file in the list", async () => {
            const { converter, doc, addNodeSpy } = setup();

            await exchange.import(doc, [
                new File(["a"], "a.brep"),
                new File([new Uint8Array([1])], "b.step"),
            ]);

            expect(converter.convertFromBrep).toHaveBeenCalledTimes(1);
            expect(converter.convertFromSTEP).toHaveBeenCalledTimes(1);
            expect(addNodeSpy).toHaveBeenCalledTimes(2);
        });
    });

    describe("export", () => {
        let pubSpy: ReturnType<typeof rs.spyOn>;

        beforeEach(() => {
            pubSpy = rs.spyOn(PubSub.default, "pub").mockImplementation(() => {});
        });

        afterEach(() => {
            pubSpy.mockRestore();
            rs.unstubAllGlobals();
        });

        function createShapeNode(doc: IDocument, name: string) {
            const shape = new MockShape({ id: `${name}-shape` });
            const transformed = new MockShape({ id: `${name}-transformed` });
            const transformedMul = rs.fn((_matrix: Matrix4) => transformed);
            shape.transformedMul = transformedMul;
            const node = new EditableShapeNode({ document: doc, name, shape: Result.ok(shape) });
            return { node, shape, transformed, transformedMul };
        }

        function createDocWithMeshExporter() {
            const doc = createMockDocument();
            const exportToPly = rs.fn(
                (_nodes: VisualNode[], _asciiMode: boolean) => Result.ok("ply-data") as Result<BlobPart>,
            );
            const exportToObj = rs.fn((_nodes: VisualNode[]) => Result.ok("obj-data") as Result<BlobPart>);
            Object.assign(doc.visual, {
                meshExporter: { exportToPly, exportToObj } as unknown as IMeshExporter,
            });
            return { doc, exportToPly, exportToObj };
        }

        function stubShapeConverter() {
            const converter = {
                convertToSTL: rs.fn(
                    (_shapes: IShape[], _options?: { binary: boolean }) =>
                        Result.ok(new Uint8Array([1, 2, 3])) as Result<BlobPart>,
                ),
                convertToSTEP: rs.fn(
                    (_shapes: IShape[], _options?: CadExportOptions) =>
                        Result.ok("step-data") as Result<BlobPart>,
                ),
                convertToIGES: rs.fn(
                    (_shapes: IShape[], _options?: CadExportOptions) =>
                        Result.ok("iges-data") as Result<BlobPart>,
                ),
                convertToBrep: rs.fn((_shape: IShape) => Result.ok("brep-data") as Result<BlobPart>),
            };
            rs.stubGlobal("shapeConverter", converter);
            return converter;
        }

        test("should return undefined for empty nodes array", async () => {
            const result = await exchange.export(".step", []);
            expect(result).toBeUndefined();
        });

        test("should route .ply to meshExporter.exportToPly with asciiMode=true", async () => {
            const { doc, exportToPly, exportToObj } = createDocWithMeshExporter();
            const { node } = createShapeNode(doc, "ply-node");

            const result = await exchange.export(".ply", [node]);

            expect(result).toEqual(["ply-data"]);
            expect(exportToPly).toHaveBeenCalledTimes(1);
            expect(exportToPly).toHaveBeenCalledWith([node], true, { scale: 1 });
            expect(exportToObj).not.toHaveBeenCalled();
        });

        test("should route .ply binary to meshExporter.exportToPly with asciiMode=false", async () => {
            const { doc, exportToPly, exportToObj } = createDocWithMeshExporter();
            const { node } = createShapeNode(doc, "ply-bin-node");

            const result = await exchange.export(".ply binary", [node]);

            expect(result).toEqual(["ply-data"]);
            expect(exportToPly).toHaveBeenCalledTimes(1);
            expect(exportToPly).toHaveBeenCalledWith([node], false, { scale: 1 });
            expect(exportToObj).not.toHaveBeenCalled();
        });

        test("should route .obj to meshExporter.exportToObj", async () => {
            const { doc, exportToPly, exportToObj } = createDocWithMeshExporter();
            const { node } = createShapeNode(doc, "obj-node");

            const result = await exchange.export(".obj", [node]);

            expect(result).toEqual(["obj-data"]);
            expect(exportToObj).toHaveBeenCalledTimes(1);
            expect(exportToObj).toHaveBeenCalledWith([node], { scale: 1 });
            expect(exportToPly).not.toHaveBeenCalled();
        });

        test.each([
            { type: ".stl", binary: false },
            { type: ".stl binary", binary: true },
        ])("should route $type to shapeConverter.convertToSTL with binary=$binary", async ({
            type,
            binary,
        }) => {
            const converter = stubShapeConverter();
            const doc = createMockDocument();
            const { node, transformed, transformedMul } = createShapeNode(doc, "stl-node");

            const result = await exchange.export(type, [node]);

            expect(result).toEqual([new Uint8Array([1, 2, 3])]);
            expect(transformedMul).toHaveBeenCalledTimes(1);
            expect(converter.convertToSTL).toHaveBeenCalledTimes(1);
            expect(converter.convertToSTL).toHaveBeenCalledWith([transformed], { binary });
            expect(converter.convertToSTEP).not.toHaveBeenCalled();
            expect(converter.convertToIGES).not.toHaveBeenCalled();
            expect(converter.convertToBrep).not.toHaveBeenCalled();
        });

        test.each([
            { type: ".step", method: "convertToSTEP", data: "step-data" },
            { type: ".iges", method: "convertToIGES", data: "iges-data" },
        ] as const)("should route $type to shapeConverter.$method with the transformed shape", async ({
            type,
            method,
            data,
        }) => {
            const converter = stubShapeConverter();
            const doc = createMockDocument();
            const { node, transformed, transformedMul } = createShapeNode(doc, "cad-node");

            const result = await exchange.export(type, [node]);

            expect(result).toEqual([data]);
            expect(transformedMul).toHaveBeenCalledTimes(1);
            expect(converter[method]).toHaveBeenCalledTimes(1);
            expect(converter[method]).toHaveBeenCalledWith([transformed], { lengthUnit: "mm" });
            expect(converter.convertToSTL).not.toHaveBeenCalled();
        });

        test("should scale an STL export in cm by 0.1 and keep the physical size", async () => {
            const converter = stubShapeConverter();
            const doc = createMockDocument();
            const { node, transformed } = createShapeNode(doc, "stl-cm");
            const scaled = new MockShape({ id: "stl-cm-scaled" });
            const scale = rs.fn((_matrix: Matrix4) => scaled);
            transformed.transformedMul = scale;

            await exchange.export(".stl", [node], { lengthUnit: "cm" });

            expect(scale).toHaveBeenCalledTimes(1);
            // A 10 mm edge comes out as 1: the file's numbers are centimetres.
            expect(scale.mock.calls[0][0].ofPoint(new XYZ({ x: 10, y: 0, z: 0 })).x).toBeCloseTo(1, 12);
            expect(converter.convertToSTL).toHaveBeenCalledWith([scaled], { binary: false });
        });

        test("should hand STEP its unit instead of scaling the geometry", async () => {
            const converter = stubShapeConverter();
            const doc = createMockDocument();
            const { node, transformed } = createShapeNode(doc, "step-in");
            const scale = rs.fn((_matrix: Matrix4) => new MockShape());
            transformed.transformedMul = scale;

            await exchange.export(".step", [node], { lengthUnit: "in" });

            expect(scale).not.toHaveBeenCalled();
            expect(converter.convertToSTEP).toHaveBeenCalledWith([transformed], { lengthUnit: "in" });
        });

        test("should scale mesh formats through the mesh exporter", async () => {
            const { doc, exportToPly } = createDocWithMeshExporter();
            const node = new EditableShapeNode({
                document: doc,
                name: "ply",
                shape: Result.ok(new MockShape()),
            });

            await exchange.export(".ply", [node], { lengthUnit: "m" });

            expect(exportToPly).toHaveBeenCalledWith([node], true, { scale: 0.001 });
        });

        test.each([
            [".step", "embedded"],
            [".iges", "embedded"],
            [".stl", "none"],
            [".stl binary", "none"],
            [".brep", "none"],
            [".obj", "none"],
            [".ply", "none"],
        ] as const)("should report %s unit handling as %s", (type, kind) => {
            expect(exchange.exportUnitHandling(type).kind).toBe(kind);
        });

        test("should route .brep through shapeFactory.combine then convertToBrep and dispose the compound", async () => {
            const converter = stubShapeConverter();
            const combined = new MockShape({ id: "combined" });
            const disposeSpy = rs.spyOn(combined, "dispose");
            const combine = rs.fn((_shapes: IShape[]) => Result.ok(combined));
            rs.stubGlobal("shapeFactory", { combine });
            const doc = createMockDocument();
            const { node, transformed } = createShapeNode(doc, "brep-node");

            const result = await exchange.export(".brep", [node]);

            expect(result).toEqual(["brep-data"]);
            expect(combine).toHaveBeenCalledTimes(1);
            expect(combine).toHaveBeenCalledWith([transformed]);
            expect(converter.convertToBrep).toHaveBeenCalledTimes(1);
            expect(converter.convertToBrep).toHaveBeenCalledWith(combined);
            expect(disposeSpy).toHaveBeenCalledTimes(1);
        });

        test("should return undefined and not call any exporter for an unknown type", async () => {
            const converter = stubShapeConverter();
            const doc = createMockDocument();
            const exportToPly = rs.fn();
            const exportToObj = rs.fn();
            Object.assign(doc.visual, {
                meshExporter: { exportToPly, exportToObj } as unknown as IMeshExporter,
            });
            const { node } = createShapeNode(doc, "unknown-node");

            const result = await exchange.export(".xyz", [node]);

            expect(result).toBeUndefined();
            expect(converter.convertToSTL).not.toHaveBeenCalled();
            expect(converter.convertToSTEP).not.toHaveBeenCalled();
            expect(converter.convertToIGES).not.toHaveBeenCalled();
            expect(converter.convertToBrep).not.toHaveBeenCalled();
            expect(exportToPly).not.toHaveBeenCalled();
            expect(exportToObj).not.toHaveBeenCalled();
        });

        test("should publish a toast and return undefined when no node is a ShapeNode", async () => {
            const converter = stubShapeConverter();
            const plainNode = new TestNode("plain-visual-node");

            const result = await exchange.export(".step", [plainNode]);

            expect(result).toBeUndefined();
            expect(pubSpy).toHaveBeenCalledWith("showToast", "error.export.noNodeCanBeExported");
            expect(converter.convertToSTEP).not.toHaveBeenCalled();
        });

        test("should filter out non-ShapeNode nodes and export only shape nodes", async () => {
            const converter = stubShapeConverter();
            const doc = createMockDocument();
            const plainNode = new TestNode("plain-visual-node");
            const { node, transformed } = createShapeNode(doc, "real-shape-node");

            const result = await exchange.export(".step", [plainNode, node]);

            expect(result).toEqual(["step-data"]);
            expect(converter.convertToSTEP).toHaveBeenCalledTimes(1);
            expect(converter.convertToSTEP).toHaveBeenCalledWith([transformed], { lengthUnit: "mm" });
            expect(pubSpy).not.toHaveBeenCalledWith("showToast", "error.export.noNodeCanBeExported");
        });
    });
});
