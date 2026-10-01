// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    BoundingBox,
    type ICylindricalSurface,
    type IEdge,
    type IFace,
    type IShape,
    LENGTH_UNITS,
    Matrix4,
    Plane,
    Precision,
    Result,
    resolveUnitSpec,
    ShapeTypes,
    type XYZ,
} from "@spicy3d/core";
import { trackedBoolean } from "./boolean";
import { reliefIds } from "./embossIdentity";
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
import { matchSourceFaceIndexes } from "./sourceFaceMatcher";

/**
 * Emboss / deboss: raises (or recesses) the region of a body's faces that a sketch's profiles
 * project onto, by a depth measured along the face — Fusion-style, so the result follows curved
 * faces (a projected patch on a cylinder keeps a constant relief height) instead of being a
 * flat-topped prism like an extrude.
 *
 * The kernel steps, all on the host's local space:
 * 1. every profile is swept through the whole body along the sketch normal (both ways) — or,
 *    for a target face on a plane parallel to the sketch, simply moved onto that plane;
 * 2. each target face is intersected with each prism (or moved profile), giving the face patches under the
 *    profile — only patches facing the sketch plane are kept (a profile over a cylinder's side
 *    face must not also emboss its far side);
 * 3. each patch is thickened by `depth` along its outward normal (`makeThickSolidBySimple`),
 *    outwards for emboss, inwards for deboss;
 * 4. the thickened patches, as separate tools, are fused to (emboss) or cut from (deboss) the chain input, on the
 *    tracked path when available so the body's own face/edge ids survive.
 *
 * Target faces are stored like press-pull source faces (`ProfileRef`s captured in host-local
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
        key === "deboss" && typeof value === "boolean"
            ? { ...feature, deboss: value }
            : key === "depth" &&
                (typeof value === "string" || (typeof value === "number" && Number.isFinite(value)))
              ? { ...feature, depth: value }
              : feature,

    applyResolvedRefs: (feature, { resolvedProfiles, resolvedFaces }) => ({
        ...feature,
        profiles: resolvedProfiles ?? feature.profiles,
        faces: resolvedFaces === undefined ? feature.faces : Object.values(resolvedFaces),
    }),

    evaluate(feature, context): Result<IShape> {
        try {
            return evaluateEmboss(feature, context);
        } catch (error) {
            return Result.err(`Emboss failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    },
};

function evaluateEmboss(feature: EmbossFeatureData, context: FeatureContext): Result<IShape> {
    const input = context.input;
    if (input === undefined || input.isNull()) return Result.err("Emboss requires a preceding feature");
    if (!input.checkShape()) return Result.err("Emboss requires a valid solid");
    const solids = input.findSubShapes(ShapeTypes.solid);
    try {
        if (solids.length === 0) return Result.err("Emboss requires a solid body");
    } finally {
        solids.forEach((solid) => {
            solid.dispose();
        });
    }
    if (typeof feature.deboss !== "boolean") return Result.err("Emboss mode must be a boolean");
    if (!Array.isArray(feature.profiles) || feature.profiles.length === 0)
        return Result.err("Emboss requires selected profiles");
    if (typeof feature.depth !== "number" && typeof feature.depth !== "string")
        return Result.err("Emboss depth must be a length");
    const depth = resolveUnitSpec(feature.depth, context.scope, LENGTH_UNITS);
    if (!depth.isOk) return Result.err(depth.error);
    if (!Number.isFinite(depth.value) || depth.value <= Precision.Distance)
        return Result.err("Emboss depth must be positive");

    const tools = buildEmbossTools(feature, context, input, depth.value);
    if (!tools.isOk) return Result.err(tools.error);
    try {
        return combineWithInput(feature, context, input, tools.value);
    } finally {
        // The thickened patches are an intermediate input — the kernel reads them eagerly.
        tools.value.forEach((x) => {
            x.shape.dispose();
        });
    }
}

interface EmbossTool {
    readonly shape: IShape;
    readonly faceIds: string[];
    readonly edgeIds: string[];
}

/** The thickened face patches under the profiles, one solid each (host local space). */
function buildEmbossTools(
    feature: EmbossFeatureData,
    context: FeatureContext,
    input: IShape,
    depth: number,
): Result<EmbossTool[]> {
    const sketch = findSketch(context.document, feature.sketchId);
    if (sketch === undefined) return Result.err("Sketch not found");
    const profiles = resolveProfiles(sketch, feature.profiles);
    if (!profiles.isOk) return Result.err(profiles.error);
    if (profiles.value.length === 0) return Result.err("Emboss sketch has no closed profile");

    if (context.tracking)
        context.tracking.resolvedProfiles = profiles.value.map(({ face }) => captureProfileRef(face));
    const targets = resolveTargetFaces(feature, context, input);
    if (!targets.isOk) return Result.err(targets.error);

    const hostInvert = context.host.worldTransform().invert();
    if (hostInvert === undefined) {
        targets.value.forEach(({ face }) => {
            face.dispose();
        });
        return Result.err("Emboss host placement is not invertible");
    }
    const normal = hostInvert.ofVector(sketch.plane.normal).normalize();
    if (normal === undefined) {
        targets.value.forEach(({ face }) => {
            face.dispose();
        });
        return Result.err("Emboss sketch plane has no normal");
    }
    const origin = hostInvert.ofPoint(sketch.plane.origin);
    const owned: IShape[] = targets.value.map(({ face }) => face);
    const pieces: EmbossTool[] = [];
    let success = false;
    try {
        const local = localProfiles(
            profiles.value.map(({ face }) => face),
            hostInvert,
            owned,
        );
        let prisms: Result<IShape[]> | undefined;
        for (const { face: target, seed: targetSeed } of targets.value) {
            const visible = visibleTarget(target, origin, normal, input, owned);
            if (!visible.isOk) return Result.err(visible.error);
            for (const face of visible.value) {
                // A plane parallel to the sketch clips a copy of each profile moved onto it — a
                // coplanar common, an order of magnitude cheaper than cutting the face by a prism.
                const plane = parallelPlane(face, origin, normal);
                let clips: IShape[];
                if (plane === undefined) {
                    prisms ??= throughPrisms(local, normal, input, owned);
                    if (!prisms.isOk) {
                        return Result.err(prisms.error);
                    }
                    clips = prisms.value;
                } else {
                    clips = local.map((x) => {
                        const moved = x.transformedMul(translation(normal.multiply(plane.offset))) as IFace;
                        owned.push(moved);
                        // A coplanar common keeps the tool's side: the patch must face like the target.
                        if (moved.normal(0, 0)[1].dot(plane.normal) < 0) moved.reserve();
                        return moved;
                    });
                }
                for (const [profileIndex, clip] of clips.entries()) {
                    const thickened = thickenPatches(
                        face,
                        clip,
                        origin,
                        normal,
                        feature.deboss ? -depth : depth,
                        local[profileIndex],
                        profiles.value[profileIndex].face,
                        `${feature.id}:relief:${targetSeed}:${profiles.value[profileIndex].seed}`,
                    );
                    if (!thickened.isOk) {
                        return Result.err(thickened.error);
                    }
                    pieces.push(...thickened.value);
                }
            }
        }
        if (pieces.length === 0) return Result.err("Emboss profiles do not project onto the selected faces");
        success = true;
        return Result.ok(pieces);
    } finally {
        owned.forEach((x) => {
            x.dispose();
        });
        if (!success)
            pieces.forEach((x) => {
                x.shape.dispose();
            });
    }
}

/** Match host-local targets on the input, never on this feature's output. Returned faces are owned. */
function resolveTargetFaces(
    feature: EmbossFeatureData,
    context: FeatureContext,
    input: IShape,
): Result<{ face: IFace; seed: string }[]> {
    if (!Array.isArray(feature.faces) || feature.faces.length === 0)
        return Result.err("Emboss has no target face");
    const faces = input.findSubShapes(ShapeTypes.face) as IFace[];
    let retained: number[] = [];
    try {
        const ids = context.tracking?.inputFaceIds;
        const matched = matchSourceFaceIndexes(
            faces,
            ids?.length === faces.length ? ids : undefined,
            feature.faces,
        );
        if (!matched.isOk) return Result.err(matched.error);
        const anchors = matched.value.indexes.map((index, k) =>
            captureEmbossFaceRef(
                faces[index],
                ids?.[index],
                feature.faces[matched.value.refIndexes[k]].splitPiece,
            ),
        );
        if (context.tracking) {
            context.tracking.resolvedFaces = Object.fromEntries(
                anchors.map((anchor, k) => [`face${k}`, anchor]),
            );
        }
        retained = matched.value.indexes;
        return Result.ok(
            retained.map((index, k) => ({
                face: faces[index],
                seed: anchors[k].id ?? `target${matched.value.refIndexes[k]}`,
            })),
        );
    } finally {
        faces.forEach((face, index) => {
            if (!retained.includes(index)) face.dispose();
        });
    }
}

/** Host-local fingerprint with an outward-normal gate for planar target faces only. */
export function captureEmbossFaceRef(face: IFace, id?: string, splitPiece?: boolean) {
    const surface = face.surface();
    try {
        return captureProfileRef(face, id, splitPiece, surface.isPlanar());
    } finally {
        surface.dispose();
    }
}

/** The profile faces in the host's local space (moved copies are added to `owned`). */
function localProfiles(profiles: IFace[], hostInvert: Matrix4, owned: IShape[]): IFace[] {
    if (hostInvert.equals(Matrix4.identity())) return profiles;
    return profiles.map((face) => {
        const moved = face.transformedMul(hostInvert) as IFace;
        owned.push(moved);
        return moved;
    });
}

/** Clip cylinders at their silhouette before profile clipping; a connected patch may cross the far side. */
function visibleTarget(
    face: IFace,
    origin: XYZ,
    normal: XYZ,
    input: IShape,
    owned: IShape[],
): Result<IFace[]> {
    const surface = face.surface();
    try {
        if (surface.isPlanar()) return Result.ok([face]);
        if (!("radius" in surface) || "area" in surface || !("axis" in surface))
            return Result.err("Emboss supports planar and cylindrical target faces");
        const cylinder = surface as ICylindricalSurface;
        const axis = cylinder.axis.normalize();
        if (!axis) return Result.err("Emboss target cylinder has no axis");
        const radial = normal.sub(axis.multiply(normal.dot(axis))).normalize();
        if (!radial) return Result.err("Emboss projection is parallel to the cylinder axis");
        // An oblique plane meets the infinite axis. Use the axis point at the finite
        // target's midpoint to choose its near half, measuring signed plane distance.
        // Both an in-plane sketch-origin shift and an axial cylinder-origin shift
        // then leave the selected half unchanged.
        const center = BoundingBox.center(face.boundingBox());
        const axisPoint = cylinder.location.add(axis.multiply(center.sub(cylinder.location).dot(axis)));
        const side = origin.sub(axisPoint).dot(normal);
        if (Math.abs(side) <= Precision.Distance)
            return Result.err("Emboss sketch plane must lie outside the cylinder axis");
        const facing = side > 0 ? radial : radial.multiply(-1);
        const tangent = axis.cross(facing);
        const reach = BoundingBox.diagonal(input.boundingBox()) + origin.sub(cylinder.location).length() + 1;
        const plane = new Plane({
            origin: cylinder.location.sub(tangent.multiply(reach)).sub(axis.multiply(reach)),
            normal: facing,
            xvec: tangent,
        });
        const half = shapeFactory.box(plane, reach * 2, reach * 2, reach);
        if (!half.isOk) return Result.err(half.error);
        owned.push(half.value);
        const common = shapeFactory.booleanCommon([face], [half.value]);
        if (!common.isOk) return Result.err(common.error);
        owned.push(common.value);
        const pieces = common.value.findSubShapes(ShapeTypes.face) as IFace[];
        owned.push(...pieces);
        if (pieces.length === 0) return Result.err("Emboss cylindrical target has no visible patch");
        return Result.ok(pieces);
    } finally {
        surface.dispose();
    }
}

/**
 * For a planar `face` parallel to the sketch: the signed distance along `normal` from the
 * sketch plane to the face's plane, and the face's unit normal; undefined otherwise.
 */
function parallelPlane(face: IFace, origin: XYZ, normal: XYZ): { offset: number; normal: XYZ } | undefined {
    const surface = face.surface();
    try {
        if (!surface.isPlanar()) return undefined;
    } finally {
        surface.dispose();
    }
    const [point, faceNormal] = face.normal(0, 0);
    const unit = faceNormal.normalize();
    if (unit === undefined || Math.abs(unit.dot(normal)) < Math.cos(Precision.Angle)) return undefined;
    return { offset: point.sub(origin).dot(normal), normal: unit };
}

/**
 * Each profile swept straight through the body along the sketch normal: started beyond the
 * body on one side and swept past it on the other, so every face region under the profile is
 * inside the prism whatever side of the body the sketch lies on.
 */
function throughPrisms(local: IFace[], normal: XYZ, input: IShape, owned: IShape[]): Result<IShape[]> {
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
 * The patches of `face` inside `clip` (a through-prism, or a profile copy on `face`'s plane)
 * that face the sketch plane, each thickened by
 * `thickness` along its outward normal (negative = into the body). Returned shapes are owned
 * by the caller.
 */
function thickenPatches(
    face: IFace,
    clip: IShape,
    origin: XYZ,
    normal: XYZ,
    thickness: number,
    profile: IFace,
    originalProfile: IFace,
    seed: string,
): Result<EmbossTool[]> {
    const common = shapeFactory.booleanCommon([face], [clip]);
    if (!common.isOk)
        return common.error === "Boolean produced an empty shape" ? Result.ok([]) : Result.err(common.error);
    const pieces: EmbossTool[] = [];
    const patches = common.value.findSubShapes(ShapeTypes.face) as IFace[];
    let success = false;
    try {
        for (const patch of patches) {
            if (
                patch.area() <= Precision.Distance * Precision.Distance ||
                !facesSketch(patch, origin, normal)
            )
                continue;
            const thick = shapeFactory.makeThickSolidBySimple(patch, thickness);
            if (!thick.isOk) return Result.err(thick.error);
            try {
                pieces.push({
                    shape: thick.value,
                    ...reliefIds(thick.value, patch, profile, originalProfile, normal, seed),
                });
            } catch (error) {
                thick.value.dispose();
                throw error;
            }
            if (thick.value.volume() < 0) thick.value.reserve();
            if (
                !thick.value.checkShape() ||
                !Number.isFinite(thick.value.volume()) ||
                thick.value.volume() <= 0
            )
                return Result.err("Emboss produced an invalid relief solid");
        }
        success = true;
        return Result.ok(pieces);
    } finally {
        patches.forEach((patch) => {
            patch.dispose();
        });
        common.value.dispose();
        if (!success)
            pieces.forEach((piece) => {
                piece.shape.dispose();
            });
    }
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
 * Fuses (emboss) or cuts (deboss) the tools with the chain input. The tracked path keeps the
 * input's face/edge ids; relief sub-shapes inherit their profile boundary ancestry.
 */
function combineWithInput(
    feature: EmbossFeatureData,
    context: FeatureContext,
    input: IShape,
    tools: EmbossTool[],
): Result<IShape> {
    const operation = feature.deboss ? "cut" : "fuse";
    const shapes = tools.map((tool) => tool.shape);
    const tracking = context.tracking;
    const tracked = trackedBoolean(operation);
    if (tracking === undefined || tracked === undefined) {
        const result =
            operation === "cut"
                ? shapeFactory.booleanCut([input], shapes)
                : shapeFactory.booleanFuse([input], shapes, true);
        return result.isOk ? checkedResult(result.value) : result;
    }
    const result = tracked([input], shapes);
    if (!result.isOk) return Result.err(result.error);
    const owned: IShape[] = [];
    try {
        const inputFaces = input.findSubShapes(ShapeTypes.face);
        const inputEdges = input.findSubShapes(ShapeTypes.edge);
        owned.push(...inputFaces, ...inputEdges);
        const toolFaces = shapes.flatMap((shape) => shape.findSubShapes(ShapeTypes.face));
        const toolEdges = shapes.flatMap((shape) => shape.findSubShapes(ShapeTypes.edge));
        owned.push(...toolFaces, ...toolEdges);
        const toolFaceIds = tools.flatMap((tool) => tool.faceIds),
            toolEdgeIds = tools.flatMap((tool) => tool.edgeIds);
        const history = completeTrackedHistory([input, ...shapes], result.value, {
            inputFaces: [...inputFaces, ...toolFaces] as IFace[],
            inputEdges: [...inputEdges, ...toolEdges] as IEdge[],
        });
        owned.push(...history.outputFaces, ...history.outputEdges);
        tracking.outputFaceIds = mapOperationIds(
            feature.id,
            input,
            tracking.inputFaceIds,
            toolFaceIds,
            history.faceMap,
            ShapeTypes.face,
            result.value.faceAncestors,
        );
        tracking.outputEdgeIds = mapOperationIds(
            feature.id,
            input,
            tracking.inputEdgeIds,
            toolEdgeIds,
            history.edgeMap,
            ShapeTypes.edge,
            result.value.edgeAncestors,
        );
        return checkedResult(result.value.shape);
    } catch (error) {
        result.value.shape.dispose();
        throw error;
    } finally {
        owned.forEach((shape) => {
            shape.dispose();
        });
    }
}

function checkedResult(shape: IShape): Result<IShape> {
    if (shape.checkShape() && Number.isFinite(shape.volume()) && shape.volume() > 0) return Result.ok(shape);
    shape.dispose();
    return Result.err("Emboss produced an invalid solid");
}

registerFeature("emboss", embossHandler);
