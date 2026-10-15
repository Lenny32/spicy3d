// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    awaitExportRebuilds,
    buildSvgShape,
    type DataExport,
    type DataExportError,
    type DataExportOptions,
    EditableShapeNode,
    type ExportUnitHandling,
    exportLengthUnit,
    fromMillimetres,
    I18n,
    type IDataExchange,
    type IDocument,
    type INode,
    type IShape,
    isLengthUnit,
    isMeshedExportFormat,
    type LengthUnit,
    lengthUnitFactor,
    Material,
    Matrix4,
    MESHED_EXPORT_ONLY_ERROR,
    type Mesh,
    MeshNode,
    PubSub,
    parseSvg,
    type ReferenceMeshImportOptions,
    Result,
    ShapeNode,
    type SvgShapeOptions,
    type VisualNode,
    validateStlTessellation,
} from "@spicy3d/core";
import { parseReferenceStl } from "./referenceStl";
import { type ThreeMfObject, threeMfColor, write3mf } from "./threeMf";

interface ExportShape {
    readonly node: ShapeNode;
    readonly shape: IShape;
}

/** STEP, IGES and 3MF record their unit; the other mesh formats and BREP are bare coordinates. */
const EMBEDDED_UNIT_FORMATS = new Set([".step", ".iges", ".3mf"]);
/** The STEP and IGES writers convert millimetres themselves; every other format is scaled here. */
const WRITER_SCALED_FORMATS = new Set([".step", ".iges"]);

export class DefaultDataExchange implements IDataExchange {
    referenceMeshFormats(): string[] {
        return [".stl"];
    }

    async importReferenceMesh(
        document: IDocument,
        file: File,
        options: ReferenceMeshImportOptions = {},
    ): Promise<Result<MeshNode>> {
        if (document.repository.isReadOnly?.(document.id)) return Result.err("Document is read-only");
        if (!file.name.toLowerCase().endsWith(".stl"))
            return Result.err("Reference meshes support STL files");
        const unit = options.lengthUnit ?? "mm";
        const opacity = options.opacity ?? 0.35;
        if (!isLengthUnit(unit)) return Result.err("Unsupported STL length unit");
        if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) return Result.err("Opacity must be 0–1");
        let mesh: Result<Mesh>;
        try {
            mesh = parseReferenceStl(await file.arrayBuffer(), lengthUnitFactor(unit));
        } catch {
            return Result.err("Unable to read STL file");
        }
        if (!mesh.isOk) return Result.err(mesh.error);
        const material = new Material({ document, name: `${file.name} reference`, color: 0x8098b0 });
        material.opacity = opacity;
        const node = new MeshNode({ document, name: file.name, mesh: mesh.value, materialId: material.id });
        node.transform = options.transform ?? Matrix4.identity();
        node.visible = options.visible ?? true;
        document.modelManager.materials.push(material);
        document.modelManager.addNode(node);
        document.visual.update();
        return Result.ok(node);
    }

    importFormats(): string[] {
        return [".step", ".stp", ".iges", ".igs", ".brep", ".stl", ".svg"];
    }

    exportFormats(): string[] {
        return [".step", ".iges", ".brep", ".stl", ".stl binary", ".ply", ".ply binary", ".obj", ".3mf"];
    }

    exportUnitHandling(type: string): ExportUnitHandling {
        return EMBEDDED_UNIT_FORMATS.has(type) ? { kind: "embedded" } : { kind: "none" };
    }

    async import(document: IDocument, files: FileList | File[]): Promise<void> {
        for (const file of files) {
            await this.handleSingleFileImport(document, file);
        }
    }

    private async handleSingleFileImport(document: IDocument, file: File) {
        let importResult: Result<INode> | undefined;

        const fileName = file.name.toLocaleLowerCase();
        if (this.extensionIs(fileName, ".brep")) {
            importResult = await this.importBrep(document, file);
        } else if (this.extensionIs(fileName, ".stl")) {
            importResult = await this.importStl(document, file);
        } else if (this.extensionIs(fileName, ".step", ".stp")) {
            importResult = await this.importStep(document, file);
        } else if (this.extensionIs(fileName, ".iges", ".igs")) {
            importResult = await this.importIges(document, file);
        } else if (this.extensionIs(fileName, ".svg")) {
            const result = await this.importSvg(document, file);
            if (!result.isOk) PubSub.default.pub("showToast", "error.import.svg:{0}", result.error);
            return;
        }

        this.handleImportResult(document, fileName, importResult);
    }

    private extensionIs(fileName: string, ...extensions: string[]): boolean {
        return extensions.some((ext) => fileName.endsWith(ext));
    }

    private handleImportResult(document: IDocument, name: string, nodeResult: Result<INode> | undefined) {
        if (!nodeResult?.isOk) {
            alert(I18n.translate("error.import.unsupportedFileType:{0}", name));
            return;
        }

        const node = nodeResult.value;
        node.name = name;
        document.modelManager.addNode(node);
        document.visual.update();
    }

    async importSvg(
        document: IDocument,
        file: File,
        options: SvgShapeOptions = {},
    ): Promise<Result<EditableShapeNode>> {
        if (document.repository.isReadOnly?.(document.id)) return Result.err("Document is read-only");
        const drawing = parseSvg(await file.text());
        if (!drawing.isOk) return Result.err(drawing.error);
        const built = buildSvgShape(shapeFactory, drawing.value, options);
        if (!built.isOk) return Result.err(built.error);
        const node = new EditableShapeNode({ document, name: file.name, shape: built.value.shape });
        document.modelManager.addNode(node);
        document.visual.update();
        const skipped = drawing.value.skipped.length + built.value.failed;
        if (skipped > 0) PubSub.default.pub("showToast", "toast.import.svgSkipped{0}", skipped);
        return Result.ok(node);
    }

    async importBrep(document: IDocument, file: File) {
        const shape = shapeConverter.convertFromBrep(await file.text());
        if (!shape.isOk) {
            return Result.err(shape.error);
        }
        return Result.ok(new EditableShapeNode({ document, name: file.name, shape: shape.value }));
    }

    private async importStl(document: IDocument, file: File) {
        const content = new Uint8Array(await file.arrayBuffer());
        return shapeConverter.convertFromSTL(document, content);
    }

    private async importIges(document: IDocument, file: File) {
        const content = new Uint8Array(await file.arrayBuffer());
        return shapeConverter.convertFromIGES(document, content);
    }

    private async importStep(document: IDocument, file: File) {
        const content = new Uint8Array(await file.arrayBuffer());
        return shapeConverter.convertFromSTEP(document, content);
    }

    async export(
        type: string,
        nodes: VisualNode[],
        options?: DataExportOptions,
    ): Promise<BlobPart[] | undefined> {
        if (nodes.length === 0) return undefined;
        const result = await this.exportResult(type, nodes, options);
        if (result.isOk) return result.value.data;
        if (result.error.kind === "no-geometry")
            PubSub.default.pub("showToast", "error.export.noNodeCanBeExported");
        else PubSub.default.pub("showToast", "error.default:{0}", result.error.message);
        return undefined;
    }

    async exportResult(
        type: string,
        nodes: VisualNode[],
        options?: DataExportOptions,
    ): Promise<Result<DataExport, DataExportError>> {
        const failed = (message: string) => Result.err<DataExportError>({ kind: "failed", message });
        if (nodes.length === 0)
            return Result.err({ kind: "no-geometry", message: "No nodes to export", nodes: [] });
        if (options?.stl && !isMeshedExportFormat(type)) {
            return failed(MESHED_EXPORT_ONLY_ERROR);
        }
        const toleranceError = validateStlTessellation(options?.stl);
        if (toleranceError) return failed(toleranceError);

        const document = nodes[0].document;
        const unit = exportLengthUnit(this.exportUnitHandling(type), options?.lengthUnit);
        // STEP/IGES writers convert millimetres themselves; every other format gets the numbers
        // converted here (3MF records the unit too, the vertices must match it).
        const scale = fromMillimetres(1, unit);
        const rebuilt = await awaitExportRebuilds(nodes, options?.signal);
        if (!rebuilt.isOk) return Result.err(rebuilt.error);
        let shapeResult: Result<BlobPart> | undefined;
        let skipped: readonly string[] = [];
        if (type === ".ply") {
            shapeResult = document.visual.meshExporter.exportToPly(nodes, true, { scale });
        } else if (type === ".ply binary") {
            shapeResult = document.visual.meshExporter.exportToPly(nodes, false, { scale });
        } else if (type === ".obj") {
            shapeResult = document.visual.meshExporter.exportToObj(nodes, { scale });
        } else {
            const exported = this.getExportShapes(nodes, WRITER_SCALED_FORMATS.has(type) ? 1 : scale);
            if (!exported.isOk) return Result.err(exported.error);
            skipped = exported.value.skipped;
            const shapes = exported.value.entries.map((entry) => entry.shape);
            if (type === ".3mf") {
                const written = await this.export3mf(document, exported.value.entries, unit, options, scale);
                if (!written.isOk) return Result.err(written.error);
                return Result.ok({
                    data: [written.value.bytes as BlobPart],
                    skipped: [...skipped, ...written.value.skipped],
                });
            }
            // STL goes through the headless OCCT-mesh converter (not the Three.js
            // visual exporter), so the same path works in the browser and the MCP server.
            if (type === ".stl") shapeResult = this.exportStl(document, shapes, false, options, scale);
            if (type === ".stl binary") shapeResult = this.exportStl(document, shapes, true, options, scale);
            if (type === ".step") shapeResult = this.exportStep(document, shapes, unit);
            if (type === ".iges") shapeResult = this.exportIges(document, shapes, unit);
            if (type === ".brep") shapeResult = this.exportBrep(document, shapes);
        }

        if (!shapeResult) return failed(`Unsupported export format "${type}"`);
        return shapeResult.isOk
            ? Result.ok({ data: [shapeResult.value], skipped })
            : failed(String(shapeResult.error));
    }

    private getExportShapes(
        nodes: VisualNode[],
        scale: number,
    ): Result<{ entries: ExportShape[]; skipped: string[] }, DataExportError> {
        const selected = nodes.filter((node): node is ShapeNode => node instanceof ShapeNode);
        // Do not use the earlier getter results or start another lazy evaluation here.
        const entries: ExportShape[] = [];
        const missing: string[] = [];
        for (const node of selected) {
            const shape = node.resolvedShape;
            if (shape)
                entries.push({
                    node,
                    shape: this.scaled(shape.transformedMul(node.worldTransform()), scale),
                });
            else missing.push(node.id);
        }
        if (entries.length) return Result.ok({ entries, skipped: missing });
        return Result.err({
            kind: "no-geometry",
            message: selected.length
                ? "No selected node has geometry after its rebuild"
                : "No selected node has exportable shape geometry",
            nodes: missing,
        });
    }

    /** `shape` scaled about the origin — millimetres into the export unit. */
    private scaled(shape: IShape, scale: number): IShape {
        if (scale === 1) return shape;
        const result = shape.transformedMul(Matrix4.fromScale(scale, scale, scale));
        shape.dispose();
        return result;
    }

    /** Tolerances in millimetres, converted like the coordinates. */
    private scaledTolerance(options: DataExportOptions | undefined, scale: number) {
        const tolerance = options?.stl;
        return (
            tolerance && {
                linearTolerance:
                    tolerance.linearTolerance === undefined ? undefined : tolerance.linearTolerance * scale,
                angularTolerance: tolerance.angularTolerance,
            }
        );
    }

    /**
     * One 3MF object and build item per node, in the export unit with the world transform baked
     * in, coloured by the node's (first) material. Nodes whose shape has no faces are skipped.
     * Open shells and loose faces are written as they mesh, as STL does: slicers report their
     * open edges rather than the export refusing them.
     */
    private async export3mf(
        document: IDocument,
        entries: ExportShape[],
        unit: LengthUnit,
        options: DataExportOptions | undefined,
        scale: number,
    ): Promise<Result<{ bytes: Uint8Array; skipped: string[] }, DataExportError>> {
        const tolerance = this.scaledTolerance(options, scale);
        const objects: ThreeMfObject[] = [];
        const skipped: string[] = [];
        for (const { node, shape } of entries) {
            const mesh = shapeConverter.convertToIndexedMesh(shape, tolerance);
            if (!mesh.isOk) return Result.err({ kind: "failed", message: String(mesh.error) });
            if (mesh.value.triangles.length === 0) {
                skipped.push(node.id);
                continue;
            }
            const material = this.materialOf(document, node);
            const color = threeMfColor(material?.color);
            objects.push({
                name: node.name,
                mesh: mesh.value,
                ...(material && color && { material: { name: material.name, color } }),
            });
        }
        if (objects.length === 0)
            return Result.err({
                kind: "no-geometry",
                message: "No selected node has faces to mesh",
                nodes: skipped,
            });
        const bytes = await write3mf({
            unit,
            objects,
            title: document.name,
            creationDate: new Date().toISOString().slice(0, 10),
        });
        return Result.ok({ bytes, skipped });
    }

    private materialOf(document: IDocument, node: ShapeNode): Material | undefined {
        const id = Array.isArray(node.materialId) ? node.materialId[0] : node.materialId;
        return document.modelManager.materials.find((material) => material.id === id);
    }

    private exportStl(
        doc: IDocument,
        shapes: IShape[],
        binary: boolean,
        options?: DataExportOptions,
        scale = 1,
    ): Result<BlobPart> {
        return shapeConverter.convertToSTL(shapes, {
            binary,
            ...this.scaledTolerance(options, scale),
        }) as Result<BlobPart>;
    }

    private exportStep(doc: IDocument, shapes: IShape[], lengthUnit: LengthUnit) {
        return shapeConverter.convertToSTEP(shapes, { lengthUnit });
    }

    private exportIges(doc: IDocument, shapes: IShape[], lengthUnit: LengthUnit) {
        return shapeConverter.convertToIGES(shapes, { lengthUnit });
    }

    private exportBrep(document: IDocument, shapes: IShape[]) {
        const comp = shapeFactory.combine(shapes);
        if (!comp.isOk) {
            return Result.err(comp.error);
        }

        const result = shapeConverter.convertToBrep(comp.value);
        comp.value.dispose();
        return result;
    }
}
