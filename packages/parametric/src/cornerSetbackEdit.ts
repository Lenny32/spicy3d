// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    AutosaveHolds,
    DocumentMutations,
    DocumentRebuilds,
    type IShape,
    Result,
    Transaction,
} from "@spicy3d/core";
import {
    type FilletFeatureData,
    featureHandler,
    resolveCornerSetbacks,
    type ShapeTracking,
} from "./features";
import type { ParametricBodyNode } from "./parametricBodyNode";

export interface CornerSetbackEditOptions {
    signal?: AbortSignal;
    label?: string;
    /** Only an interactive command may opt into its own command session. */
    allowActiveCommand?: boolean;
}

export interface PreparedCornerSetbackEdit {
    /** Borrowed until commit/dispose; clone it when a preview consumes its shape. */
    readonly previewShape: IShape;
    commit(options?: CornerSetbackEditOptions): Promise<Result<void>>;
    dispose(): void;
}

function requireEditable(body: ParametricBodyNode, options: CornerSetbackEditOptions): void {
    if (options.signal?.aborted) throw new Error("Corner setback edit was cancelled");
    if (body.document.repository?.isReadOnly) throw new Error("This document is read-only");
    if (body.rollbackIndex !== undefined) throw new Error("Finish the active timeline session first");
    if (body.document.application.executingCommand && !options.allowActiveCommand)
        throw new Error("Finish the active command before editing corner setbacks");
    if (Transaction.isActive(body.document) || DocumentMutations.isHeld(body.document))
        throw new Error("Another document mutation is running");
}

/** Fits off-model. Confirmation reuses this one result only if its entire input scope is unchanged. */
export async function prepareCornerSetbackEdit(
    body: ParametricBodyNode,
    candidate: FilletFeatureData,
    options: CornerSetbackEditOptions = {},
): Promise<Result<PreparedCornerSetbackEdit>> {
    try {
        requireEditable(body, options);
        void body.shape;
        if (!(await body.whenRebuilt())) throw new Error("The current body has a rebuild failure");
        requireEditable(body, options);
        const featuresJson = body.featuresJson;
        const features = body.features;
        const existing = features.findIndex((feature) => feature.id === candidate.id);
        const index = existing < 0 ? features.length : existing;
        if (existing >= 0 && features[index].type !== "fillet")
            throw new Error("Corner setbacks can only edit a fillet");
        const state = body.cornerEditStateAt(index);
        if (!state?.shape) throw new Error("The corner requires a preceding tracked solid");
        const input = state.shape;
        const scope = body.document.variables.evaluate().scope;
        const distances = resolveCornerSetbacks(candidate, scope);
        if (!distances.isOk) throw new Error(distances.error);
        const revision = DocumentRebuilds.revision(body.document);
        const scopeJson = JSON.stringify([...scope]);
        const feature = structuredClone(candidate);
        const tracking: ShapeTracking = {
            inputFaceIds: [...(state.faceIds ?? [])],
            inputEdgeIds: [...(state.edgeIds ?? [])],
            outputFaceIds: [],
            outputEdgeIds: [],
        };
        const pending = featureHandler("fillet")?.prepareAsync?.(feature, {
            document: body.document,
            host: body,
            input,
            scope,
            tracking,
            meshResult: true,
        });
        if (!pending || pending.canFallback !== false)
            throw new Error("Corner setbacks require strict worker recomputation");
        const cancel = () => pending.cancel();
        options.signal?.addEventListener("abort", cancel, { once: true });
        let result: Result<IShape>;
        try {
            if (options.signal?.aborted) pending.cancel();
            await pending.ready;
            result = pending.take();
        } finally {
            options.signal?.removeEventListener("abort", cancel);
        }
        if (!result.isOk) return Result.err(result.error);
        const output = result.value;
        let consumed = false;
        let closed = false;
        const dispose = () => {
            if (closed) return;
            closed = true;
            if (!consumed) output.dispose();
        };
        if (options.signal?.aborted) {
            dispose();
            return Result.err("Corner setback edit was cancelled");
        }
        const current = () =>
            !body.isRebuilding &&
            body.featuresJson === featuresJson &&
            DocumentRebuilds.revision(body.document) === revision &&
            JSON.stringify([...body.document.variables.evaluate().scope]) === scopeJson &&
            body.cornerEditStateAt(index)?.shape === input;
        return Result.ok({
            previewShape: output,
            dispose,
            async commit(commitOptions = {}) {
                let owner: ReturnType<typeof DocumentMutations.hold> | undefined;
                let uninstall: (() => void) | undefined;
                let releaseAutosave: (() => void) | undefined;
                const abort = () => owner?.run(() => body.cancelCornerEditRebuild());
                try {
                    requireEditable(body, commitOptions);
                    if (closed || !current()) throw new Error("Corner preview is stale; recompute it");
                    if (existing >= 0 && JSON.stringify(features[existing]) === JSON.stringify(feature)) {
                        dispose();
                        return Result.ok(undefined);
                    }
                    owner = DocumentMutations.hold(body.document);
                    releaseAutosave = AutosaveHolds.hold("corner setback edit");
                    uninstall = body.installPreparedCorner({
                        json: JSON.stringify(feature),
                        input,
                        tracking,
                        take: () => {
                            if (consumed || closed) return Result.err("Corner preview was already consumed");
                            consumed = true;
                            return Result.ok(output);
                        },
                    });
                    commitOptions.signal?.addEventListener("abort", abort, { once: true });
                    await Transaction.executeAsync(
                        body.document,
                        commitOptions.label ?? "corner setbacks",
                        async () => {
                            owner!.run(() =>
                                body.setFeaturesEmitShapeChanged(
                                    existing < 0
                                        ? [...features, feature]
                                        : features.map((item) => (item.id === feature.id ? feature : item)),
                                ),
                            );
                            if (commitOptions.signal?.aborted) abort();
                            const success = await body.whenRebuilt();
                            await DocumentRebuilds.settled(body.document);
                            if (commitOptions.signal?.aborted)
                                throw new Error("Corner setback edit was cancelled");
                            if (!success || !body.shape.isOk)
                                throw new Error(
                                    body.featureItems().find((item) => item.error)?.error ??
                                        "Corner feature rebuild failed",
                                );
                        },
                        owner,
                    );
                    closed = true;
                    return Result.ok(undefined);
                } catch (error) {
                    return Result.err(error instanceof Error ? error.message : String(error));
                } finally {
                    commitOptions.signal?.removeEventListener("abort", abort);
                    uninstall?.();
                    // Rollback may schedule a rebuild of the prior feature; finish it while authority is held.
                    if (owner) await DocumentRebuilds.settled(body.document);
                    owner?.release();
                    releaseAutosave?.();
                    dispose();
                }
            },
        });
    } catch (error) {
        return Result.err(error instanceof Error ? error.message : String(error));
    }
}

/** Dedicated asynchronous editor/MCP entry: one worker fit and one atomic, validated undo step. */
export async function applyCornerSetbackEdit(
    body: ParametricBodyNode,
    featureId: string,
    cornerSetbacks: NonNullable<FilletFeatureData["cornerSetbacks"]>,
    options: CornerSetbackEditOptions = {},
): Promise<Result<void>> {
    const feature = body.features.find((item) => item.id === featureId);
    if (!feature || feature.type !== "fillet") return Result.err("The selected fillet no longer exists");
    if (JSON.stringify(feature.cornerSetbacks) === JSON.stringify(cornerSetbacks)) {
        try {
            requireEditable(body, options);
            return Result.ok(undefined);
        } catch (error) {
            return Result.err(error instanceof Error ? error.message : String(error));
        }
    }
    const prepared = await prepareCornerSetbackEdit(body, { ...feature, cornerSetbacks }, options);
    if (!prepared.isOk) return Result.err(prepared.error);
    return prepared.value.commit(options);
}
