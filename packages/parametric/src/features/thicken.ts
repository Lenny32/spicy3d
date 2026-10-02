// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type IEdge,
    type IFace,
    type IShape,
    LENGTH_UNITS,
    Result,
    resolveUnitSpec,
    ShapeTypes,
    volumeTolerance,
} from "@spicy3d/core";
import { captureExtentFaceRef } from "./extrudeExtent";
import {
    type FeatureContext,
    type FeatureHandler,
    registerFeature,
    type ShapeTracking,
    type ThickenFeatureData,
    trackedIds,
} from "./feature";
import { completeEdgeHistory, completeFaceHistory } from "./historyCompletion";
import { matchSourceFaceIndexes } from "./sourceFaceMatcher";

/**
 * Thicken (shell): the body's previous shape made into a wall of `thickness`.
 *
 * - **A solid with open faces** is shelled through `makeThickSolidByJoin` — the picked faces are
 *   removed, every other face becomes a wall. The open faces are refs on the feature's input (the
 *   press-pull face matching: tracked id first, fingerprint fallback), re-anchored every rebuild.
 * - **A solid without open faces** is hollowed with a closed inner void: the solid offset by the
 *   thickness (inward when negative, outward when positive), and the difference of the two.
 * - **An open shell or a face** (a lofted skin, an extruded open profile) becomes a solid through
 *   `makeThickSolidBySimple`, which offsets along the face normals; the join type and mode do not
 *   apply. The kernel's `makeThickSolidByJoin` answers no solid for these inputs (the factory
 *   refuses it).
 *
 * The kernel works on a copy of the input, which it would otherwise modify (see `evaluate`).
 * The inputs are checked before any kernel call (an input the kernel rejects may raise inside it):
 * a shape to thicken, a valid one, a thickness that resolves to a non-zero length. A thick solid
 * the kernel returns inside out (negative volume: an outward offset of a closed shell) is turned
 * right side out before it is handed on.
 */

/** Below this (mm) a thickness counts as zero. */
const MIN_THICKNESS = 1e-6;
/** Tolerance of the orientation fix of an inside-out result. */
const FIX_TOLERANCE = 1e-6;
const INVALID_RESULT_ERROR = "Thicken produced an invalid solid";

const thickenHandler: FeatureHandler<ThickenFeatureData> = {
    display: "command.feature.thicken",
    icon: "icon-shell",

    nodeIds: () => [],

    parameters: (feature) => [
        {
            key: "thickness",
            display: "option.command.thickness",
            value: feature.thickness,
            unit: LENGTH_UNITS,
        },
    ],

    setParameter: (feature, key, value) =>
        key === "thickness" &&
        (typeof value === "string" || (typeof value === "number" && Number.isFinite(value)))
            ? { ...feature, [key]: value }
            : feature,

    applyResolvedRefs: (feature, { resolvedProfiles }) =>
        resolvedProfiles === undefined || (feature.openFaces ?? []).length === 0
            ? feature
            : { ...feature, openFaces: resolvedProfiles },

    evaluate(feature, context): Result<IShape> {
        const input = context.input;
        if (input === undefined || input.isNull()) return Result.err("Thicken requires a preceding feature");
        const thickness = resolveThickness(feature, context);
        if (!thickness.isOk) return Result.err(thickness.error);
        if (!input.checkShape()) return Result.err("The shape to thicken is invalid");

        // The offset algorithms add p-curves to and widen tolerances on the shape they read, and
        // `input` is the previous step's cached shape: they work on a copy. A copy keeps the
        // sub-shape order, so face refs matched on it hold for `input`.
        const owned = input.clone();
        let result: Result<IShape>;
        try {
            result = thickenShape(feature, context, owned, thickness.value);
        } finally {
            owned.dispose();
        }
        if (!result.isOk) return result;
        const oriented = rightSideOut(result.value);
        if (!oriented.isOk) return oriented;
        if (context.tracking !== undefined) trackThicken(feature.id, input, oriented.value, context.tracking);
        return oriented;
    },
};

/** The thickness as a concrete, non-zero length. */
export function resolveThickness(
    feature: ThickenFeatureData,
    context: Pick<FeatureContext, "scope">,
): Result<number> {
    const resolved = resolveUnitSpec(feature.thickness, context.scope, LENGTH_UNITS);
    if (!resolved.isOk) return Result.err(resolved.error);
    if (!Number.isFinite(resolved.value) || Math.abs(resolved.value) < MIN_THICKNESS) {
        return Result.err("The thickness must not be zero");
    }
    return resolved;
}

/** The kernel call for the input's kind (see the module comment). */
function thickenShape(
    feature: ThickenFeatureData,
    context: FeatureContext,
    input: IShape,
    thickness: number,
): Result<IShape> {
    const openFaces = feature.openFaces ?? [];
    if (feature.tolerant) {
        if (feature.mode === "pipe") return Result.err("Tolerant thicken requires skin mode");
        if (!shapeFactory.makeThickSolidTolerant)
            return Result.err("Tolerant thicken is not available in this kernel build");
        const faces = openFaces.length > 0 ? matchOpenFaces(feature, context, input) : Result.ok([]);
        if (!faces.isOk) return Result.err(faces.error);
        return shapeFactory.makeThickSolidTolerant(input, faces.value, thickness);
    }
    if (input.findSubShapes(ShapeTypes.solid).length === 0) {
        if (input.findSubShapes(ShapeTypes.face).length === 0) {
            return Result.err("Thicken needs faces or a solid");
        }
        if (openFaces.length > 0) return Result.err("Only a solid can have open faces");
        return shapeFactory.makeThickSolidBySimple(input, thickness);
    }
    const joinType = feature.joinType ?? "arc";
    const mode = feature.mode ?? "skin";
    if (openFaces.length > 0) {
        const faces = matchOpenFaces(feature, context, input);
        if (!faces.isOk) return Result.err(faces.error);
        return shapeFactory.makeThickSolidByJoin(input, faces.value, thickness, joinType, mode);
    }
    // No open faces: the offset solid and the input bound the wall between them.
    const offset = shapeFactory.makeThickSolidByJoin(input, [], thickness, joinType, mode);
    if (!offset.isOk) return offset;
    const oriented = rightSideOut(offset.value);
    if (!oriented.isOk) return oriented;
    try {
        const hollow =
            thickness < 0
                ? shapeFactory.booleanCut([input], [oriented.value])
                : shapeFactory.booleanCut([oriented.value], [input]);
        return hollow.isOk ? checked(hollow.value) : hollow;
    } finally {
        oriented.value.dispose();
    }
}

/** `shape` when it is a valid solid; disposed and refused otherwise. */
function checked(shape: IShape): Result<IShape> {
    if (shape.checkShape()) return Result.ok(shape);
    shape.dispose();
    return Result.err(INVALID_RESULT_ERROR);
}

/**
 * The open faces on the input, matched like press-pull source faces; the matched faces are
 * reported as the re-anchored refs (one per adopted face, keeping each ref's `splitPiece`).
 */
function matchOpenFaces(
    feature: ThickenFeatureData,
    context: FeatureContext,
    input: IShape,
): Result<IFace[]> {
    const refs = feature.openFaces ?? [];
    const faces = input.findSubShapes(ShapeTypes.face) as IFace[];
    const tracked = context.tracking?.inputFaceIds;
    const faceIds = tracked !== undefined && tracked.length === faces.length ? tracked : undefined;
    const matched = matchSourceFaceIndexes(faces, faceIds, refs);
    if (!matched.isOk) return Result.err(matched.error);
    if (context.tracking !== undefined) {
        context.tracking.resolvedProfiles = matched.value.indexes.map((faceIndex, k) =>
            captureExtentFaceRef(
                faces[faceIndex],
                faceIds?.[faceIndex],
                refs[matched.value.refIndexes[k]].splitPiece,
            ),
        );
    }
    return Result.ok(matched.value.indexes.map((index) => faces[index]));
}

/** `shape`, or its orientation-fixed copy when the kernel returned it inside out (negative volume). */
function rightSideOut(shape: IShape): Result<IShape> {
    if (shape.volume() >= -volumeTolerance(shape.volume(), shape.boundingBox()))
        return checkedOrientation(shape);
    const fixed = shape.fixSolid(FIX_TOLERANCE);
    shape.dispose();
    if (fixed.isNull() || fixed.volume() <= 0) {
        if (!fixed.isNull()) fixed.dispose();
        return Result.err("Thicken failed: the thick solid is inside out");
    }
    const valid = checked(fixed);
    return valid.isOk ? checkedOrientation(valid.value) : valid;
}

/** A positive compound total must not hide an inside-out component. No new analyzer calls. */
function checkedOrientation(shape: IShape): Result<IShape> {
    const solids = shape.findSubShapes(ShapeTypes.solid);
    try {
        const tolerance = solids.length ? volumeTolerance(shape.volume(), shape.boundingBox()) : 0;
        for (const [index, solid] of solids.entries()) {
            const volume = solid.volume();
            if (!Number.isFinite(volume) || volume < -tolerance) {
                shape.dispose();
                return Result.err(`Thicken result: solid ${index} has invalid volume (${volume} mm³)`);
            }
        }
    } finally {
        for (const solid of solids) solid.dispose();
    }
    return Result.ok(shape);
}

/**
 * Stable ids of the thickened shape. The kernel reports no history for thick solids, so it is
 * recovered from the geometry, which a thicken leaves unchanged on one side of the wall:
 *
 * - **Unchanged faces and edges keep their id.** An outer face of an inward shell, an inner face
 *   of an outward one, the original skin of a thickened shell — geometrically the input's face
 *   (edge), so history completion claims its input id back. A downstream fillet on an outer edge
 *   survives a thickness edit this way.
 * - **Everything the offset creates** (the offset walls, the rims around open faces and shell
 *   boundaries, the void's faces) takes a feature-scoped positional id, `<featureId>:<index>` —
 *   stable while the kernel enumerates the result the same way (a thickness edit does), so
 *   consumers re-verify such an id against their fingerprint (`trackedIds`).
 */
function trackThicken(featureId: string, input: IShape, shape: IShape, tracking: ShapeTracking): void {
    const inputFaces = input.findSubShapes(ShapeTypes.face) as IFace[];
    const inputEdges = input.findSubShapes(ShapeTypes.edge) as IEdge[];
    const outputFaces = shape.findSubShapes(ShapeTypes.face) as IFace[];
    const outputEdges = shape.findSubShapes(ShapeTypes.edge) as IEdge[];
    const faceMap = completeFaceHistory(inputFaces, outputFaces, new Array(outputFaces.length).fill(-1));
    const edgeMap = completeEdgeHistory(inputEdges, outputEdges, new Array(outputEdges.length).fill(-1));
    tracking.outputFaceIds = trackedIds(featureId, tracking.inputFaceIds, faceMap);
    tracking.outputEdgeIds = trackedIds(featureId, tracking.inputEdgeIds, edgeMap);
}

registerFeature("thicken", thickenHandler);
