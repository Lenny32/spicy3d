// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IMeshExporter, type MeshExportOptions, Result, type VisualNode } from "@spicy3d/core";
import { Group, Matrix4, Mesh, Object3D } from "three";
import { OBJExporter } from "three/examples/jsm/exporters/OBJExporter.js";
import { PLYExporter } from "three/examples/jsm/exporters/PLYExporter.js";
import { STLExporter } from "three/examples/jsm/exporters/STLExporter.js";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import type { ThreeVisualContext } from "./threeVisualContext";

export class ThreeMeshExporter implements IMeshExporter {
    constructor(readonly content: ThreeVisualContext) {}

    exportToStl(nodes: VisualNode[], asciiMode: boolean, options?: MeshExportOptions): Result<BlobPart> {
        const exporter = new STLExporter();
        const group = this.parseNodeToGroup(nodes, options);
        const blob = exporter.parse(group, { binary: !asciiMode });
        this.disposeObject(group);
        return Result.ok(blob as BlobPart);
    }

    exportToPly(nodes: VisualNode[], asciiMode: boolean, options?: MeshExportOptions): Result<BlobPart> {
        const exporter = new PLYExporter();
        const group = this.parseNodeToGroup(nodes, options);
        const blobPart = exporter.parse(group, () => {}, { binary: !asciiMode });
        this.disposeObject(group);
        if (!blobPart) {
            return Result.err("can not export to ply");
        }
        return Result.ok(blobPart);
    }

    exportToObj(nodes: VisualNode[], options?: MeshExportOptions): Result<BlobPart> {
        const exporter = new OBJExporter();
        const group = this.parseNodeToGroup(nodes, options);
        const blobPart = exporter.parse(group);
        this.disposeObject(group);
        return Result.ok(blobPart);
    }

    private disposeObject(object: Object3D) {
        object.traverse((child) => {
            if (child instanceof Mesh) {
                child.geometry.dispose();
            }
        });
    }

    /**
     * Clones every mesh into one group. The exporters read each mesh's `matrixWorld` as it is
     * (the clone copies the original's), so a unit scale is applied there, on top of the
     * placement it already holds.
     */
    private parseNodeToGroup(nodes: VisualNode[], options?: MeshExportOptions) {
        const group = new Group();
        const scale = options?.scale ?? 1;
        const scaling = scale === 1 ? undefined : new Matrix4().makeScale(scale, scale, scale);
        nodes.forEach((node) => {
            const visualObject = this.content.getVisual(node);
            if (visualObject instanceof Object3D) {
                visualObject.traverse((child) => {
                    if (child instanceof LineSegments2 || child instanceof Line2) {
                        return;
                    }
                    if (child instanceof Mesh) {
                        const clone = child.clone(false);
                        if (scaling) clone.matrixWorld.premultiply(scaling);
                        group.add(clone);
                    }
                });
            }
        });

        return group;
    }
}
