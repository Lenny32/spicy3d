// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type I18nKeys,
    type IFace,
    Matrix4,
    type ParameterValue,
    VisualConfig,
    type VisualShapeData,
} from "@spicy3d/core";
import { captureExtentFaceRef } from "../features/extrudeExtent";
import type { ExtrudeExtent } from "../features/feature";
import { reportSilentIdLoss } from "../features/idDiagnostics";
import { ParametricBodyNode } from "../parametricBodyNode";
import type { PreviewOverlay } from "./toolOverlay";

/**
 * The extent options both extrude sessions (create and edit) show: the Extent combobox and, for
 * "To object", the picked face (highlighted over the preview) and its offset. See
 * `features/extrudeExtent.ts` for what each extent does.
 */

export const EXTENT_DISTANCE: I18nKeys = "option.command.extent.distance";
export const EXTENT_TO_OBJECT: I18nKeys = "option.command.extent.toObject";
export const EXTENT_THROUGH_ALL: I18nKeys = "option.command.extent.throughAll";

/** The Extent combobox's items, in order. */
export const EXTENT_OPTIONS: I18nKeys[] = [EXTENT_DISTANCE, EXTENT_TO_OBJECT, EXTENT_THROUGH_ALL];

const TYPES: Record<string, ExtrudeExtent["type"]> = {
    [EXTENT_DISTANCE]: "distance",
    [EXTENT_TO_OBJECT]: "toObject",
    [EXTENT_THROUGH_ALL]: "throughAll",
};

/** The extent type an Extent combobox item stands for. */
export function extentTypeOfKey(key: I18nKeys): ExtrudeExtent["type"] {
    return TYPES[key] ?? "distance";
}

/** The Extent combobox item of a stored extent (absent = distance). */
export function extentKeyOf(extent: ExtrudeExtent | undefined): I18nKeys {
    switch (extent?.type) {
        case "toObject":
            return EXTENT_TO_OBJECT;
        case "throughAll":
            return EXTENT_THROUGH_ALL;
        default:
            return EXTENT_DISTANCE;
    }
}

/** Opacity of the highlight over the face a to-object extent ends on. */
export const EXTENT_FACE_OPACITY = 0.55;

/** The face a to-object extent ends on (world placement), drawn highlighted over the preview. */
export function extentFaceOverlay(face: IFace): PreviewOverlay | undefined {
    const { faces } = face.mesh;
    if (faces === undefined) return undefined;
    return {
        meshes: [faces],
        color: VisualConfig.selectedFaceColor,
        opacity: EXTENT_FACE_OPACITY,
        onTop: true,
    };
}

/** The picked face in world coordinates; `owned` receives a transformed copy to dispose. */
export function worldFaceOf(data: VisualShapeData, owned: IFace[]): IFace {
    const face = data.shape as unknown as IFace;
    if (data.transform.equals(Matrix4.identity())) return face;
    const world = face.transformedMul(data.transform) as IFace;
    owned.push(world);
    return world;
}

/**
 * The to-object extent of a picked face: its fingerprint in world coordinates with the face's
 * tracked id when its body tracks ids (like a press-pull pick), and the body it is on.
 */
export function toObjectExtentOf(data: VisualShapeData, offset: ParameterValue): ExtrudeExtent {
    const node = data.owner.node;
    const owned: IFace[] = [];
    try {
        const world = worldFaceOf(data, owned);
        let faceId: string | undefined;
        let shared = false;
        if (node instanceof ParametricBodyNode) {
            faceId = node.faceIdAt(data.indexes[0]);
            if (faceId === undefined) reportSilentIdLoss(node, "face", "an extent face has no tracked id");
            shared = node.faceIdIsShared(faceId);
        }
        return {
            type: "toObject",
            nodeId: node.id,
            face: captureExtentFaceRef(world, faceId, shared),
            ...(offset !== 0 ? { offset } : {}),
        };
    } finally {
        owned.forEach((x) => x.dispose());
    }
}
