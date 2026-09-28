// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { BoundingBox, type IDocument, type IShape } from "@spicy3d/core";
import type { BooleanOperation } from "../features/feature";
import { ParametricBodyNode } from "../parametricBodyNode";

/**
 * How an extrude's tool volume meets a body:
 * - `overlap` — it goes into the body's material (the common volume is not negligible);
 * - `touch` — it only touches the body (a shared face, edge or point) and grows outside it;
 * - `none` — the two are apart.
 */
export type ExtrudeContact = "overlap" | "touch" | "none";

/** Gap (mm) under which the tool and a body count as touching. */
export const CONTACT_DISTANCE_TOLERANCE = 1e-4;

/**
 * Share of the tool's volume the common volume must exceed to count as an overlap: a tool
 * sitting on a face shares it, and the kernel's common of two face-touching solids can come
 * out as a sliver of numerical noise instead of exactly zero.
 */
export const OVERLAP_VOLUME_RATIO = 1e-6;

/** Floor (mm³) of the overlap threshold, for tiny tools. */
export const OVERLAP_MIN_VOLUME = 1e-9;

/**
 * Classifies how `tool` meets `body` (both in the same coordinates). The bounding boxes are a
 * fast pre-filter; then the common volume decides overlap and the minimum distance touching.
 */
export function classifyContact(tool: IShape, body: IShape): ExtrudeContact {
    if (!BoundingBox.isIntersect(tool.boundingBox(), body.boundingBox(), CONTACT_DISTANCE_TOLERANCE)) {
        return "none";
    }
    const threshold = Math.max(OVERLAP_MIN_VOLUME, Math.abs(tool.volume()) * OVERLAP_VOLUME_RATIO);
    if (commonVolume(tool, body) > threshold) return "overlap";
    const distance = tool.extremaDistance(body);
    // A negative distance is the kernel reporting that it found no solution.
    return distance >= 0 && distance <= CONTACT_DISTANCE_TOLERANCE ? "touch" : "none";
}

/** Volume of the boolean common of `tool` and `body`; zero when the kernel produced none. */
function commonVolume(tool: IShape, body: IShape): number {
    const common = shapeFactory.booleanCommon([body], [tool]);
    if (!common.isOk) return 0;
    try {
        const volume = Math.abs(common.value.volume());
        return Number.isFinite(volume) ? volume : 0;
    } finally {
        common.value.dispose();
    }
}

/** The body an extrude combines with, and how its tool meets that body. */
export interface ExtrudeTarget {
    readonly node: ParametricBodyNode;
    readonly contact: Exclude<ExtrudeContact, "none">;
}

export interface ExtrudeTargetOptions {
    /** Bodies hidden in the tree are candidates too (default false). */
    readonly includeHidden?: boolean;
}

/**
 * The body `tool` combines with: the first parametric body (tree order) the tool goes into,
 * else the first one it touches; undefined when it meets none. Bodies whose shape failed
 * to build are skipped.
 */
export function findExtrudeTarget(
    document: IDocument,
    tool: IShape,
    options: ExtrudeTargetOptions = {},
): ExtrudeTarget | undefined {
    const candidates = document.modelManager.findNodes(
        (node) =>
            node instanceof ParametricBodyNode &&
            node.shape.isOk &&
            (options.includeHidden === true || (node.visible && node.parentVisible)),
    ) as ParametricBodyNode[];
    let touching: ParametricBodyNode | undefined;
    for (const node of candidates) {
        const contact = classifyContact(tool, node.shape.value);
        if (contact === "overlap") return { node, contact };
        if (contact === "touch") touching ??= node;
    }
    return touching === undefined ? undefined : { node: touching, contact: "touch" };
}

/**
 * The Auto operation (Fusion-style): into a body's material = cut, touching a body and
 * growing outward = join, no contact = a new body (undefined).
 */
export function autoOperation(
    target: ExtrudeTarget | undefined,
): Extract<BooleanOperation, "cut" | "fuse"> | undefined {
    if (target === undefined) return undefined;
    return target.contact === "overlap" ? "cut" : "fuse";
}
