// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import {
    type CadExportOptions,
    EditableShapeNode,
    type IDocument,
    type IMeshExporter,
    type INode,
    type IndexedMesh,
    type IShape,
    Material,
    type Matrix4,
    PubSub,
    Result,
    type StlExportOptions,
    type StlTessellationOptions,
    type VisualNode,
    XYZ,
} from "@spicy3d/core";
import { createMockDocument, MockShape, TestNode } from "@spicy3d/core/test-utils";
import { DefaultDataExchange } from "../src/defaultDataExchange";

const TRIANGLE_MESH: IndexedMesh = {
    vertices: new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    triangles: new Uint32Array([0, 1, 2]),
};

async function read3mfModel(data: BlobPart[] | undefined): Promise<Document> {
    expect(data).toHaveLength(1);
    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(data![0] as Uint8Array);
    const xml = await zip.file("3D/3dmodel.model")!.async("string");
    return new DOMParser().parseFromString(xml, "application/xml");
}

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
            expect(formats).toContain(".3mf");
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
                    (_shapes: IShape[], _options?: StlExportOptions) =>
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
                convertToIndexedMesh: rs.fn(
                    (_shape: IShape, _options?: StlTessellationOptions): Result<IndexedMesh> =>
                        Result.ok(TRIANGLE_MESH),
                ),
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

        test.each([
            ".stl",
            ".stl binary",
        ])("scales mm tolerance into cm for %s and preserves angular degrees", async (type) => {
            const converter = stubShapeConverter();
            const doc = createMockDocument();
            const { node, transformed } = createShapeNode(doc, "stl-cm-tolerance");
            const scaled = new MockShape({ id: "scaled" });
            transformed.transformedMul = rs.fn((_matrix: Matrix4) => scaled);
            const result = await exchange.export(type, [node], {
                lengthUnit: "cm",
                stl: { linearTolerance: 0.2, angularTolerance: 6 },
            });
            expect(result).toEqual([new Uint8Array([1, 2, 3])]);
            expect(converter.convertToSTL).toHaveBeenCalledWith([scaled], {
                binary: type === ".stl binary",
                linearTolerance: 0.020000000000000004,
                angularTolerance: 6,
            });
        });

        test("refuses invalid tolerance and non-STL tolerance before kernel work", async () => {
            const converter = stubShapeConverter();
            const doc = createMockDocument();
            const { node, transformedMul } = createShapeNode(doc, "invalid-tolerance");
            expect(await exchange.export(".stl", [node], { stl: { linearTolerance: -1 } })).toBeUndefined();
            expect(await exchange.export(".step", [node], { stl: { angularTolerance: 5 } })).toBeUndefined();
            expect(transformedMul).not.toHaveBeenCalled();
            expect(converter.convertToSTL).not.toHaveBeenCalled();
            expect(converter.convertToSTEP).not.toHaveBeenCalled();
            expect(pubSpy).toHaveBeenCalledWith(
                "showToast",
                "error.default:{0}",
                expect.stringContaining("linearTolerance"),
            );
            expect(pubSpy).toHaveBeenCalledWith(
                "showToast",
                "error.default:{0}",
                expect.stringContaining("only to STL"),
            );
        });

        test("returns the kernel's error to exportResult callers and toasts it from export", async () => {
            const converter = stubShapeConverter();
            converter.convertToSTL.mockReturnValue(Result.err("BRepMesh failed"));
            const doc = createMockDocument();
            const { node } = createShapeNode(doc, "mesh-failure");

            const result = await exchange.exportResult(".stl binary", [node]);

            expect(result.isOk).toBe(false);
            expect(result.error).toEqual({ kind: "failed", message: "BRepMesh failed" });
            expect(pubSpy).not.toHaveBeenCalled();
            expect(await exchange.export(".stl binary", [node])).toBeUndefined();
            expect(pubSpy).toHaveBeenCalledWith("showToast", "error.default:{0}", "BRepMesh failed");
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

        describe(".3mf", () => {
            test("writes one named object per node, meshed from the transformed shape", async () => {
                const converter = stubShapeConverter();
                const doc = createMockDocument();
                const a = createShapeNode(doc, "Bracket");
                const b = createShapeNode(doc, "Lid");

                const result = await exchange.export(".3mf", [a.node, b.node]);

                expect(converter.convertToIndexedMesh.mock.calls.map((call) => call[0])).toEqual([
                    a.transformed,
                    b.transformed,
                ]);
                expect(converter.convertToSTL).not.toHaveBeenCalled();
                const model = await read3mfModel(result);
                expect(model.documentElement.getAttribute("unit")).toBe("millimeter");
                const objects = Array.from(model.getElementsByTagName("object"));
                expect(objects.map((object) => object.getAttribute("name"))).toEqual(["Bracket", "Lid"]);
                expect(model.getElementsByTagName("item")).toHaveLength(2);
                const metadata = Array.from(model.getElementsByTagName("metadata")).map((entry) =>
                    entry.getAttribute("name"),
                );
                expect(metadata).toEqual(["Title", "Application", "CreationDate"]);
            });

            test.each([
                { unit: "cm", name: "centimeter", factor: 0.1 },
                { unit: "in", name: "inch", factor: 1 / 25.4 },
            ] as const)("records $unit in the file and scales the vertices to it", async ({
                unit,
                name,
                factor,
            }) => {
                const converter = stubShapeConverter();
                const doc = createMockDocument();
                const { node, transformed } = createShapeNode(doc, "cube");
                const scaled = new MockShape({ id: "scaled" });
                const scale = rs.fn((_matrix: Matrix4) => scaled);
                transformed.transformedMul = scale;

                const result = await exchange.export(".3mf", [node], { lengthUnit: unit });

                expect((await read3mfModel(result)).documentElement.getAttribute("unit")).toBe(name);
                // A 20 mm edge is written as 20 mm in the declared unit.
                expect(scale.mock.calls[0][0].ofPoint(new XYZ({ x: 20, y: 0, z: 0 })).x).toBeCloseTo(
                    20 * factor,
                    12,
                );
                expect(converter.convertToIndexedMesh).toHaveBeenCalledWith(scaled, undefined);
            });

            test("accepts custom tolerances, in millimetres scaled to the export unit", async () => {
                const converter = stubShapeConverter();
                const doc = createMockDocument();
                const { node } = createShapeNode(doc, "tolerance");

                const result = await exchange.export(".3mf", [node], {
                    lengthUnit: "cm",
                    stl: { linearTolerance: 0.2, angularTolerance: 6 },
                });

                expect(result).toHaveLength(1);
                expect(converter.convertToIndexedMesh.mock.calls[0][1]).toEqual({
                    linearTolerance: 0.020000000000000004,
                    angularTolerance: 6,
                });
            });

            test("colours each object by its node's first material", async () => {
                stubShapeConverter();
                const doc = createMockDocument();
                const red = new Material({ document: doc, name: "Red PLA", color: 0xff0000 });
                const blue = new Material({ document: doc, name: "Blue PETG", color: "#0000ffcc" });
                doc.modelManager.materials.push(red, blue);
                const a = createShapeNode(doc, "a");
                const b = createShapeNode(doc, "b");
                const c = createShapeNode(doc, "c");
                a.node.materialId = red.id;
                b.node.materialId = [blue.id, red.id];
                c.node.materialId = "unknown";

                const model = await read3mfModel(await exchange.export(".3mf", [a.node, b.node, c.node]));

                const bases = Array.from(model.getElementsByTagName("base")).map((base) => [
                    base.getAttribute("name"),
                    base.getAttribute("displaycolor"),
                ]);
                expect(bases).toEqual([
                    ["Red PLA", "#FF0000"],
                    ["Blue PETG", "#0000FF"],
                ]);
                const objects = Array.from(model.getElementsByTagName("object"));
                expect(objects.map((object) => object.getAttribute("pindex"))).toEqual(["0", "1", null]);
            });

            test("skips nodes whose shape meshes to no triangles", async () => {
                const converter = stubShapeConverter();
                const doc = createMockDocument();
                const solid = createShapeNode(doc, "solid");
                const wire = createShapeNode(doc, "wire");
                converter.convertToIndexedMesh.mockImplementation((shape: IShape) =>
                    Result.ok(
                        shape === wire.transformed
                            ? { vertices: new Float64Array(), triangles: new Uint32Array() }
                            : TRIANGLE_MESH,
                    ),
                );

                const result = await exchange.exportResult(".3mf", [solid.node, wire.node]);

                expect(result.isOk).toBe(true);
                expect(result.value.skipped).toEqual([wire.node.id]);
                const model = await read3mfModel(result.value.data);
                const names = Array.from(model.getElementsByTagName("object")).map((object) =>
                    object.getAttribute("name"),
                );
                expect(names).toEqual(["solid"]);

                const none = await exchange.exportResult(".3mf", [wire.node]);
                expect(none.isOk).toBe(false);
                expect(none.error).toMatchObject({ kind: "no-geometry", nodes: [wire.node.id] });
            });

            test("returns the mesher's error unchanged", async () => {
                const converter = stubShapeConverter();
                converter.convertToIndexedMesh.mockReturnValue(Result.err("BRepMesh failed"));
                const doc = createMockDocument();
                const { node } = createShapeNode(doc, "mesh-failure");

                const result = await exchange.exportResult(".3mf", [node]);

                expect(result.isOk).toBe(false);
                expect(result.error).toEqual({ kind: "failed", message: "BRepMesh failed" });
            });
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
            [".3mf", "embedded"],
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
