// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IDocument } from "../document";
import { Result } from "../foundation/result";
import type { INode } from "../model";
import { ShapeNode } from "../model/shapeNode";
import type { Serialized } from "../serialize";
import { DocumentView } from "./documentView";
import { joinPath, nodeLabel } from "./paths";
import { MergeRules } from "./rules";
import { CONFLICT_MESSAGE_KEYS, isWithinMergePath, type MergeConflict, type MergeResult } from "./types";

// The validation pass (docs/merge.md, "Validation pass (WASM)"): the merged document is loaded
// without views and rebuilt; a feature or node that fails there but succeeds in every parent that
// has it is a `rebuild-failure`. The rebuild needs the kernel and a real document, so the loading
// is behind `IMergeEvaluator` (the app's `HeadlessDocumentEvaluator`); what is compared, and when
// it becomes a conflict, is here. Slow on big models: progress and cancel.

/** How one node rebuilt: its error, and for a feature-list body each feature's. */
export interface NodeRebuildStatus {
    readonly error?: string;
    readonly features?: readonly { readonly id: string; readonly label: string; readonly error?: string }[];
}

/**
 * A node that reports its own rebuild status — a parametric body (per feature), a construction
 * (its resolution). Other shape nodes report their `shape`.
 */
export interface IRebuildStatusSource {
    /** Evaluates the node if needed and reports how it went. */
    rebuildStatus(): NodeRebuildStatus;
}

export function isRebuildStatusSource(node: unknown): node is IRebuildStatusSource {
    return typeof (node as Partial<IRebuildStatusSource> | null)?.rebuildStatus === "function";
}

/** One failure of a rebuild. */
export interface RebuildFailure {
    readonly nodeId: string;
    readonly featureId?: string;
    readonly label: string;
    readonly error: string;
}

/** Every failure of one document's rebuild, by path (`node/<id>/rebuild`, `node/<body>/feature/<id>/rebuild`). */
export type RebuildReport = ReadonlyMap<string, RebuildFailure>;

export interface RebuildOptions {
    readonly signal?: AbortSignal;
    /** Called after each node: `done` of `total` nodes evaluated. */
    readonly onProgress?: (done: number, total: number) => void;
}

export type RebuildError =
    | { readonly kind: "cancelled" }
    | { readonly kind: "failed"; readonly message: string };

/** Loads a serialized document without views, rebuilds every node and reports the failures. */
export interface IMergeEvaluator {
    evaluate(data: Serialized, options?: RebuildOptions): Promise<Result<RebuildReport, RebuildError>>;
}

/** The evaluator the validation pass uses unless given one (the app registers its headless one). */
export class MergeEvaluators {
    private static evaluator: IMergeEvaluator | undefined;

    static get current(): IMergeEvaluator | undefined {
        return MergeEvaluators.evaluator;
    }

    /** Replaces the evaluator; returns a function that puts the previous one back. */
    static register(evaluator: IMergeEvaluator): () => void {
        const previous = MergeEvaluators.evaluator;
        MergeEvaluators.evaluator = evaluator;
        return () => {
            if (MergeEvaluators.evaluator === evaluator) MergeEvaluators.evaluator = previous;
        };
    }
}

/** A macrotask break, so a cancel (an abort event) and the UI get their turn during a long rebuild. */
const yieldToEvents = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function statusOf(node: INode): NodeRebuildStatus | undefined {
    if (isRebuildStatusSource(node)) return node.rebuildStatus();
    if (node instanceof ShapeNode) {
        const shape = node.shape;
        return shape.isOk ? {} : { error: String(shape.error) };
    }
    return undefined;
}

/**
 * Rebuilds every node of a loaded document, in tree order, and reports its failures. Yields to
 * the event loop between nodes; an aborted `signal` stops it (`cancelled`).
 */
export async function collectRebuildReport(
    document: IDocument,
    options: RebuildOptions = {},
): Promise<Result<RebuildReport, RebuildError>> {
    const nodes = document.modelManager.findNodes();
    const report = new Map<string, RebuildFailure>();
    for (const [index, node] of nodes.entries()) {
        if (options.signal?.aborted) return Result.err({ kind: "cancelled" });
        const status = statusOf(node);
        const label = node.name || node.id;
        const failedFeatures = status?.features?.filter((f) => f.error !== undefined) ?? [];
        for (const feature of failedFeatures) {
            report.set(joinPath("node", node.id, "feature", feature.id, "rebuild"), {
                nodeId: node.id,
                featureId: feature.id,
                label: feature.label,
                error: feature.error!,
            });
        }
        if (status?.error !== undefined && failedFeatures.length === 0) {
            report.set(joinPath("node", node.id, "rebuild"), { nodeId: node.id, label, error: status.error });
        }
        options.onProgress?.(index + 1, nodes.length);
        await yieldToEvents();
    }
    if (options.signal?.aborted) return Result.err({ kind: "cancelled" });
    return Result.ok(report);
}

export interface ValidateMergeOptions extends RebuildOptions {
    /** Defaults to {@link MergeEvaluators.current}. */
    readonly evaluator?: IMergeEvaluator;
    /** The sides' reports when known already (their own last rebuild); evaluated otherwise. */
    readonly ours?: RebuildReport;
    readonly theirs?: RebuildReport;
}

/**
 * The validation pass: rebuilds `result.merged` (and the parents without a cached report) and adds
 * a `rebuild-failure` for every feature or node failing only in the merge — not in a parent that
 * has it, and not where a `dangling-ref` already points. The structural result stays usable
 * meanwhile; cancelling (`signal`) leaves it as it was.
 */
export async function validateMerge(
    result: MergeResult,
    options: ValidateMergeOptions = {},
): Promise<Result<MergeResult, RebuildError>> {
    const evaluator = options.evaluator ?? MergeEvaluators.current;
    if (evaluator === undefined) return Result.err({ kind: "failed", message: "no document evaluator" });
    const pending: ("merged" | "ours" | "theirs")[] = ["merged"];
    if (options.ours === undefined) pending.push("ours");
    if (options.theirs === undefined) pending.push("theirs");
    const reports: Partial<Record<"merged" | "ours" | "theirs", RebuildReport>> = {
        ours: options.ours,
        theirs: options.theirs,
    };
    const documents = { merged: result.merged, ours: result.inputs.ours, theirs: result.inputs.theirs };
    for (const [phase, which] of pending.entries()) {
        let report: Result<RebuildReport, RebuildError>;
        try {
            report = await evaluator.evaluate(documents[which], {
                signal: options.signal,
                onProgress: (done, total) =>
                    options.onProgress?.(phase * total + done, pending.length * total),
            });
        } catch (error) {
            // an evaluator that throws is a failed validation, never a rejected promise
            report = Result.err({
                kind: "failed",
                message: error instanceof Error ? error.message : String(error),
            });
        }
        if (!report.isOk) return Result.err(report.error);
        reports[which] = report.value;
    }
    const conflicts = rebuildFailureConflicts(result, reports.merged!, reports.ours!, reports.theirs!);
    return Result.ok({ ...result, conflicts: [...result.conflicts, ...conflicts] });
}

/**
 * The `rebuild-failure`s of a merge from the three reports (pure): failures of `merged` that no
 * parent having the node (and feature) shares, skipping locations a `dangling-ref` covers, in
 * merged tree order.
 */
export function rebuildFailureConflicts(
    result: MergeResult,
    merged: RebuildReport,
    ours: RebuildReport,
    theirs: RebuildReport,
): MergeConflict[] {
    const views = {
        merged: new DocumentView("merged", result.merged, MergeRules),
        ours: new DocumentView("ours", result.inputs.ours, MergeRules),
        theirs: new DocumentView("theirs", result.inputs.theirs, MergeRules),
    };
    const dangling = result.conflicts.filter((c) => c.kind === "dangling-ref").map((c) => c.path);
    const found: { conflict: MergeConflict; rank: number }[] = [];
    for (const [path, failure] of merged) {
        const item =
            failure.featureId === undefined
                ? joinPath("node", failure.nodeId)
                : joinPath("node", failure.nodeId, "feature", failure.featureId);
        if (dangling.some((d) => isWithinMergePath(d, item))) continue;
        const parents = (["ours", "theirs"] as const).filter((side) => {
            const view = views[side];
            if (!view.byId.has(failure.nodeId)) return false;
            return (
                failure.featureId === undefined ||
                (view.timeline(failure.nodeId) ?? []).includes(failure.featureId)
            );
        });
        const reports = { ours, theirs };
        if (parents.length === 0 || parents.some((side) => reports[side].has(path))) continue;
        found.push({
            rank: views.merged.index.get(failure.nodeId) ?? Number.MAX_SAFE_INTEGER,
            conflict: {
                kind: "rebuild-failure",
                path,
                base: undefined,
                ours: undefined,
                theirs: undefined,
                messageKey: CONFLICT_MESSAGE_KEYS["rebuild-failure"],
                args: [
                    failure.featureId === undefined
                        ? nodeLabel(views.merged.byId.get(failure.nodeId), failure.nodeId)
                        : failure.label,
                    failure.error,
                ],
                choices: ["accept"],
            },
        });
    }
    found.sort((a, b) => a.rank - b.rank);
    return found.map((x) => x.conflict);
}
