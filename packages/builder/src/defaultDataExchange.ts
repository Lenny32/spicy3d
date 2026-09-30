// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type DataExportOptions,
    DocumentRebuilds,
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
    type LengthUnit,
    lengthUnitFactor,
    Material,
    Matrix4,
    type Mesh,
    MeshNode,
    PubSub,
    type ReferenceMeshImportOptions,
    Result,
    ShapeNode,
    type VisualNode,
} from "@spicy3d/core";
import { parseReferenceStl } from "./referenceStl";

/** STEP and IGES record their unit; the mesh formats and BREP are bare coordinates. */
const EMBEDDED_UNIT_FORMATS = new Set([".step", ".iges"]);

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
        return [".step", ".stp", ".iges", ".igs", ".brep", ".stl"];
    }

    exportFormats(): string[] {
        return [".step", ".iges", ".brep", ".stl", ".stl binary", ".ply", ".ply binary", ".obj"];
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

        const document = nodes[0].document;
        const unit = exportLengthUnit(this.exportUnitHandling(type), options?.lengthUnit);
        // Mesh formats and BREP have no unit field: the numbers themselves are converted.
        const scale = fromMillimetres(1, unit);
        let shapeResult: Result<BlobPart> | undefined;
        if (type === ".ply") {
            shapeResult = document.visual.meshExporter.exportToPly(nodes, true, { scale });
        } else if (type === ".ply binary") {
            shapeResult = document.visual.meshExporter.exportToPly(nodes, false, { scale });
        } else if (type === ".obj") {
            shapeResult = document.visual.meshExporter.exportToObj(nodes, { scale });
        } else {
            // STEP/IGES writers convert and record the unit themselves; the rest scale here.
            const shapes = await this.getExportShapes(nodes, EMBEDDED_UNIT_FORMATS.has(type) ? 1 : scale);
            if (!shapes.length) return undefined;
            // STL goes through the headless OCCT-mesh converter (not the Three.js
            // visual exporter), so the same path works in the browser and the MCP server.
            if (type === ".stl") shapeResult = this.exportStl(document, shapes, false);
            if (type === ".stl binary") shapeResult = this.exportStl(document, shapes, true);
            if (type === ".step") shapeResult = this.exportStep(document, shapes, unit);
            if (type === ".iges") shapeResult = this.exportIges(document, shapes, unit);
            if (type === ".brep") shapeResult = this.exportBrep(document, shapes);
        }

        if (shapeResult) {
            return this.handleExportResult(shapeResult);
        }
        return undefined;
    }

    private async getExportShapes(nodes: VisualNode[], scale: number): Promise<IShape[]> {
        const selected = nodes.filter((node): node is ShapeNode => node instanceof ShapeNode);
        // Hidden bodies may never have been evaluated. Demand every selected shape before
        // awaiting: a pending getter returns last-good (or an initial error), not export data.
        for (const node of selected) void node.shape;
        const documents = new Set(selected.map((node) => node.document));
        await Promise.all([...documents].map((document) => DocumentRebuilds.settled(document)));

        // Do not use the earlier getter results or start another lazy evaluation here.
        const shapes: IShape[] = [];
        for (const node of selected) {
            const shape = node.resolvedShape;
            if (shape) shapes.push(this.scaled(shape.transformedMul(node.worldTransform()), scale));
        }

        !shapes.length && PubSub.default.pub("showToast", "error.export.noNodeCanBeExported");
        return shapes;
    }

    /** `shape` scaled about the origin — millimetres into the export unit. */
    private scaled(shape: IShape, scale: number): IShape {
        if (scale === 1) return shape;
        const result = shape.transformedMul(Matrix4.fromScale(scale, scale, scale));
        shape.dispose();
        return result;
    }

    private exportStl(doc: IDocument, shapes: IShape[], binary: boolean): Result<BlobPart> {
        return shapeConverter.convertToSTL(shapes, { binary }) as Result<BlobPart>;
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

    private handleExportResult(result: Result<BlobPart> | undefined) {
        if (!result?.isOk) {
            PubSub.default.pub("showToast", "error.default:{0}", result?.error);
            return undefined;
        }
        return [result.value];
    }
}
