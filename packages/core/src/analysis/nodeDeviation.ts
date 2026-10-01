// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { DocumentRebuilds } from "../documentRebuilds";
import { Result } from "../foundation";
import { Matrix4 } from "../math";
import { GroupNode, type INode, MeshNode, ShapeNode, VisualNode } from "../model";
import { KernelState } from "../shape/kernelState";
import {
    type DeviationMesh,
    type MeshDeviationOptions,
    type MeshDeviationResult,
    measureMeshDeviation,
} from "./meshDeviation";

/** Model and reference snapshots in document millimetres, including hidden parent groups. */
export async function measureNodeDeviation(
    model: VisualNode,
    reference: MeshNode,
    options?: MeshDeviationOptions,
): Promise<Result<MeshDeviationResult>> {
    if (model.document !== reference.document)
        return Result.err("Model and reference must belong to the same document");
    if (model === reference) return Result.err("Select different model and reference nodes");
    if (reference.mesh.meshType !== "surface") return Result.err("Reference must be a triangle surface mesh");
    try {
        if (options?.signal?.aborted) return Result.err("Deviation measurement cancelled");
        let mesh: DeviationMesh;
        if (model instanceof ShapeNode) {
            if (KernelState.current.message !== undefined) return Result.err(KernelState.current.message);
            void model.shape;
            await settled(model, options?.signal);
            const shape = model.resolvedShape;
            if (!shape) return Result.err("Model has no rebuilt shape");
            const faces = shape.mesh.faces;
            if (!faces) return Result.err("Model has no face tessellation");
            mesh = { position: faces.position, index: faces.index, transform: hierarchyTransform(model) };
        } else if (model instanceof MeshNode && model.mesh.meshType === "surface" && model.mesh.position) {
            mesh = {
                position: model.mesh.position,
                index: model.mesh.index,
                transform: hierarchyTransform(model),
            };
        } else return Result.err("Model must be a CAD body or triangle surface mesh");
        if (!reference.mesh.position) return Result.err("Reference contains no positions");
        const revision = DocumentRebuilds.revision(model.document);
        const result = await measureMeshDeviation(
            mesh,
            {
                position: reference.mesh.position,
                index: reference.mesh.index,
                transform: hierarchyTransform(reference),
            },
            options,
        );
        if (DocumentRebuilds.revision(model.document) !== revision)
            return Result.err("Model or reference changed during measurement; rerun");
        return result;
    } catch (error) {
        return Result.err(error instanceof Error ? error.message : "Unable to read model tessellation");
    }
}

function hierarchyTransform(node: INode): Matrix4 {
    const transforms: Matrix4[] = [];
    let current: INode | undefined = node;
    while (current) {
        if (current instanceof VisualNode || current instanceof GroupNode)
            transforms.unshift(current.transform);
        current = current.parent;
    }
    return transforms.reduce((world, transform) => transform.multiply(world), Matrix4.identity());
}

async function settled(model: ShapeNode, signal?: AbortSignal): Promise<void> {
    if (!signal) return DocumentRebuilds.settled(model.document);
    if (signal.aborted) throw new Error("Deviation measurement cancelled");
    let abort: () => void = () => {};
    const cancelled = new Promise<never>((_resolve, reject) => {
        abort = () => reject(new Error("Deviation measurement cancelled"));
        signal.addEventListener("abort", abort, { once: true });
    });
    try {
        await Promise.race([DocumentRebuilds.settled(model.document), cancelled]);
    } finally {
        signal.removeEventListener("abort", abort);
    }
}
