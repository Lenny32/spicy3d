// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    BoundingBox,
    type IEdge,
    type IFace,
    type IShape,
    LENGTH_UNITS,
    Matrix4,
    Precision,
    Result,
    resolveUnitSpec,
    ShapeTypes,
    type XYZ,
} from "@spicy3d/core";
import type { SketchNode } from "../sketch/sketchNode";
import { trackedBoolean } from "./boolean";
import { findSketch } from "./extrude";
import {
    completeTrackedHistory,
    type EmbossFeatureData,
    type FeatureContext,
    type FeatureHandler,
    registerFeature,
} from "./feature";
import { mapOperationIds } from "./operationIds";
import { resolveProfiles } from "./profileBuilder";
import { captureProfileRef } from "./profileRef";
import { matchSourceFaceIndexes, resolveSourceFaces } from "./sourceFaceMatcher";
import { fuseProfiles } from "./sweepGeometry";

/**
 * Emboss / deboss: raises (or recesses) the region of a body's faces that a sketch's profiles
 * project onto, by a depth measured along the face — Fusion-style, so the result follows curved
 * faces (text wrapped around a cylinder keeps a constant relief height) instead of being a
 * flat-topped prism like an extrude.
 *
 * The kernel steps, all on the host's local space:
 * 1. every profile is swept through the whole body along the sketch normal (both ways);
 * 2. each target face is intersected with each prism, giving the face patches under the
 *    profile — only patches facing the sketch plane are kept (a profile over a cylinder's side
 *    face must not also emboss its far side);
 * 3. each patch is thickened by `depth` along its outward normal (`makeThickSolidBySimple`),
 *    outwards for emboss, inwards for deboss;
 * 4. the thickened patches are fused to (emboss) or cut from (deboss) the chain input, on the
 *    tracked path when available so the body's own face/edge ids survive.
 *
 * Target faces are stored like press-pull source faces (`ProfileRef`s captured in world
 * coordinates with the face's tracked id) and re-matched by `matchSourceFaceIndexes`.
 */
const embossHandler: FeatureHandler<EmbossFeatureData> = {
    display: (feature) => (feature.deboss === true ? "command.feature.deboss" : "command.feature.emboss"),
    icon: "icon-emboss",

    nodeIds: (feature) => [feature.sketchId],

    references: (feature) => [{ key: "sketchId", display: "body.sketch", nodeId: feature.sketchId }],

    parameters: (feature) => [
        { key: "depth", display: "option.command.depth", value: feature.depth, unit: LENGTH_UNITS },
        { key: "deboss", display: "option.command.deboss", value: feature.deboss ?? false },
    ],

    setParameter: (feature, key, value) =>
        key === "deboss"
            ? { ...feature, deboss: value === true || value === "true" }
            : { ...feature, [key]: value },

    applyResolvedRefs: (feature, { resolvedProfiles }) =>
        resolvedProfiles === undefined ? feature : { ...feature, faces: resolvedProfiles },

    evaluate(feature, context): Result<IShape> {
        const input = context.input;
        if (input === undefined) return Result.err("Emboss requires a preceding feature");
        const depth = resolveUnitSpec(feature.depth, context.scope, LENGTH_UNITS);
        if (!depth.isOk) return Result.err(depth.error);
        if (!(depth.value > 0)) return Result.err("Emboss depth must be positive");

        const tool = buildEmbossTool(feature, context, input, depth.value);
        if (!tool.isOk) return Result.err(tool.error);
        try {
            return combineWithInput(feature, context, input, tool.value);
        } finally {
            // The thickened patches are an intermediate input — the kernel reads them eagerly.
            tool.value.dispose();
        }
    },
};

/** The thickened face patches under the profiles, fused into one tool shape (host local space). */
function buildEmbossTool(
    feature: EmbossFeatureData,
    context: FeatureContext,
    input: IShape,
    depth: number,
): Result<IShape> {
    const sketch = findSketch(context.document, feature.sketchId);
    if (sketch === undefined) return Result.err("Sketch not found");
    const profiles = resolveProfiles(sketch, feature.profiles);
    if (!profiles.isOk) return Result.err(profiles.error);
    if (profiles.value.length === 0) return Result.err("Emboss sketch has no closed profile");

    const targets = resolveTargetFaces(feature, context, input);
    if (!targets.isOk) return Result.err(targets.error);

    const hostInvert = context.host.worldTransform().invert() ?? Matrix4.identity();
    const owned: IShape[] = [];
    const pieces: IShape[] = [];
    try {
        const prisms = throughPrisms(
            sketch,
            profiles.value.map(({ face }) => face),
            hostInvert,
            input,
            owned,
        );
        if (!prisms.isOk) return Result.err(prisms.error);
        const origin = hostInvert.ofPoint(sketch.plane.origin);
        const normal = hostInvert.ofVector(sketch.plane.normal);
        for (const face of targets.value) {
            for (const prism of prisms.value) {
                const thickened = thickenPatches(
                    face,
                    prism,
                    origin,
                    normal,
                    feature.deboss ? -depth : depth,
                );
                if (!thickened.isOk) {
                    pieces.forEach((x) => x.dispose());
                    return Result.err(thickened.error);
                }
                pieces.push(...thickened.value);
            }
        }
    } finally {
        owned.forEach((x) => x.dispose());
    }
    if (pieces.length === 0) return Result.err("Emboss profiles do not project onto the selected faces");
    const fused = fuseProfiles(pieces);
    if (!fused.isOk) pieces.forEach((x) => x.dispose());
    return fused;
}

/**
 * The target faces on the chain input (local space, `findSubShapes` order), matched by their
 * world-space refs. Re-anchors the refs on the faces matched this run, like press-pull.
 */
function resolveTargetFaces(
    feature: EmbossFeatureData,
    context: FeatureContext,
    input: IShape,
): Result<IFace[]> {
    if (feature.faces.length === 0) return Result.err("Emboss has no target face");
    const resolved = resolveSourceFaces({ nodeId: context.host.id, profiles: feature.faces }, context);
    if (!resolved.isOk) return Result.err(resolved.error);
    const { worldFaces, faceIds, owned } = resolved.value;
    try {
        const matched = matchSourceFaceIndexes(worldFaces, faceIds, feature.faces);
        if (!matched.isOk) return Result.err(matched.error);
        if (context.tracking !== undefined) {
            context.tracking.resolvedProfiles = matched.value.indexes.map((faceIndex, k) =>
                captureEmbossFaceRef(
                    worldFaces[faceIndex],
                    faceIds?.[faceIndex],
                    feature.faces[matched.value.refIndexes[k]].splitPiece,
                ),
            );
        }
        // Same enumeration as `resolveSourceFaces`' host path, before the world transform.
        const localFaces = input.findSubShapes(ShapeTypes.face) as IFace[];
        return Result.ok(matched.value.indexes.map((index) => localFaces[index]));
    } finally {
        owned.forEach((x) => x.dispose());
    }
}

/**
 * A target-face ref: the press-pull fingerprint (tracked id, `splitPiece`), with the outward
 * normal gate only for planar faces — a curved face's normal at its parameter origin says
 * nothing about where the face points.
 */
export function captureEmbossFaceRef(face: IFace, id?: string, splitPiece?: boolean) {
    return captureProfileRef(face, id, splitPiece, face.surface().isPlanar());
}

/**
 * Each profile swept straight through the body along the sketch normal: started beyond the
 * body on one side and swept past it on the other, so every face region under the profile is
 * inside the prism whatever side of the body the sketch lies on.
 */
function throughPrisms(
    sketch: SketchNode,
    profiles: IFace[],
    hostInvert: Matrix4,
    input: IShape,
    owned: IShape[],
): Result<IShape[]> {
    const normal = hostInvert.ofVector(sketch.plane.normal).normalize();
    if (normal === undefined) return Result.err("Emboss sketch plane has no normal");
    const identity = hostInvert.equals(Matrix4.identity());
    const local = profiles.map((face) => {
        if (identity) return face;
        const moved = face.transformedMul(hostInvert) as IFace;
        owned.push(moved);
        return moved;
    });
    // Nothing of the body is farther from the sketch plane than the diagonal of the box
    // holding both.
    const box = local.reduce((acc, x) => BoundingBox.combine(acc, x.boundingBox())!, input.boundingBox());
    const reach = BoundingBox.diagonal(box) + 1;
    const prisms: IShape[] = [];
    for (const face of local) {
        const start = face.transformedMul(translation(normal.multiply(-reach))) as IFace;
        owned.push(start);
        const prism = shapeFactory.prism(start, normal.multiply(2 * reach));
        if (!prism.isOk) return Result.err(prism.error);
        owned.push(prism.value);
        prisms.push(prism.value);
    }
    return Result.ok(prisms);
}

function translation(vec: XYZ): Matrix4 {
    return Matrix4.fromTranslation(vec.x, vec.y, vec.z);
}

/**
 * The patches of `face` inside `prism` that face the sketch plane, each thickened by
 * `thickness` along its outward normal (negative = into the body). Returned shapes are owned
 * by the caller.
 */
function thickenPatches(
    face: IFace,
    prism: IShape,
    origin: XYZ,
    normal: XYZ,
    thickness: number,
): Result<IShape[]> {
    const common = shapeFactory.booleanCommon([face], [prism]);
    if (!common.isOk) return Result.err(common.error);
    const pieces: IShape[] = [];
    try {
        for (const patch of common.value.findSubShapes(ShapeTypes.face) as IFace[]) {
            if (patch.area() <= 0 || !facesSketch(patch, origin, normal)) continue;
            const thick = shapeFactory.makeThickSolidBySimple(patch, thickness);
            if (!thick.isOk) {
                pieces.forEach((x) => x.dispose());
                return Result.err(thick.error);
            }
            // The simple offset builds an outward thickening inside out; flip it so the
            // boolean sees a positive-volume solid.
            if (thick.value.volume() < 0) thick.value.reserve();
            pieces.push(thick.value);
        }
    } finally {
        common.value.dispose();
    }
    return Result.ok(pieces);
}

/** Whether the patch's outward normal (at its parameter-space middle) points toward the sketch plane. */
function facesSketch(patch: IFace, origin: XYZ, normal: XYZ): boolean {
    const bounds = patch.inspectionUVBounds?.();
    const [u, v] = bounds?.isOk
        ? [(bounds.value.u1 + bounds.value.u2) / 2, (bounds.value.v1 + bounds.value.v2) / 2]
        : [0, 0];
    const [point, faceNormal] = patch.normal(u, v);
    const offset = origin.sub(point).dot(normal);
    // A sketch drawn on the face itself: whichever way its normal points, the face is the target.
    if (Math.abs(offset) < Precision.Distance)
        return Math.abs(faceNormal.normalize()?.dot(normal) ?? 0) > 0.5;
    return faceNormal.dot(offset > 0 ? normal : normal.multiply(-1)) > 0;
}

/**
 * Fuses (emboss) or cuts (deboss) the tool with the chain input. The tracked path keeps the
 * input's face/edge ids; the tool's sub-shapes get positional feature-scoped ids (new geometry).
 */
function combineWithInput(
    feature: EmbossFeatureData,
    context: FeatureContext,
    input: IShape,
    tool: IShape,
): Result<IShape> {
    const operation = feature.deboss === true ? "cut" : "fuse";
    const tracking = context.tracking;
    const tracked = trackedBoolean(operation);
    if (tracking === undefined || tracked === undefined) {
        return operation === "cut"
            ? shapeFactory.booleanCut([input], [tool])
            : shapeFactory.booleanFuse([input], [tool], true);
    }
    const result = tracked([input], [tool]);
    if (!result.isOk) return Result.err(result.error);
    const toolFaceIds = (tool.findSubShapes(ShapeTypes.face) as IFace[]).map(
        (_, index) => `${feature.id}:tool:f${index}`,
    );
    const toolEdgeIds = (tool.findSubShapes(ShapeTypes.edge) as IEdge[]).map(
        (_, index) => `${feature.id}:tool:e${index}`,
    );
    const { edgeMap, faceMap } = completeTrackedHistory([input, tool], result.value);
    tracking.outputFaceIds = mapOperationIds(
        feature.id,
        input,
        tracking.inputFaceIds,
        toolFaceIds,
        faceMap,
        ShapeTypes.face,
        result.value.faceAncestors,
    );
    tracking.outputEdgeIds = mapOperationIds(
        feature.id,
        input,
        tracking.inputEdgeIds,
        toolEdgeIds,
        edgeMap,
        ShapeTypes.edge,
        result.value.edgeAncestors,
    );
    return Result.ok(result.value.shape);
}

registerFeature("emboss", embossHandler);
