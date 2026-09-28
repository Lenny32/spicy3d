// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type ShapeMeshData, VisualConfig } from "@spicy3d/core";
import type { BooleanOperation } from "../features/feature";

/** A translucent, uniformly colored mesh a preview draws over its result. */
export interface PreviewOverlay {
    readonly meshes: ShapeMeshData[];
    readonly color: number;
    /** Face (and line) opacity, 0–1. */
    readonly opacity: number;
    /** Drawn without depth test, so a volume inside the result still shows. */
    readonly onTop?: boolean;
}

/** Opacity of the red tool volume a cut removes. */
export const CUT_TOOL_OPACITY = 0.35;

/** Opacity of the faint tint over the volume a join adds. */
export const JOIN_TINT_OPACITY = 0.18;

/**
 * How a boolean preview shows its tool on top of the result: a cut draws the removed volume
 * in translucent red over everything (the hole alone does not say what was taken away), a
 * join tints the added volume faintly where it is visible. Other operations add nothing.
 * `faces`/`edges` are the tool's meshes, in world placement.
 */
export function toolOverlay(
    operation: BooleanOperation | undefined,
    faces: ShapeMeshData | undefined,
    edges?: ShapeMeshData,
): PreviewOverlay | undefined {
    if (faces === undefined) return undefined;
    switch (operation) {
        case "cut":
            return {
                meshes: edges === undefined ? [faces] : [faces, edges],
                color: VisualConfig.cutPreviewColor,
                opacity: CUT_TOOL_OPACITY,
                onTop: true,
            };
        case "fuse":
            return { meshes: [faces], color: VisualConfig.joinPreviewColor, opacity: JOIN_TINT_OPACITY };
        default:
            return undefined;
    }
}
