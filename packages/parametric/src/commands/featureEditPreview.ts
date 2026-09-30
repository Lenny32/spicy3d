// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    Config,
    FEATURE_EDIT_PREVIEW_MODES,
    type FeatureEditPreviewMode,
    type IShape,
    Matrix4,
    PubSub,
    Result,
    type Scope,
    type ShapeMeshData,
    Transaction,
    withConstructionFeaturePosition,
} from "@spicy3d/core";
import type { FeatureTimelineState } from "../features/bodyTracking";
import {
    evaluateFeature,
    type FeatureContext,
    type FeatureData,
    type ShapeTracking,
} from "../features/feature";
import type { ParametricBodyNode } from "../parametricBodyNode";

/**
 * The preview of an edit session: what the body would look like with the edited feature.
 *
 * Two depths of preview, chosen by the user's `Config.featureEditPreview`:
 *
 * - **rollback** — only the edited step: the feature is evaluated on the chain state entering
 *   it (`timelineStateAt`), one kernel operation per change however long the timeline is. The
 *   later steps are simply not shown until the edit is confirmed.
 * - **live** — the edited step and then every later step replayed on its output, so the preview
 *   is the true final model. Costs the whole tail of the chain per change.
 * - **auto** (the default) — live whenever it keeps up: while the user drags, live only when the
 *   later steps rebuilt within {@link LIVE_PREVIEW_BUDGET_MS} last time (first from the body's
 *   cached timings, then from each live preview's own measurement); once the value settles
 *   (drag released, value typed), always live, so the resting preview is the real result.
 *
 * The replay runs with the kernel's shape tracking seeded from the timeline state, exactly like
 * the body's own chain, so later refs resolve by stable id as they will on commit. Nothing here
 * touches the body — no cache, no shape, no feature JSON — so cancelling a session has nothing
 * to undo.
 */

/** A live preview slower than this (ms) during a drag makes `auto` drop to the edited step. */
export const LIVE_PREVIEW_BUDGET_MS = 60;

export function featureEditPreviewMode(): FeatureEditPreviewMode {
    const mode = Config.instance.featureEditPreview;
    return FEATURE_EDIT_PREVIEW_MODES.includes(mode) ? mode : "auto";
}

export interface FeatureChainPreviewResult {
    /** The previewed shape in the body's local coordinates; owned by the caller. */
    readonly shape?: IShape;
    /** Why the edited step (or, with `shape` set, a later step) failed to rebuild. */
    readonly error?: string;
    /** True when the later steps were left out of `shape`. */
    readonly partial: boolean;
}

export class FeatureChainPreview {
    /** Last measured (or, before the first live run, estimated) cost of the later steps. */
    private _tailMs: number;
    /** The state entering the edited feature, captured before any session rollback. */
    private readonly entering: FeatureTimelineState | undefined;

    constructor(
        private readonly body: ParametricBodyNode,
        private readonly index: number,
        readonly mode: FeatureEditPreviewMode = featureEditPreviewMode(),
    ) {
        this.entering = body.timelineStateAt(index);
        this._tailMs = body.rebuildCostAfter(index);
    }

    /** True when there are later, unsuppressed steps a live preview would replay. */
    get hasTail(): boolean {
        return this.body.features.slice(this.index + 1).some((feature) => !feature.suppressed);
    }

    /** Whether a preview taken now includes the later steps (`interactive` = mid-drag). */
    includesTail(interactive: boolean): boolean {
        if (!this.hasTail) return false;
        switch (this.mode) {
            case "live":
                return true;
            case "rollback":
                return false;
            default:
                return !interactive || this._tailMs <= LIVE_PREVIEW_BUDGET_MS;
        }
    }

    /** The body with `feature` in place of the edited one; see the module header. */
    evaluate(feature: FeatureData, interactive: boolean): FeatureChainPreviewResult {
        // A position the last run never reached (the chain failed before it) has no input
        // to evaluate against; index 0 legitimately has none.
        if (this.index > 0 && this.entering === undefined) {
            return { error: "The steps before this feature failed to rebuild", partial: true };
        }
        const scope = this.body.document.variables.evaluate().scope;
        const input = this.entering?.shape;
        const edited = this.step(feature, this.index, input, this.entering, scope);
        if (!edited.isOk) return { error: edited.error, partial: true };
        if (!this.includesTail(interactive)) {
            return { shape: this.owned(edited.value.shape, input), partial: this.hasTail };
        }

        const started = performance.now();
        const tail = this.replayTail(edited.value, input, scope);
        this._tailMs = performance.now() - started;
        return tail;
    }

    /**
     * The feature context entering the edited feature (the body as host, its input and ids) — what
     * a session resolves the edited feature's references against, e.g. an extrude's to-object
     * face for its highlight. Undefined when the steps before it failed.
     */
    enteringContext(): FeatureContext | undefined {
        if (this.index > 0 && this.entering === undefined) return undefined;
        return {
            document: this.body.document,
            host: this.body,
            input: this.entering?.shape,
            scope: this.body.document.variables.evaluate().scope,
            tracking: {
                inputFaceIds: this.entering?.faceIds ?? [],
                outputFaceIds: [],
                inputEdgeIds: this.entering?.edgeIds ?? [],
                outputEdgeIds: [],
            },
        };
    }

    /**
     * `feature` alone on the state entering the edited one — never the later steps. An edit
     * session uses it for what the preview draws besides the body, e.g. an extrude's tool
     * volume (the feature without its operation). The shape is owned by the caller.
     */
    evaluateStep(feature: FeatureData): Result<IShape> {
        if (this.index > 0 && this.entering === undefined) {
            return Result.err("The steps before this feature failed to rebuild");
        }
        const scope = this.body.document.variables.evaluate().scope;
        const input = this.entering?.shape;
        const step = this.step(feature, this.index, input, this.entering, scope);
        return step.isOk ? Result.ok(this.owned(step.value.shape, input)) : Result.err(step.error);
    }

    /** Replays the features after the edited one on its output. */
    private replayTail(
        edited: { shape: IShape; state: FeatureTimelineState },
        input: IShape | undefined,
        scope: Scope,
    ): FeatureChainPreviewResult {
        let current = edited;
        const features = this.body.features;
        for (let index = this.index + 1; index < features.length; index++) {
            const feature = features[index];
            if (feature.suppressed) continue;
            const next = this.step(feature, index, current.shape, current.state, scope);
            if (!next.isOk) {
                // Show what the edit itself makes, and say why the rest does not follow.
                return { shape: this.owned(current.shape, input), error: next.error, partial: true };
            }
            if (next.value.shape !== current.shape && current.shape !== input) current.shape.dispose();
            current = next.value;
        }
        return { shape: this.owned(current.shape, input), partial: false };
    }

    /** One feature on `input`, tracked from `state`'s ids like the body's own chain. */
    private step(
        feature: FeatureData,
        index: number,
        input: IShape | undefined,
        state: FeatureTimelineState | undefined,
        scope: Scope,
    ): Result<{ shape: IShape; state: FeatureTimelineState }> {
        const tracking: ShapeTracking = {
            inputFaceIds: state?.faceIds ?? [],
            outputFaceIds: [],
            inputEdgeIds: state?.edgeIds ?? [],
            outputEdgeIds: [],
        };
        const result = withConstructionFeaturePosition(this.body.document, this.body.id, index, () =>
            evaluateFeature(feature, {
                document: this.body.document,
                host: this.body,
                input,
                scope,
                tracking,
            }),
        );
        if (!result.isOk) return Result.err(String(result.error));
        return Result.ok({
            shape: result.value,
            state: {
                shape: result.value,
                faceIds: tracking.outputFaceIds.length > 0 ? tracking.outputFaceIds : undefined,
                edgeIds: tracking.outputEdgeIds.length > 0 ? tracking.outputEdgeIds : undefined,
            },
        });
    }

    /**
     * The result as a shape the caller may dispose: a feature that hands its input back
     * unchanged returns the body's cached shape, which must never be disposed from here.
     */
    private owned(shape: IShape, input: IShape | undefined): IShape {
        return shape === input ? shape.transformedMul(Matrix4.identity()) : shape;
    }
}

/**
 * Meshes a preview shape (body-local) in world placement, disposing it. Undefined when the
 * kernel produced no face mesh.
 */
export function previewMeshes(body: ParametricBodyNode, shape: IShape): ShapeMeshData[] | undefined {
    let world: IShape = shape;
    try {
        const transform = body.worldTransform();
        world = transform.equals(Matrix4.identity()) ? shape : shape.transformedMul(transform);
        const { faces, edges } = world.mesh;
        if (faces === undefined) return undefined;
        return edges === undefined ? [faces] : [faces, edges];
    } finally {
        if (world !== shape) world.dispose();
        shape.dispose();
    }
}

/**
 * Opens an edit session on `body`: the selection goes (a selected body tints every edge and
 * face and would drown the handles and the preview), and history is off so nothing the
 * session does lands in the undo stack on its own. The returned function closes the session
 * — call it before committing, so the commit is the one recorded step.
 */
export function openFeatureEditSession(body: ParametricBodyNode): () => void {
    const document = body.document;
    document.selection.clearSelection();
    const history = document.history;
    const historyWasDisabled = history.disabled;
    history.disabled = true;
    return () => {
        history.disabled = historyWasDisabled;
        // Back to the body, so its feature list stays open after the edit.
        document.selection.setSelectedNodes([body], false);
    };
}

/**
 * Replaces the feature `edited.id` with `edited` as one undo step — or does nothing when the
 * session changed nothing, so confirming an untouched edit leaves no empty step behind.
 */
export function commitFeatureEdit(body: ParametricBodyNode, edited: FeatureData): boolean {
    const features = body.features;
    const original = features.find((x) => x.id === edited.id);
    if (original === undefined || canonicalJson(original) === canonicalJson(edited)) return false;
    Transaction.execute(body.document, "edit feature", () => {
        body.setFeaturesEmitShapeChanged(features.map((x) => (x.id === edited.id ? edited : x)));
        body.document.visual.update();
    });
    return true;
}

/** JSON with object keys sorted, so two payloads differing only in key order compare equal. */
function canonicalJson(value: unknown): string {
    return JSON.stringify(value, (_key, item) =>
        item !== null && typeof item === "object" && !Array.isArray(item)
            ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
            : item,
    );
}

/** Says why the preview cannot show the edit (or the steps after it); undefined clears it. */
export function showPreviewProblem(error: string | undefined): void {
    if (error === undefined) PubSub.default.pub("clearFloatTip");
    else PubSub.default.pub("showFloatTip", { level: "warn", msg: error });
}
