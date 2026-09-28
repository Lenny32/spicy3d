// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IDocument, type IShape, Matrix4, Result, ShapeNode } from "@spicy3d/core";
import { combineWithTool, extrudeToolShape } from "./extrude";
import { extentDependencies, extentNodeIds, toObjectExtents } from "./extrudeExtent";
import {
    type ExtrudeFeatureData,
    type ExtrudeTargetFeatureData,
    type FeatureContext,
    type FeatureData,
    type FeatureHandler,
    registerFeature,
} from "./feature";

/**
 * An extrude acting on more bodies than the one hosting it (Fusion's "Objects to cut").
 *
 * - **Where things live.** The extrude stays in its host body's feature list — its only copy
 *   of depth, profiles and operation. Every other target body holds an `extrudeTarget` entry
 *   at the position the extrude was applied at; the entry names the host and the extrude by
 *   id and replays the extrude's tool there with the extrude's operation, so an edit of the
 *   extrude reaches every target and a target keeps its own timeline order (a later fillet on
 *   it sees the cut).
 * - **Rebuild order.** The entry's body watches the host (`nodeIds`): the host rebuilds first,
 *   on any change of its own, and its new shape wakes the target, whose cache key carries the
 *   extrude's data and the host's placement (`cacheKey`) — the tool is rebuilt only when those
 *   or the sketch changed (`cacheRefIds`), never for the host's shape alone. That is what lets
 *   two bodies cut each other without rebuilding each other forever.
 * - **Deletion.** A removed target body takes its entry along. A removed host body, or an
 *   extrude gone from it, fails the entry with a clear error ("Linked extrude not found"), as
 *   a boolean does for a deleted tool — nothing is dropped silently; removing the extrude
 *   through its host (`ParametricBodyNode.removeFeature`) removes its entries too. A
 *   suppressed extrude has no effect on any body.
 * - **Scope.** Only sketch extrudes: a press-pull's tool is swept off its host's own chain
 *   state, which another body cannot replay.
 * - **Extents** (`extrudeExtent.ts`) are honoured the same way here as in the host: through all
 *   passes through this body (its input bounds the tool); a to-object face on this body resolves
 *   on its input, one on the host on the host's state entering the extrude — so every target is
 *   cut down to the same face. The face's body is watched too (`nodeIds`).
 */

/** A body with a feature list — structurally, so this module need not import the node class. */
interface IFeatureListHost {
    readonly id: string;
    readonly features: readonly FeatureData[];
    worldTransform(): Matrix4;
}

/** The extrude an `extrudeTarget` entry replays, and the body hosting it. */
export interface LinkedExtrude {
    readonly host: IFeatureListHost;
    readonly feature: ExtrudeFeatureData;
}

function isFeatureListHost(node: unknown): node is IFeatureListHost & ShapeNode {
    return node instanceof ShapeNode && Array.isArray((node as { features?: unknown }).features);
}

/** The extrude `link` points at, when its host body and the extrude both still exist. */
export function linkedExtrude(
    document: IDocument,
    link: ExtrudeTargetFeatureData,
): LinkedExtrude | undefined {
    const host = document.modelManager.findNode((n) => n.id === link.bodyId);
    if (!isFeatureListHost(host)) return undefined;
    const feature = host.features.find((x) => x.id === link.featureId);
    return feature?.type === "extrude" ? { host, feature } : undefined;
}

/**
 * Edit-session stand-ins, by extrude id: while an extrude is being edited, the entries of its
 * other targets replay the edited data (`null`: the target is being removed, no effect)
 * instead of the stored one — only inside `withLinkedExtrudeOverride`.
 */
const overrides = new Map<string, ExtrudeFeatureData | null>();

/** Runs `run` with the entries of extrude `featureId` replaying `edited` (see `overrides`). */
export function withLinkedExtrudeOverride<T>(
    featureId: string,
    edited: ExtrudeFeatureData | null,
    run: () => T,
): T {
    const had = overrides.has(featureId);
    const previous = overrides.get(featureId);
    overrides.set(featureId, edited);
    try {
        return run();
    } finally {
        if (had) overrides.set(featureId, previous ?? null);
        else overrides.delete(featureId);
    }
}

/**
 * What the linked extrude's to-object faces read, seen from the body holding `link` (see
 * `extentDependencies`): a face on that body resolves on its input, which the cache compares.
 */
function linkedExtentDependencies(
    document: IDocument,
    link: ExtrudeTargetFeatureData,
    linked: LinkedExtrude,
): { refIds: string[]; key: string[] } {
    if (toObjectExtents(linked.feature).length === 0) return { refIds: [], key: [] };
    const self = document.modelManager.findNode(
        (n) => isFeatureListHost(n) && n.features.some((x) => x.id === link.id),
    );
    return extentDependencies(document, linked.host.id, linked.feature, self?.id ?? "");
}

/** The input unchanged, its ids carried through, for an entry that has nothing to apply. */
function passThrough(context: FeatureContext): Result<IShape> {
    if (context.input === undefined) return Result.err("Extrude target requires a preceding feature");
    if (context.tracking !== undefined) {
        context.tracking.outputFaceIds = [...context.tracking.inputFaceIds];
        context.tracking.outputEdgeIds = [...context.tracking.inputEdgeIds];
    }
    return Result.ok(context.input);
}

/** hostWorld → the evaluating body's local space; undefined when the two coincide. */
function hostToBody(host: IFeatureListHost, context: FeatureContext): Matrix4 | undefined {
    const bodyInvert = context.host.worldTransform().invert();
    if (bodyInvert === undefined) return undefined;
    const matrix = bodyInvert.multiply(host.worldTransform());
    return matrix.equals(Matrix4.identity()) ? undefined : matrix;
}

const extrudeTargetHandler: FeatureHandler<ExtrudeTargetFeatureData> = {
    display: "command.feature.extrudeTarget",
    icon: "icon-prism",

    // Also the bodies of the extrude's to-object faces: moving one changes the tool here even when
    // the host's own result stays the same.
    nodeIds: (feature, document) => {
        const linked = document === undefined ? undefined : linkedExtrude(document, feature);
        const faces = linked === undefined ? [] : extentNodeIds(linked.feature);
        return [...new Set([feature.bodyId, ...faces])];
    },

    references: (feature) => [
        { key: "bodyId", display: "features.extrudeTarget.host", nodeId: feature.bodyId },
    ],

    cacheKey: (feature, document) => {
        const linked = linkedExtrude(document, feature);
        if (linked === undefined) return "missing";
        const { key } = linkedExtentDependencies(document, feature, linked);
        return JSON.stringify([linked.feature, linked.host.worldTransform().toArray(), key]);
    },

    cacheRefIds: (feature, document) => {
        const linked = linkedExtrude(document, feature);
        const sketchId = linked?.feature.sketchId;
        const refs = sketchId === undefined ? [] : [sketchId];
        if (linked === undefined) return refs;
        const { refIds } = linkedExtentDependencies(document, feature, linked);
        return [...new Set([...refs, ...refIds])];
    },

    parameters: () => [],

    setParameter: (feature) => feature,

    evaluate(feature, context): Result<IShape> {
        if (context.input === undefined) return Result.err("Extrude target requires a preceding feature");
        const linked = linkedExtrude(context.document, feature);
        if (linked === undefined) return Result.err("Linked extrude not found");
        const extrude = overrides.has(feature.featureId) ? overrides.get(feature.featureId) : linked.feature;
        if (extrude === null || extrude === undefined || extrude.suppressed) return passThrough(context);
        if (extrude.operation === undefined) return Result.err("Linked extrude has no join/cut/intersect");

        const matrix = hostToBody(linked.host, context);
        // Through all goes through this body: its input bounds the tool (in the host's space).
        const back = matrix?.invert();
        const bounds = back === undefined ? context.input : context.input.transformedMul(back);
        let tool: Result<IShape>;
        try {
            tool = extrudeToolShape(
                extrude,
                { ...context, host: linked.host, input: undefined, tracking: undefined },
                { current: context, bounds: [bounds] },
            );
        } finally {
            if (bounds !== context.input) bounds.dispose();
        }
        if (!tool.isOk) return Result.err(tool.error);
        const placed = matrix === undefined ? tool.value : tool.value.transformedMul(matrix);
        try {
            return combineWithTool(feature.id, extrude.operation, context, placed);
        } finally {
            // Intermediate inputs — the kernel reads them eagerly.
            if (placed !== tool.value) placed.dispose();
            tool.value.dispose();
        }
    },
};

registerFeature("extrudeTarget", extrudeTargetHandler);
