// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
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
    type LengthUnit,
    Matrix4,
    PubSub,
    Result,
    ShapeNode,
    type VisualNode,
} from "@spicy3d/core";

/** STEP and IGES record their unit; the mesh formats and BREP are bare coordinates. */
const EMBEDDED_UNIT_FORMATS = new Set([".step", ".iges"]);

export class DefaultDataExchange implements IDataExchange {
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
            const shapes = this.getExportShapes(nodes, EMBEDDED_UNIT_FORMATS.has(type) ? 1 : scale);
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

    private getExportShapes(nodes: VisualNode[], scale: number): IShape[] {
        const shapes = nodes
            .filter((x): x is ShapeNode => x instanceof ShapeNode)
            .map((x) => this.scaled(x.shape.value.transformedMul(x.worldTransform()), scale));

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
