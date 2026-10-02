// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type IDocument,
    type IEdge,
    type IFace,
    type IShape,
    Result,
    ShapeNode,
    ShapeTypes,
    sha256HexSync,
    type TrackedShape,
} from "@spicy3d/core";
import {
    type FaceSweepFeatureData,
    type FeatureContext,
    type FeatureHandler,
    registerFeature,
} from "./feature";
import { pathReferenceDependencies, resolvePathReferences } from "./pathReferences";
import { captureProfileRef } from "./profileRef";
import { projectionTargetDependencies, resolveProjectionTarget } from "./projectionTargetReferences";
import { isReusableTopologyIdentity } from "./reusableTopologyIdentity";
import { validateSelfIntersection } from "./selfIntersectionValidation";
import { resolveSweepSection, trackSweep } from "./sweep";
import { ancestorInputs, combineIds } from "./trackedId";

function hash(values: readonly string[]): string {
    return sha256HexSync(new TextEncoder().encode(JSON.stringify([...new Set(values)].sort())));
}
function dependencies(feature: FaceSweepFeatureData, document: IDocument) {
    const host = document.modelManager.findNode((node) => {
        const list = (node as { features?: unknown }).features;
        return Array.isArray(list) && list.some((item: { id: string }) => item.id === feature.id);
    })?.id;
    if (!host)
        return {
            ids: [feature.section.sketchId, feature.path.nodeId, feature.support.nodeId],
            key: undefined,
        };
    const path = pathReferenceDependencies(feature.path, document, host);
    const support = projectionTargetDependencies(feature.support, document, host);
    const node = document.modelManager.findNode((candidate) => candidate.id === host);
    return {
        ids: [...new Set([feature.section.sketchId, ...path.refIds, ...support.refIds])],
        key: JSON.stringify([
            path.key,
            support.key,
            node instanceof ShapeNode ? node.worldTransform().toArray() : undefined,
        ]),
    };
}

/** Preserve real boolean origins. Only intersection edges use their actual adjacent derived faces. */
function trackBoolean(
    feature: FaceSweepFeatureData,
    input: IShape,
    inputFaces: readonly string[],
    inputEdges: readonly string[],
    tool: TrackedShape,
    toolFaces: readonly string[],
    toolEdges: readonly string[],
    result: TrackedShape,
): Result<{ faces: string[]; edges: string[] }> {
    const subs: IShape[] = [];
    try {
        const sourceFaces = [input, tool.shape].flatMap(
            (shape) => shape.findSubShapes(ShapeTypes.face) as IFace[],
        );
        const sourceEdges = [input, tool.shape].flatMap(
            (shape) => shape.findSubShapes(ShapeTypes.edge) as IEdge[],
        );
        subs.push(...sourceFaces, ...sourceEdges);
        const outputFaces = result.shape.findSubShapes(ShapeTypes.face) as IFace[];
        const outputEdges = result.shape.findSubShapes(ShapeTypes.edge) as IEdge[];
        subs.push(...outputFaces, ...outputEdges);
        const faceSeeds = [...inputFaces, ...toolFaces],
            edgeSeeds = [...inputEdges, ...toolEdges];
        if (sourceFaces.length !== faceSeeds.length || sourceEdges.length !== edgeSeeds.length)
            return Result.err("Face sweep boolean input ancestry is incomplete");
        const origins = (indexes: readonly number[], seeds: readonly string[]) =>
            indexes.map((index) => {
                if (
                    !Number.isInteger(index) ||
                    index < 0 ||
                    index >= seeds.length ||
                    !isReusableTopologyIdentity(seeds[index])
                )
                    throw new Error("Face sweep boolean ancestry is unavailable");
                return seeds[index];
            });
        const nativeOrigins = (
            map: readonly number[],
            pairs: number[] | undefined,
            outputs: readonly IShape[],
            inputs: readonly IShape[],
        ) => {
            if (map.length !== outputs.length || (pairs?.length ?? 0) % 2)
                throw new Error("Face sweep native boolean history is malformed");
            for (let i = 0; i < (pairs?.length ?? 0); i += 2) {
                if (
                    !pairs ||
                    pairs[i] < 0 ||
                    pairs[i] >= outputs.length ||
                    pairs[i + 1] < 0 ||
                    pairs[i + 1] >= inputs.length
                )
                    throw new Error("Face sweep native boolean history is outside its inputs");
            }
            return ancestorInputs(map, pairs).map((indexes, outputIndex) => {
                if (indexes.length) return indexes;
                const same = inputs.flatMap((shape, index) =>
                    outputs[outputIndex].isSame(shape) ? [index] : [],
                );
                if (same.length > 1) throw new Error("Face sweep unchanged topology ancestry is ambiguous");
                return same;
            });
        };
        const faces = nativeOrigins(result.faceMap, result.faceAncestors, outputFaces, sourceFaces).map(
            (indexes) => {
                const seeds = origins(indexes, faceSeeds);
                if (!seeds.length) throw new Error("Face sweep boolean face has no proven source ancestry");
                return combineIds(seeds);
            },
        );
        const boundaries = outputFaces.map((face) => face.findSubShapes(ShapeTypes.edge) as IEdge[]);
        subs.push(...boundaries.flat());
        const edgeOrigins = nativeOrigins(result.edgeMap, result.edgeAncestors, outputEdges, sourceEdges);
        const edges = outputEdges.map((edge, index) => {
            const seeds = origins(edgeOrigins[index], edgeSeeds);
            if (seeds.length) return combineIds(seeds);
            const adjacent = faces.filter((_, faceIndex) =>
                boundaries[faceIndex].some((candidate) => candidate.isSame(edge)),
            );
            if (adjacent.length < 2)
                throw new Error("Face sweep intersection edge has no complete face ancestry");
            return `${feature.id}:face-sweep:intersection:${hash(adjacent)}`;
        });
        return Result.ok({ faces, edges });
    } catch (error) {
        return Result.err(error instanceof Error ? error.message : String(error));
    } finally {
        for (const sub of subs) sub.dispose();
    }
}

/** Native Copy.ModifiedShape establishes every copied face and edge's original source. */
function copyInput(
    input: IShape,
    faceIds: readonly string[],
    edgeIds: readonly string[],
): Result<{ shape: IShape; faces: string[]; edges: string[] }> {
    const copied = shapeFactory.copyTracked?.(input);
    if (!copied) return Result.err("Face sweep requires native tracked deep copy");
    if (!copied.isOk) return Result.err(copied.error);
    const { shape, faceMap, edgeMap } = copied.value;
    let accepted = false;
    try {
        if (
            faceIds.length !== faceMap.length ||
            edgeIds.length !== edgeMap.length ||
            new Set(faceMap).size !== faceMap.length ||
            new Set(edgeMap).size !== edgeMap.length
        )
            return Result.err("Face sweep entering body ancestry is incomplete");
        const ids = (map: readonly number[], seeds: readonly string[]) =>
            map.map((index) => {
                if (index < 0 || index >= seeds.length || !isReusableTopologyIdentity(seeds[index]))
                    throw new Error("Face sweep entering topology cannot be associated uniquely");
                return seeds[index];
            });
        const faces = ids(faceMap, faceIds),
            edges = ids(edgeMap, edgeIds);
        accepted = true;
        return Result.ok({ shape, faces, edges });
    } catch (error) {
        return Result.err(error instanceof Error ? error.message : String(error));
    } finally {
        if (!accepted) shape.dispose();
    }
}

const handler: FeatureHandler<FaceSweepFeatureData> = {
    display: "command.feature.faceSweep",
    icon: "icon-sweep",
    reselectable: true,
    nodeIds: (feature) => [
        ...new Set([feature.section.sketchId, feature.path.nodeId, feature.support.nodeId]),
    ],
    cacheRefIds: (feature, document) => dependencies(feature, document).ids,
    cacheKey: (feature, document) => dependencies(feature, document).key,
    references: (feature) => [
        { key: "section", display: "body.sketch", nodeId: feature.section.sketchId },
        { key: "path", display: "body.sweep", nodeId: feature.path.nodeId },
        { key: "support", display: "faceSweep.support", nodeId: feature.support.nodeId },
    ],
    parameters: (feature) => [
        { key: "operation", display: "faceSweep.operation", value: feature.operation },
        { key: "roundCorner", display: "option.command.roundCorner", value: feature.roundCorner === true },
    ],
    setParameter: (feature, key, value) =>
        key === "operation"
            ? value === "join" || value === "cut"
                ? { ...feature, operation: value }
                : feature
            : key === "roundCorner"
              ? { ...feature, roundCorner: value === true }
              : feature,
    applyResolvedRefs: (feature, refs) => ({
        ...feature,
        section:
            refs.resolvedProfiles?.[0] && feature.section.profile
                ? { ...feature.section, profile: refs.resolvedProfiles[0] }
                : feature.section,
        path: refs.resolvedEdges ? { ...feature.path, edges: refs.resolvedEdges } : feature.path,
        support: refs.resolvedFaces?.["support"]
            ? { ...feature.support, face: refs.resolvedFaces["support"] }
            : feature.support,
    }),
    evaluate(feature, context: FeatureContext): Result<IShape> {
        if (!context.input || !context.tracking)
            return Result.err("Face sweep requires a preceding tracked solid body");
        if (feature.operation !== "join" && feature.operation !== "cut")
            return Result.err("Face sweep operation must be join or cut");
        if (!shapeFactory.faceSweepTracked)
            return Result.err("Support-normal face sweep requires a newer geometry kernel");
        const section = resolveSweepSection(feature, context);
        if (!section.isOk) return Result.err(section.error);
        const owned: IShape[] = [];
        let path: ReturnType<typeof resolvePathReferences> | undefined,
            support: ReturnType<typeof resolveProjectionTarget> | undefined;
        try {
            path = resolvePathReferences(feature.path, context);
            if (!path.isOk) return Result.err(path.error);
            if (path.value.references.some((reference) => !reference.stable))
                return Result.err("Face sweep requires proven source ancestry for its path");
            support = resolveProjectionTarget(feature.support, context);
            if (!support.isOk) return Result.err(support.error);
            if (!support.value.stableIdentity)
                return Result.err("Face sweep requires proven support face ancestry");
            const swept = shapeFactory.faceSweepTracked(
                section.value.wire,
                path.value.wire,
                support.value.face,
                feature.roundCorner === true,
            );
            if (!swept.isOk) return Result.err(swept.error);
            owned.push(swept.value.shape);
            const clean = validateSelfIntersection(
                swept.value.shape,
                context.warn,
                context.deferSelfIntersection,
                "Face sweep tool intersects itself",
            );
            if (!clean.isOk) return Result.err(clean.error);
            const ids = trackSweep(feature, section.value, path.value, swept.value);
            if (!ids.isOk) return Result.err(ids.error);
            // Support controls the native Darboux frame; it is an explicit causal semantic origin,
            // distinct from PipeShell's native Generated(section/path) channels.
            const supportOrigin = `${feature.support.nodeId}:${support.value.seed}`;
            const withSupport = (id: string) => `${feature.id}:face-sweep:${hash([id, supportOrigin])}`;
            const faces = ids.value.faceIds.map(withSupport),
                edges = ids.value.edgeIds.map(withSupport);
            const copy = copyInput(
                context.input,
                context.tracking.inputFaceIds,
                context.tracking.inputEdgeIds,
            );
            if (!copy.isOk) return Result.err(copy.error);
            const input = copy.value.shape;
            owned.push(input);
            const intersection = shapeFactory.booleanCommon([input], [swept.value.shape]);
            if (!intersection.isOk) return Result.err(intersection.error);
            owned.push(intersection.value);
            const overlap = intersection.value.volume();
            const contactFaces = intersection.value.findSubShapes(ShapeTypes.face) as IFace[];
            let contactArea = 0;
            try {
                contactArea = contactFaces.reduce((area, face) => area + face.area(), 0);
            } finally {
                for (const face of contactFaces) face.dispose();
            }
            if (
                !Number.isFinite(overlap) ||
                !Number.isFinite(contactArea) ||
                (overlap <= 1e-8 && (feature.operation === "cut" || contactArea <= 1e-8))
            )
                return Result.err("Face sweep does not attach to or intersect the entering body");
            const combined =
                feature.operation === "join"
                    ? shapeFactory.booleanFuseTracked?.([input], [swept.value.shape])
                    : shapeFactory.booleanCutTracked?.([input], [swept.value.shape]);
            if (!combined) return Result.err("Face sweep requires tracked boolean geometry");
            if (!combined.isOk) return Result.err(combined.error);
            const output = combined.value.shape;
            owned.push(output);
            if (!output.checkShape()) return Result.err("Face sweep boolean result is invalid");
            const volume = output.volume(),
                originalVolume = context.input.volume();
            if (
                !Number.isFinite(volume) ||
                !Number.isFinite(originalVolume) ||
                originalVolume <= 1e-8 ||
                volume <= 1e-8 ||
                (feature.operation === "cut" ? originalVolume - volume : volume - originalVolume) <= 1e-8
            )
                return Result.err("Face sweep produces no valid material change");
            const solids = output.findSubShapes(ShapeTypes.solid);
            try {
                if (solids.length !== 1) return Result.err("Face sweep must produce one connected solid");
            } finally {
                for (const solid of solids) solid.dispose();
            }
            const outputClean = validateSelfIntersection(
                output,
                context.warn,
                context.deferSelfIntersection,
                "Face sweep result intersects itself",
            );
            if (!outputClean?.isOk || !outputClean.value)
                return Result.err("Face sweep result intersects itself");
            const tracked = trackBoolean(
                feature,
                input,
                copy.value.faces,
                copy.value.edges,
                swept.value,
                faces,
                edges,
                combined.value,
            );
            if (!tracked.isOk) return Result.err(tracked.error);
            context.tracking.outputFaceIds = tracked.value.faces;
            context.tracking.outputEdgeIds = tracked.value.edges;
            context.tracking.resolvedProfiles = [captureProfileRef(section.value.face)];
            context.tracking.resolvedEdges = path.value.references.map((reference) => reference.anchor);
            context.tracking.resolvedFaces = { support: support.value.anchor };
            owned.splice(owned.indexOf(output), 1);
            return Result.ok(output);
        } catch (error) {
            return Result.err(error instanceof Error ? error.message : String(error));
        } finally {
            for (const shape of owned) shape.dispose();
            if (support?.isOk) support.value.dispose();
            if (path?.isOk) path.value.dispose();
            section.value.dispose();
        }
    },
};
registerFeature("faceSweep", handler);
