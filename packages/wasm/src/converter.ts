// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type CadExportOptions,
    type Deletable,
    EditableShapeNode,
    type FolderNode,
    GroupNode,
    gc,
    type IDisposable,
    type IDocument,
    type IndexedMesh,
    type IShape,
    type IShapeConverter,
    Material,
    Result,
    type StlExportOptions,
    type StlTessellationOptions,
} from "@spicy3d/core";
import type { ShapeNode } from "../lib/spicy-wasm";
import { kernelCallFailure } from "./factory";
import { weldMeshes } from "./indexedMesh";
import { guardKernelResults } from "./kernelGuard";
import { OccShape } from "./shape";
import { exportFaceMesh, shapesToStl } from "./stlWriter";

/**
 * Whether `text` ends like a whole file of `format`. A writer whose output stream ran out of
 * memory used to answer the text written so far, cut mid-entity (#170); kernels built before the
 * C++ writers checked their stream still do, so the end of the file is checked here too.
 */
export function isCompleteCadFile(format: "STEP" | "IGES" | "BREP", text: string): boolean {
    const end = text.trimEnd();
    if (format === "STEP") return end.endsWith("END-ISO-10303-21;");
    // The last record of an IGES file is its Terminate section: section letter "T" in column 73.
    if (format === "IGES") return end.slice(end.lastIndexOf("\n") + 1).charAt(72) === "T";
    return end.length > 0;
}

function writeCadFile(format: "STEP" | "IGES" | "BREP", write: () => string): Result<string> {
    let text: string;
    try {
        text = write();
    } catch (error) {
        return Result.err(kernelCallFailure(`${format} export`, error));
    }
    if (!isCompleteCadFile(format, text))
        return Result.err(`${format} export failed: the writer produced an incomplete file`);
    return Result.ok(text);
}

export class OccShapeConverter implements IShapeConverter {
    private readonly addShapeNode = (
        collector: (d: Deletable | IDisposable) => any,
        folder: FolderNode,
        node: ShapeNode,
        children: ShapeNode[],
        getMaterialId: (document: IDocument, color: string) => string,
    ) => {
        if (node.shape && !node.shape.isNull()) {
            const shape = OccShape.wrap(node.shape);
            const material = getMaterialId(folder.document, node.color as string);
            folder.add(
                new EditableShapeNode({
                    document: folder.document,
                    name: node.name,
                    shape,
                    materialId: material,
                }),
            );
        }

        children.forEach((child) => {
            collector(child);
            const subChildren = child.getChildren();
            const childFolder =
                subChildren.length > 1
                    ? new GroupNode({ document: folder.document, name: child.name })
                    : folder;

            if (subChildren.length > 1) {
                folder.add(childFolder);
            }
            this.addShapeNode(collector, childFolder, child, subChildren, getMaterialId);
        });
    };

    constructor() {
        // Once the kernel crashed, every conversion answers `Result.err` with the same message.
        // biome-ignore lint/correctness/noConstructorReturn: the guarded facade replaces the instance
        return guardKernelResults(this);
    }

    convertToIGES(shapes: IShape[], options?: CadExportOptions): Result<string> {
        const occShapes = shapes.map((shape) => {
            if (shape instanceof OccShape) {
                return shape.shape;
            }
            throw new Error("Shape is not an OccShape");
        });
        return writeCadFile("IGES", () =>
            wasm.Converter.convertToIges(occShapes, options?.lengthUnit ?? "mm"),
        );
    }

    convertFromIGES(document: IDocument, iges: Uint8Array): Result<FolderNode> {
        return this.converterFromData(document, iges, wasm.Converter.convertFromIges);
    }

    private readonly converterFromData = (
        document: IDocument,
        data: Uint8Array,
        converter: (data: Uint8Array) => ShapeNode | undefined,
    ) => {
        const materialMap: Map<string, string> = new Map();
        const getMaterialId = (document: IDocument, color: string) => {
            // Provide default color for undefined, null, or empty color values
            const materialColor = color || "#808080"; // Default gray color
            const materialKey = materialColor;

            if (!materialMap.has(materialKey)) {
                const material = new Material({ document, name: materialKey, color: materialColor });
                document.modelManager.materials.push(material);
                materialMap.set(materialKey, material.id);
            }
            return materialMap.get(materialKey)!;
        };

        return gc((c) => {
            const node = converter(data);
            if (!node) {
                return Result.err("can not convert");
            }
            const folder = new GroupNode({ document, name: "undefined" });
            this.addShapeNode(c, folder, node, node.getChildren(), getMaterialId);
            c(node);
            return Result.ok(folder);
        });
    };

    convertToSTEP(shapes: IShape[], options?: CadExportOptions): Result<string> {
        const occShapes = shapes.map((shape) => {
            if (shape instanceof OccShape) {
                return shape.shape;
            }
            throw new Error("Shape is not an OccShape");
        });
        return writeCadFile("STEP", () =>
            wasm.Converter.convertToStep(occShapes, options?.lengthUnit ?? "mm"),
        );
    }

    convertFromSTEP(document: IDocument, step: Uint8Array): Result<FolderNode> {
        return this.converterFromData(document, step, wasm.Converter.convertFromStep);
    }

    convertToBrep(shape: IShape): Result<string> {
        if (shape instanceof OccShape) {
            return writeCadFile("BREP", () => wasm.Converter.convertToBrep(shape.shape));
        }
        return Result.err("Shape is not an OccShape");
    }

    convertFromBrep(brep: string): Result<IShape> {
        const shape = wasm.Converter.convertFromBrep(brep);
        if (shape.isNull()) {
            return Result.err("can not convert");
        }
        return Result.ok(OccShape.wrap(shape));
    }

    convertToSTL(shapes: IShape[], options?: StlExportOptions): Result<Uint8Array> {
        try {
            return Result.ok(shapesToStl(shapes, options));
        } catch (error) {
            return Result.err(String(error));
        }
    }

    convertFromSTL(document: IDocument, stl: Uint8Array): Result<FolderNode> {
        return this.converterFromData(document, stl, wasm.Converter.convertFromStl);
    }

    convertToIndexedMesh(shape: IShape, options?: StlTessellationOptions): Result<IndexedMesh> {
        try {
            const faces = exportFaceMesh(shape, options);
            return Result.ok(weldMeshes(faces ? [faces] : []));
        } catch (error) {
            return Result.err(String(error));
        }
    }
}
