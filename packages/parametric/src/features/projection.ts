// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IDocument, type IShape, Result, VisualNode } from "@spicy3d/core";
import {
    type FeatureData,
    type FeatureHandler,
    type ProjectionFeatureData,
    registerFeature,
} from "./feature";
import { resolvePathReferences } from "./pathReferences";
import { buildProjectionResult } from "./projectionResult";
import { projectionTargetDependencies, resolveProjectionTarget } from "./projectionTargetReferences";

function dependencies(feature: ProjectionFeatureData, document: IDocument) {
    const host = document.modelManager.findNode((node) => {
        const features = (node as { features?: unknown }).features;
        return (
            Array.isArray(features) && features.some((candidate: FeatureData) => candidate.id === feature.id)
        );
    });
    if (!(host instanceof VisualNode))
        return { refIds: [feature.source.nodeId, feature.target.nodeId], key: undefined };
    const source = projectionTargetDependencies(feature.source, document, host.id);
    const target = projectionTargetDependencies(feature.target, document, host.id);
    return {
        refIds: [...new Set([...source.refIds, ...target.refIds])],
        key: JSON.stringify([host.worldTransform().toArray(), source.key, target.key]),
    };
}

const handler: FeatureHandler<ProjectionFeatureData> = {
    display: "command.feature.projection",
    icon: "icon-projectEdges",
    nodeIds: (feature) => [...new Set([feature.source.nodeId, feature.target.nodeId])],
    cacheRefIds: (feature, document) => dependencies(feature, document).refIds,
    cacheKey: (feature, document) => dependencies(feature, document).key,
    references: (feature) => [
        { key: "source", display: "projection.source", nodeId: feature.source.nodeId },
        { key: "target", display: "projection.target", nodeId: feature.target.nodeId },
    ],
    parameters: (feature) => [
        { key: "directionX", display: "projection.directionX", value: feature.direction.x },
        { key: "directionY", display: "projection.directionY", value: feature.direction.y },
        { key: "directionZ", display: "projection.directionZ", value: feature.direction.z },
    ],
    setParameter: (feature, key, value) => {
        const axis = { directionX: "x", directionY: "y", directionZ: "z" }[key];
        return axis && typeof value === "number" && Number.isFinite(value)
            ? { ...feature, direction: { ...feature.direction, [axis]: value } }
            : feature;
    },
    applyResolvedRefs: (feature, refs) => ({
        ...feature,
        source: refs.resolvedEdges ? { ...feature.source, edges: refs.resolvedEdges } : feature.source,
        target: refs.resolvedFaces?.["target"]
            ? { ...feature.target, face: refs.resolvedFaces["target"] }
            : feature.target,
    }),
    evaluate(feature, context): Result<IShape> {
        const source = resolvePathReferences(feature.source, context);
        if (!source.isOk) return Result.err(`Projection source: ${source.error}`);
        try {
            const target = resolveProjectionTarget(feature.target, context);
            if (!target.isOk) return Result.err(target.error);
            try {
                const result = buildProjectionResult(
                    feature.id,
                    feature.source.nodeId,
                    source.value.references,
                    feature.target.nodeId,
                    target.value,
                    feature.direction,
                    context.host.worldTransform(),
                );
                if (!result.isOk) return Result.err(result.error);
                if (context.tracking) {
                    context.tracking.outputFaceIds = [];
                    context.tracking.outputEdgeIds = result.value.edgeIds;
                    context.tracking.resolvedEdges = source.value.references.map((ref) => ref.anchor);
                    context.tracking.resolvedFaces = { target: target.value.anchor };
                }
                return Result.ok(result.value.shape);
            } finally {
                target.value.dispose();
            }
        } finally {
            source.value.dispose();
        }
    },
};

registerFeature("projection", handler);
