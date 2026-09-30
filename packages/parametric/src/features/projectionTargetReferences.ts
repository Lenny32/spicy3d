// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type IDocument,
    type IFace,
    type IShape,
    Result,
    ShapeNode,
    ShapeTypes,
    sha256HexSync,
} from "@spicy3d/core";
import { isBodyTimelineNode, isBodyTrackingNode } from "./bodyTracking";
import type { FeatureContext } from "./feature";
import { captureProfileRef, type ProfileRef } from "./profileRef";
import { matchSourceFaceIndexes, resolveSourceFaces } from "./sourceFaceMatcher";

/** Runtime reference carrier; the saved feature registration is owned by its approved schema step. */
export interface ProjectionTargetReference {
    readonly nodeId: string;
    readonly face: ProfileRef;
}

export interface ResolvedProjectionTarget {
    readonly face: IFace;
    readonly anchor: ProfileRef;
    readonly seed: string;
    readonly stableIdentity: boolean;
    dispose(): void;
}

/** Capture the target in world coordinates, following the existing press-pull face contract. */
export function captureProjectionTarget(node: ShapeNode, index: number): Result<ProjectionTargetReference> {
    if (!node.shape.isOk) return Result.err("Projection target geometry is unavailable");
    if (!Number.isInteger(index) || index < 0)
        return Result.err("Projection target face index must be a nonnegative integer");
    const faces = node.shape.value.findSubShapes(ShapeTypes.face) as IFace[];
    const local = faces[index];
    if (local === undefined) return Result.err("Projection target face index is out of bounds");
    const id = isBodyTrackingNode(node) ? node.faceIdAt(index) : undefined;
    const splitPiece = id !== undefined && isBodyTrackingNode(node) && node.faceIndexesOfId(id).length > 1;
    const world = local.transformedMul(node.worldTransform()) as IFace;
    try {
        return Result.ok({ nodeId: node.id, face: captureProfileRef(world, id, splitPiece) });
    } finally {
        world.dispose();
    }
}

/** Exactly one trimmed face, resolved from host input or the proper pre-consumption timeline. */
export function resolveProjectionTarget(
    reference: ProjectionTargetReference,
    context: FeatureContext,
): Result<ResolvedProjectionTarget> {
    const inverse = context.host.worldTransform().invert();
    if (inverse === undefined) return Result.err("Projection host placement is not invertible");
    const resolved = resolveSourceFaces({ nodeId: reference.nodeId, profiles: [reference.face] }, context);
    if (!resolved.isOk) return Result.err(`Projection target: ${resolved.error}`);
    const { worldFaces, faceIds, owned } = resolved.value;
    try {
        const matched = matchSourceFaceIndexes(worldFaces, faceIds, [reference.face]);
        if (!matched.isOk) return Result.err(`Projection target: ${matched.error}`);
        if (matched.value.indexes.length !== 1)
            return Result.err("Projection target is missing or ambiguous; select one trimmed face piece");
        const index = matched.value.indexes[0];
        const world = worldFaces[index];
        const id = faceIds?.[index];
        const anchor = captureProfileRef(world, id, reference.face.splitPiece);
        const local = world.transformedMul(inverse) as IFace;
        return Result.ok({
            face: local,
            anchor,
            seed: id ?? `geometry:${sha256HexSync(new TextEncoder().encode(JSON.stringify(reference.face)))}`,
            stableIdentity: id !== undefined,
            dispose: () => {
                local.dispose();
            },
        });
    } finally {
        for (const shape of owned) shape.dispose();
    }
}

const timelineTokens = new WeakMap<IShape, number>();
let nextToken = 1;

/** Avoid cache loops when a target later consumes this curve host; compare its entering state. */
export function projectionTargetDependencies(
    reference: ProjectionTargetReference,
    document: IDocument,
    hostId: string,
): { refIds: string[]; key: string | undefined } {
    if (reference.nodeId === hostId) return { refIds: [], key: undefined };
    const node = document.modelManager.findNode((candidate) => candidate.id === reference.nodeId);
    if (node instanceof ShapeNode && isBodyTimelineNode(node)) {
        const index = node.consumingFeatureIndex(hostId);
        if (index !== undefined) {
            const state = node.timelineStateAt(index);
            let token: number | undefined;
            if (state?.shape) {
                token = timelineTokens.get(state.shape);
                if (token === undefined) {
                    token = nextToken++;
                    timelineTokens.set(state.shape, token);
                }
            }
            return {
                refIds: [],
                key: JSON.stringify([
                    reference.nodeId,
                    index,
                    token,
                    node.worldTransform().toArray(),
                    node.rollbackIndex,
                ]),
            };
        }
    }
    return { refIds: [reference.nodeId], key: undefined };
}
