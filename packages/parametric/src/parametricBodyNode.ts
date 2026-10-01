// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type AsyncController,
    ConstructionNode,
    DocumentMutations,
    DocumentRebuilds,
    type FeatureItem,
    type FeatureReference,
    featureSketchIds,
    type I18nKeys,
    type IAsyncShapeOperation,
    type IDocument,
    type IEqualityComparer,
    type IFeatureListNode,
    type INode,
    type INodeLinkedList,
    type INodeReferences,
    type IShape,
    isPropertyChanged,
    NodeChildList,
    type NodeRebuildStatus,
    type NodeRecord,
    ParameterShapeNode,
    PerformanceTrace,
    PubSub,
    type RebuildOptions,
    Result,
    type Scope,
    ShapeNode,
    serializable,
    serialize,
    Transaction,
    withConstructionFeaturePosition,
} from "@spicy3d/core";
import { hasFeatureEditor, startFeatureEdit } from "./commands/featureEditRegistry";
import { ReselectFeatureCommand } from "./commands/reselectCommand";
import { EdgeReselectSession, ProfileReselectSession } from "./commands/reselectSession";
import { evaluateFeature, type FeatureData, featureHandler, type ShapeTracking } from "./features";
import {
    BodyTimeline,
    type FeatureCacheEntry,
    type RefSnapshot,
    sameTransform,
} from "./features/bodyTimeline";
import {
    type FeatureTimelineState,
    type IBodyTimelineNode,
    isBodyTimelineNode,
} from "./features/bodyTracking";
import type { EdgeRef } from "./features/edgeRef";
import { findSketch } from "./features/extrude";
import type { BooleanFeatureData, ExtrudeFeatureData } from "./features/feature";
import type { ProfileRef } from "./features/profileRef";
import { syncNodeWatches } from "./nodeWatch";
import { RebuildJob, type RebuildSteps } from "./rebuildJob";
import { danglingProfileRefs, SketchNode } from "./sketch/sketchNode";
import { trackVariableScope } from "./variableScope";
import { ensureVariableSync } from "./variableSync";

/**
 * The parametric body: a node whose geometry is DERIVED by replaying an ordered feature list.
 *
 * `featuresJson` is the only serialized state — an array of `FeatureData`. No shape is ever
 * stored; every rebuild re-runs the list from the top, which is what makes an upstream edit (move
 * a line in a sketch) propagate: the chain re-evaluates and everything downstream follows.
 *
 * One run of `evaluateChain`:
 *
 * 1. For each feature in order, `featureHandler(feature.type).evaluate(feature, context)` gets
 *    the previous feature's shape and returns this one's. A `Result.err` stops the chain and the
 *    previous shape and cache are KEPT — a failed rebuild is never shown.
 * 2. `ShapeTracking` collects each step's stable sub-shape ids and the stored refs it actually
 *    matched; `refreshAnchoredRefs` writes those back into the feature JSON, so the next edit
 *    measures drift from the latest match rather than from the original pick.
 * 3. Per-feature results are cached (`BodyTimeline`) keyed on the feature JSON, the variable
 *    variable dependencies, and the identity of the input and referenced shapes — so editing one feature only
 *    re-evaluates from that feature on.
 *
 * Where to look:
 *
 * - **Editing the list** (add / move / suppress / rename) — "Feature list editing".
 * - **Re-picking referenced shapes** — the section of that name; the interaction itself lives in
 *   `commands/reselectSession.ts`.
 * - **How a run works** — "Chain evaluation" and its "Cache plumbing".
 * - **Stable ids across rebuilds** — "Tracking facade" is the query surface other layers call;
 *   `features/` is where the ids are actually built.
 * - **Why a rebuilt sketch is re-followed before the chain reads it** — "Following referenced
 *   sketches".
 *
 * `docs/parametric.md` has the module's wider architecture.
 */

/** Shape plus tracked sub-shape ids produced by evaluating one feature. */
interface FeatureStepOutput {
    readonly shape: IShape;
    readonly faceIds?: string[];
    readonly edgeIds?: string[];
    /** Fingerprints the feature actually matched this run — re-anchored into the feature. */
    readonly resolvedProfiles?: ProfileRef[];
    /** Edge anchors the feature actually matched this run — re-anchored into the feature. */
    readonly resolvedEdges?: EdgeRef[];
    readonly resolvedFaces?: Record<string, ProfileRef>;
}

export interface ParametricBodyNodeOptions {
    document: IDocument;
    features?: FeatureData[];
    /** Serialized form produced by the Serializer; takes precedence over `features`. */
    featuresJson?: string;
    id?: string;
}

interface RebuildRun {
    readonly trigger: string;
    synchronous: boolean;
    readonly current: () => boolean;
    outcome: "cancelled" | "failed" | "success";
    cancelReason?: string;
    failure?: "feature" | "empty-shape" | "exception";
    failedFeatureId?: string;
}

/** A body whose shape is replayed from its feature list — see the module header above. */
@serializable()
export class ParametricBodyNode
    extends ParameterShapeNode
    implements IFeatureListNode, INodeLinkedList, INodeReferences, IBodyTimelineNode
{
    /**
     * Consumed boolean tools live under the body (see `syncConsumedTools`). Children
     * never render in the scene — the tree lists them grayed under the body, where
     * selecting one still opens its feature list for editing.
     */
    private readonly _children: NodeChildList = new NodeChildList(this, () => false);

    // ------------------------------------------------------------------ Node plumbing: the linked-list contract

    get firstChild() {
        return this._children.firstChild;
    }
    get lastChild() {
        return this._children.lastChild;
    }
    size(): number {
        return this._children.count;
    }
    add(...items: INode[]): void {
        this._children.add(...items);
    }
    remove(...items: INode[]): void {
        this._children.remove(...items);
    }
    transfer(...items: INode[]): void {
        this._children.transfer(...items);
    }
    insertBefore(target: INode | undefined, node: INode): void {
        this._children.insertBefore(target, node);
    }
    insertAfter(target: INode | undefined, node: INode): void {
        this._children.insertAfter(target, node);
    }
    move(child: INode, newParent: this, newPreviousSibling?: INode): void {
        this._children.move(child, newParent, newPreviousSibling);
    }

    override display(): I18nKeys {
        return "body.parametricBody";
    }

    @serialize()
    get featuresJson(): string {
        return this.getPrivateValue("featuresJson");
    }
    set featuresJson(value: string) {
        this.setPropertyEmitShapeChanged("featuresJson", value);
    }

    get features(): FeatureData[] {
        return JSON.parse(this.featuresJson);
    }

    /** Referenced nodes (sketches) currently watched for shape changes, by id. */
    private readonly _watched = new Map<string, INode>();
    private readonly _featureErrors = new Map<string, string>();
    /** Non-fatal conditions surfaced on the feature row (e.g. a sketch's dangling external refs). */
    private readonly _featureWarnings = new Map<string, string>();
    /** What the last successful run produced — cache entries and per-index chain states. */
    private readonly _timeline = new BodyTimeline();
    /** Guards against re-entrant evaluation when a watched node generates mid-evaluation. */
    private _evaluating = false;
    /** False until the first evaluation; see the `shape` getter. */
    private _evaluated = false;
    private _job?: RebuildJob;
    private _run?: RebuildRun;
    private _forceSynchronous = false;
    private _preparedCorner?: {
        json: string;
        input: IShape;
        tracking: ShapeTracking;
        take(): Result<IShape>;
    };

    /** Runtime-only, single-use candidate; exact input identity is checked at consumption. */
    installPreparedCorner(candidate: NonNullable<ParametricBodyNode["_preparedCorner"]>): () => void {
        if (this._preparedCorner) throw new Error("A corner candidate is already installed");
        this._preparedCorner = candidate;
        return () => {
            if (this._preparedCorner === candidate) this._preparedCorner = undefined;
        };
    }

    cancelCornerEditRebuild(): void {
        this.cancelRebuild("corner-edit-cancelled");
    }
    private _replayCancelled = false;
    private _lastRebuildSucceeded = true;
    /** Nested consumers must finish against the caller's in-flight timeline, without yielding. */
    private static evaluationDepth = 0;
    private static readonly ASYNC_FEATURE_THRESHOLD = 12;
    private static readonly synchronousDocuments = new WeakMap<IDocument, number>();

    /**
     * Ordered programs capture topology between writes and validate each write before continuing.
     * Their callback must remain synchronous. The scope is document-local and nestable; incoming
     * scheduled work is drained before the first read, and interactive scheduling resumes on exit.
     */
    static withSynchronousEvaluation<T>(document: IDocument, action: () => T): T {
        const depth = ParametricBodyNode.synchronousDocuments.get(document) ?? 0;
        ParametricBodyNode.synchronousDocuments.set(document, depth + 1);
        try {
            DocumentRebuilds.flush(document);
            return action();
        } finally {
            if (depth === 0) ParametricBodyNode.synchronousDocuments.delete(document);
            else ParametricBodyNode.synchronousDocuments.set(document, depth);
        }
    }

    get isRebuilding(): boolean {
        return this._job !== undefined;
    }

    async whenRebuilt(): Promise<boolean> {
        while (this._job) await this._job.settled;
        return !this._isDisposed && this._lastRebuildSucceeded;
    }
    /**
     * Runtime-only session state (never serialized, never transacted): when set,
     * `evaluateChain` replays only the features before this index. The sketch editor
     * rolls the body back to the edited sketch's timeline position for the session
     * (see `computeSketchRollback`), and `pickFeatureEdges` uses the same mechanism
     * for its pre-feature pick preview — both leave the feature list and the undo
     * history untouched.
     */
    private _rollbackIndex: number | undefined;
    private _displayRollbackIndex: number | undefined;

    // ------------------------------------------------------------------ Session rollback

    /** The active session-rollback position (`IBodyTimelineNode.rollbackIndex`). */
    get rollbackIndex(): number | undefined {
        // Between batches, a restoration still displays the preview. Only the active
        // feature evaluation may resolve references against the requested full timeline.
        return this._evaluating ? this._rollbackIndex : (this._rollbackIndex ?? this._displayRollbackIndex);
    }

    /**
     * Truncates the feature replay at `index` (undefined restores the full chain) and
     * re-evaluates. Returns false when the replay failed: the last good shape is kept
     * (the same policy as watched-node rebuilds), so the displayed geometry is NOT
     * the requested timeline position — the caller should revert the rollback rather
     * than let plane/external-reference resolution read it as one.
     */
    setRollbackIndex(index: number | undefined, asynchronous = false): boolean {
        this._forceSynchronous = !asynchronous;
        try {
            const result = this.updateRollbackIndex(index);
            if (!asynchronous) this._job?.flush();
            return result && (this._job !== undefined || this._lastRebuildSucceeded);
        } finally {
            this._forceSynchronous = false;
        }
    }

    /**
     * Accepts an interactive rollback/restore. If `isRebuilding`, await `whenRebuilt` for
     * its outcome before reading the requested geometry. Unchanged requests stay synchronous.
     */
    requestRollbackIndex(index: number | undefined): boolean {
        return this.setRollbackIndex(index, true);
    }

    private updateRollbackIndex(index: number | undefined): boolean {
        if (this._isDisposed) return false;
        const clamped = index === undefined ? undefined : Math.max(0, Math.min(index, this.features.length));
        if (
            this._rollbackIndex === clamped &&
            (this._job || (this._lastRebuildSucceeded && this._evaluated))
        ) {
            return true;
        }
        this._rollbackIndex = clamped;
        const result = this.generateShape(clamped === undefined ? "restore" : "rollback");
        if (this._job) return true;
        if (!result.isOk) return false;
        this.shape = result;
        this.document.visual.update();
        return this._job !== undefined || this._lastRebuildSucceeded;
    }

    // ------------------------------------------------------------------ Construction, shape invalidation and consumed tools

    constructor(options: ParametricBodyNodeOptions) {
        super({ document: options.document, id: options.id });
        this.setPrivateValue("featuresJson", options.featuresJson ?? JSON.stringify(options.features ?? []));
        this.document.modelManager.addNodeObserver(this.handleReferencedNodeChanged);
        this.document.history.onBeforeReplay.sub(this.beforeHistoryReplay);
        this.document.history.onAfterReplay.sub(this.afterHistoryReplay);
        this.document.history.onChanged.sub(this.historyChanged);
        ensureVariableSync(options.document);
    }

    setFeaturesEmitShapeChanged(features: FeatureData[]): void {
        this.setPropertyEmitShapeChanged("featuresJson", JSON.stringify(features));
    }

    protected override setPropertyEmitShapeChanged<K extends keyof this>(
        property: K,
        newValue: this[K],
        onPropertyChanged?: (property: K, oldValue: this[K]) => void,
        equals?: IEqualityComparer<this[K]> | undefined,
    ): boolean {
        const changed = super.setPropertyEmitShapeChanged(property, newValue, onPropertyChanged, equals);
        if (changed && property === "featuresJson") this.syncConsumedTools();
        return changed;
    }

    /**
     * Moves consumed boolean tools under this node and releases the rest back next to
     * it. Idempotent — rewriting `featuresJson` to an equivalent list moves nothing.
     * Skipped while history is disabled: undo/redo restores the recorded moves itself.
     */
    private syncConsumedTools(): void {
        if (this.document.history.disabled) return;
        const desired = new Set(
            this.features
                .filter((x): x is BooleanFeatureData => x.type === "boolean" && x.consumeTools !== false)
                .flatMap((x) => x.toolIds),
        );
        let child = this.firstChild;
        // Released tools land after the previously released one so the tree order
        // matches the order they had under the body.
        let anchor: INode = this;
        while (child !== undefined) {
            const next = child.nextSibling;
            if (!desired.has(child.id) && this.parent !== undefined) {
                this.transfer(child);
                this.parent.insertAfter(anchor, child);
                anchor = child;
            }
            child = next;
        }
        for (const id of desired) {
            const node = this.document.modelManager.findNode((n) => n.id === id);
            if (!(node instanceof ShapeNode) || node === this || node.parent === this) continue;
            if (this.isAncestor(node)) continue;
            node.parent?.transfer(node);
            this.add(node);
        }
    }

    /** True when `node` is on this node's ancestor chain — moving it here would cycle. */
    private isAncestor(node: INode): boolean {
        let ancestor = this.parent;
        while (ancestor !== undefined) {
            if (ancestor === node) return true;
            ancestor = ancestor.parent;
        }
        return false;
    }

    /** The merge's validation pass (`IRebuildStatusSource`): the body's shape and each feature's error. */
    async prepareRebuildStatus(options: RebuildOptions = {}): Promise<void> {
        if (
            !this.features.some(
                (feature) =>
                    feature.type === "fillet" && !feature.suppressed && feature.cornerSetbacks !== undefined,
            )
        )
            return;
        const cancel = () => this.cancelRebuild("validation-cancelled");
        if (options.signal?.aborted) {
            cancel();
            return;
        }
        options.signal?.addEventListener("abort", cancel, { once: true });
        try {
            void this.shape;
            await this.whenRebuilt();
        } finally {
            options.signal?.removeEventListener("abort", cancel);
        }
    }

    rebuildStatus(): NodeRebuildStatus {
        void this.shape;
        this._job?.flush();
        const shape = this.shape;
        return {
            error: shape.isOk ? undefined : String(shape.error),
            features: this.features.map((feature) => ({
                id: feature.id,
                label: feature.name || `${feature.type} ${feature.id}`,
                error: this._featureErrors.get(feature.id),
            })),
        };
    }

    // ------------------------------------------------------------------ Feature list editing

    featureItems(): readonly FeatureItem[] {
        return this.features.map((feature) => {
            const handler = featureHandler(feature.type);
            const display = handler?.display;
            const icon = handler?.icon;
            return {
                id: feature.id,
                name: feature.name,
                display:
                    typeof display === "function"
                        ? display(feature)
                        : (display ?? ("common.name" as I18nKeys)),
                icon: typeof icon === "function" ? icon(feature) : icon,
                suppressed: feature.suppressed === true,
                error: this._featureErrors.get(feature.id),
                warning: this._featureWarnings.get(feature.id),
                reselectable: handler?.reselectable === true,
                editable: hasFeatureEditor(feature.type),
                references: this.featureReferences(feature),
                dependsOn: handler?.nodeIds(feature, this.document).filter((id) => id !== this.id),
                parameters: handler?.parameters(feature) ?? [],
            };
        });
    }

    /**
     * The feature's declared references resolved to nodes, dangles dropped — a
     * deleted sketch leaves the feature's rebuild error as the only trace, same as
     * it did when the tree held the reference rows.
     */
    private featureReferences(feature: FeatureData): FeatureReference[] | undefined {
        const refs = (featureHandler(feature.type)?.references?.(feature) ?? []).flatMap((ref) => {
            const node = this.referenceNode(feature, ref.key);
            return node === undefined ? [] : [{ key: ref.key, display: ref.display, node }];
        });
        return refs.length > 0 ? refs : undefined;
    }

    /** Resolves one declared reference by key; undefined when it was deleted. */
    private referenceNode(feature: FeatureData, key: string): INode | undefined {
        const declared = featureHandler(feature.type)?.references?.(feature);
        const nodeId = declared?.find((ref) => ref.key === key)?.nodeId;
        return nodeId === undefined ? undefined : this.document.modelManager.findNode((n) => n.id === nodeId);
    }

    /**
     * Opens the node a feature's reference points at, by publishing the same
     * `nodeDoubleClicked` the tree and viewport do — what "opening" means is the
     * node's business (a sketch enters its editing session; see `sketch/index.ts`).
     */
    activateReference(featureId: string, key: string): void {
        const feature = this.features.find((x) => x.id === featureId);
        if (feature === undefined) return;
        const node = this.referenceNode(feature, key);
        if (node !== undefined) PubSub.default.pub("nodeDoubleClicked", node);
    }

    setFeatureParameter(featureId: string, key: string, value: number | string | boolean): void {
        const features = this.features.map((feature) => {
            if (feature.id !== featureId) return feature;
            return featureHandler(feature.type)?.setParameter(feature, key, value) ?? feature;
        });
        this.setFeaturesEmitShapeChanged(features);
    }

    setFeatureSuppressed(featureId: string, suppressed: boolean): void {
        const features = this.features.map((feature) =>
            feature.id === featureId ? { ...feature, suppressed } : feature,
        );
        this.setFeaturesEmitShapeChanged(features);
    }

    moveFeature(featureId: string, offset: -1 | 1): void {
        const features = [...this.features];
        const index = features.findIndex((feature) => feature.id === featureId);
        const target = index + offset;
        if (index < 0 || target < 0 || target >= features.length) return;
        [features[index], features[target]] = [features[target], features[index]];
        this.setFeaturesEmitShapeChanged(features);
    }

    moveFeatureTo(featureId: string, index: number): void {
        const features = [...this.features];
        const from = features.findIndex((feature) => feature.id === featureId);
        if (from < 0) return;
        const [feature] = features.splice(from, 1);
        features.splice(Math.max(0, Math.min(index, features.length)), 0, feature);
        this.setFeaturesEmitShapeChanged(features);
    }

    /** Renaming does not change geometry — record and notify without a rebuild. */
    renameFeature(featureId: string, name: string): void {
        const features = this.features.map((feature) =>
            feature.id === featureId ? { ...feature, name: name === "" ? undefined : name } : feature,
        );
        this.setProperty("featuresJson", JSON.stringify(features));
    }

    /**
     * Removes the feature. An extrude that also acts on other bodies takes its
     * `extrudeTarget` entries there along (same undo step when the caller transacts), so
     * removing it undoes its effect everywhere instead of leaving them failing.
     */
    removeFeature(featureId: string): void {
        this.setFeaturesEmitShapeChanged(this.features.filter((feature) => feature.id !== featureId));
        for (const node of this.document.modelManager.findNodes((n) => n instanceof ParametricBodyNode)) {
            const body = node as ParametricBodyNode;
            if (body === this) continue;
            const kept = body.features.filter(
                (x) => !(x.type === "extrudeTarget" && x.bodyId === this.id && x.featureId === featureId),
            );
            if (kept.length !== body.features.length) body.setFeaturesEmitShapeChanged(kept);
        }
    }

    // ------------------------------------------------------------------ Interactive editing

    /**
     * Reopens a feature in the same interactive session that created it — the extrude's drag
     * arrow, the fillet's edge pick with its value arrow, the revolve's angle handle — seeded
     * with the stored values. Runs as the application's executing command (see
     * `startFeatureEdit`), so starting any other command cancels it cleanly.
     */
    async editFeature(featureId: string): Promise<void> {
        await startFeatureEdit(this, featureId);
    }

    /**
     * What replaying the features after `index` cost on their last evaluation (ms), from the
     * cached timings — an edit session's guess at whether a live full-chain preview keeps up
     * with a drag. Cache entries exist only for evaluated (unsuppressed) features, in order.
     */
    rebuildCostAfter(index: number): number {
        const start = this.features.slice(0, index + 1).filter((feature) => !feature.suppressed).length;
        return this._timeline.evaluationMsFrom(start);
    }

    // ------------------------------------------------------------------ Re-picking referenced shapes

    /**
     * Re-picks the shapes a feature references and replaces its stored refs — edges of
     * a fillet/chamfer, profiles of an extrude. The pick runs as a
     * `ReselectFeatureCommand` registered as the application's executing command, so
     * starting any other command mid-pick cancels this session through the command
     * service's normal lifecycle — its cleanup (restoring the rollback preview and
     * re-enabling the history) always completes before the new command runs.
     */
    async reselectShapes(featureId: string): Promise<void> {
        const type = this.features.find((feature) => feature.id === featureId)?.type;
        if (type === "sweep" || type === "faceSweep") {
            await this.editFeature(featureId);
            return;
        }
        await ReselectFeatureCommand.start(this, featureId);
    }

    /**
     * The pick session of `reselectShapes`, driven by `ReselectFeatureCommand` with the
     * command's controller — cancelling the command cancels this pick. The interaction
     * itself lives in the session classes; all this does is route to the right one and
     * transact the confirmed refs, keeping undo one step. For edge features the session
     * rolls the body back to just before the feature for the duration of the pick (the
     * stored refs were captured from that pre-feature geometry). The body node is
     * re-selected afterwards so the feature panel stays open.
     */
    async reselectSession(featureId: string, controller: AsyncController): Promise<void> {
        const featureIndex = this.features.findIndex((x) => x.id === featureId);
        const feature = this.features[featureIndex];
        if (feature?.type === "extrude") return this.reselectProfiles(feature, controller);
        if (feature?.type !== "fillet" && feature?.type !== "chamfer") return;

        const edges = await new EdgeReselectSession(this).pick(feature, featureIndex, controller);
        if (edges === undefined) return;

        Transaction.execute(this.document, "reselect edges", () => {
            const features = this.features.map((x) => (x.id === featureId ? { ...x, edges } : x));
            this.setFeaturesEmitShapeChanged(features);
            this.document.selection.clearSelection();
            this.document.visual.update();
        });
    }

    /**
     * Re-picks the profiles of an extrude feature. Body-face extrudes (`source`) re-match
     * by fingerprint, so only sketch profiles can be re-picked. Confirming with nothing
     * selected clears `profiles` — back to extruding every profile of the sketch.
     */
    private async reselectProfiles(feature: ExtrudeFeatureData, controller: AsyncController): Promise<void> {
        if (feature.sketchId === undefined) return;
        const sketch = findSketch(this.document, feature.sketchId);
        if (sketch === undefined) return;

        const profiles = await new ProfileReselectSession(this).pick(feature, sketch, controller);
        if (profiles === undefined) return;

        Transaction.execute(this.document, "reselect profiles", () => {
            const features = this.features.map((x) =>
                x.id === feature.id && x.type === "extrude"
                    ? { ...x, profiles: profiles.length > 0 ? profiles : undefined }
                    : x,
            );
            this.setFeaturesEmitShapeChanged(features);
            this.document.visual.update();
        });
    }

    // ------------------------------------------------------------------ Shape: derived state

    /**
     * The shape is derived state: `featuresJson` (the recorded property) regenerates it
     * on undo/redo. Recording the shape too would let redo re-apply a stale snapshot
     * whose wasm shape cache eviction has already disposed (kernel error "null is not
     * a valid TopoDS_Shape"). The history guard assumes `super.setShape` runs fully
     * synchronously — keep it that way.
     */
    protected override setShape(shape: Result<IShape>) {
        if (this._job && shape === this._shape) return;
        const previous = this.currentShape();
        if (shape.isOk && previous === shape.value) return;
        const history = this.document.history;
        const disabled = history.disabled;
        history.disabled = true;
        try {
            super.setShape(shape);
        } finally {
            history.disabled = disabled;
        }
        if (previous !== undefined && previous !== this.currentShape() && !this._timeline.owns(previous)) {
            previous.dispose();
        }
        if (shape.isOk && shape.value !== this.currentShape() && !this._timeline.owns(shape.value)) {
            shape.value.dispose();
        }
    }

    /**
     * A persisted failure is not re-evaluated on every read: feature edits and
     * watched-node changes already re-evaluate eagerly, so the getter retries only
     * when never evaluated yet, or when a reference that was missing at evaluation
     * time appears later (document load order) — detected by a growing watch set.
     */
    override get shape(): Result<IShape> {
        // A mid-chain read (e.g. a consumed sketch's external-ref resolution reading
        // this node as its source) gets the previous result as-is: recomputing here
        // would re-enter generateShape.
        if (this._evaluating) return this._shape;
        if (ParametricBodyNode.evaluationDepth > 0) this._job?.flush();
        if (this._job) return this._shape;
        if (!this._shape.isOk && (!this._evaluated || this.hasNewReferences())) {
            this._shape = this.generateShape("read");
        }
        return this._shape;
    }
    override set shape(value: Result<IShape>) {
        this.setShape(value);
    }

    private hasNewReferences(): boolean {
        const before = this._watched.size;
        this.syncWatchedNodes();
        return this._watched.size > before;
    }

    protected generateShape(trigger = "edit"): Result<IShape> {
        if (this._isDisposed) return Result.err("Body disposed");
        this.cancelRebuild();
        this._lastRebuildSucceeded = false;
        this._evaluated = true;
        this.syncWatchedNodes();
        this._featureErrors.clear();
        this._featureWarnings.clear();
        const asynchronous =
            !this._forceSynchronous &&
            !ParametricBodyNode.synchronousDocuments.has(this.document) &&
            ParametricBodyNode.evaluationDepth === 0 &&
            (this.features.length >= ParametricBodyNode.ASYNC_FEATURE_THRESHOLD ||
                this.features.some(
                    (feature) =>
                        feature.type === "fillet" &&
                        !feature.suppressed &&
                        feature.cornerSetbacks !== undefined,
                ));
        const revision = DocumentRebuilds.revision(this.document);
        const featuresJson = this.featuresJson;
        const scopeJson = JSON.stringify([...this.document.variables.evaluate().scope]);
        const run: RebuildRun = {
            trigger,
            synchronous: !asynchronous,
            outcome: "cancelled",
            current: () =>
                !this._isDisposed &&
                DocumentRebuilds.revision(this.document) === revision &&
                this.featuresJson === featuresJson &&
                JSON.stringify([...this.document.variables.evaluate().scope]) === scopeJson,
        };
        this._run = run;
        const steps = this.evaluateChain(asynchronous, run);
        const mutationScope = DocumentMutations.captureScope(this.document);
        const owned = <T>(action: () => T): T => (mutationScope ? mutationScope.run(action) : action());
        const advance = () => {
            const batchTrace = PerformanceTrace.enabled
                ? PerformanceTrace.begin("body.batch", { nodeId: this.id })
                : undefined;
            this._evaluating = true;
            ParametricBodyNode.evaluationDepth++;
            try {
                return owned(() => steps.next());
            } finally {
                this._timeline.endRun();
                ParametricBodyNode.evaluationDepth--;
                this._evaluating = false;
                if (batchTrace) PerformanceTrace.end(batchTrace);
            }
        };
        try {
            const first = advance();
            if (first.done) {
                if (run.outcome === "cancelled") return this.generateShape("superseded");
                this._lastRebuildSucceeded = first.value.isOk;
                return first.value;
            }
            const job = new RebuildJob(
                this.document,
                steps,
                advance,
                (result) =>
                    owned(() => {
                        if (this._job !== job || this._isDisposed) return;
                        this._job = undefined;
                        if (run.outcome === "cancelled") {
                            const result = this.generateShape("superseded");
                            if (result.isOk) this.shape = result;
                            return;
                        }
                        this._lastRebuildSucceeded = result.isOk;
                        this.reportRebuildProgress(undefined);
                        if (result.isOk) this.shape = result;
                        else if (!this._shape.isOk) this._shape = result;
                        this.emitPropertyChanged("featuresJson", this.featuresJson);
                        this.document.visual.update();
                    }),
                (index) => this.reportRebuildProgress(index),
                (error) =>
                    owned(() => {
                        if (this._job !== job) return;
                        this._job = undefined;
                        this._lastRebuildSucceeded = false;
                        this.reportRebuildProgress(undefined);
                        this._featureErrors.set(this.features[0]?.id ?? "", String(error));
                        this.emitPropertyChanged("featuresJson", this.featuresJson);
                    }),
                run.current,
                () =>
                    owned(() => {
                        if (this._job !== job || this._isDisposed) return;
                        this._job = undefined;
                        const result = this.generateShape("superseded");
                        if (result.isOk) this.shape = result;
                    }),
                () => {
                    run.synchronous = true;
                },
            );
            this._job = job;
            job.start(first.value);
            return this._shape;
        } catch (error) {
            this._lastRebuildSucceeded = false;
            steps.return(undefined as never);
            throw error;
        }
    }

    private reportRebuildProgress(index: number | undefined): void {
        PubSub.default.pub(
            "rebuildProgress",
            this.document,
            this.id,
            index === undefined
                ? undefined
                : { completed: index, total: this._rollbackIndex ?? this.featureCount },
        );
    }

    /** Recovery cancels ephemeral old-generation work without changing saved features. */
    cancelForKernelRecovery(): void {
        this.cancelRebuild("kernel-recovery");
    }

    private cancelRebuild(reason = "superseded"): void {
        const job = this._job;
        this._job = undefined;
        if (job && this._run) {
            this._run.cancelReason = reason;
            this._lastRebuildSucceeded = false;
        }
        job?.cancel();
        if (job) this.reportRebuildProgress(undefined);
    }

    private readonly beforeHistoryReplay = () => {
        this._replayCancelled = this._job !== undefined;
        this.cancelRebuild("history");
    };

    private readonly afterHistoryReplay = () => {
        if (this._replayCancelled && !this._job && !this._isDisposed) {
            const result = this.generateShape("history");
            if (result.isOk) this.shape = result;
        }
        this._replayCancelled = false;
    };

    private readonly historyChanged = () => {
        if (!this._job || this._evaluating || this.document.history.disabled) return;
        // A document edit supersedes a suspended replay, even when it changed an unwatched datum.
        const result = this.generateShape("document-edit");
        if (result.isOk) this.shape = result;
    };

    // `IBodyTrackingNode` — pure forwarding; `BodyTimeline` owns the id arrays and
    // documents the contracts (what makes an id shared, what "overlaps" means).

    // ------------------------------------------------------------------ Tracking facade (IBodyTrackingNode / IBodyTimelineNode)

    faceIdAt(index: number): string | undefined {
        return this._timeline.idAt(index, "face");
    }

    faceIndexById(id: string): number | undefined {
        return this._timeline.indexOfId("face", id);
    }

    faceIndexesOfId(id: string): number[] {
        return this._timeline.indexesOfId("face", id);
    }

    edgeIdAt(index: number): string | undefined {
        return this._timeline.idAt(index, "edge");
    }

    edgeIndexById(id: string): number | undefined {
        return this._timeline.indexOfId("edge", id);
    }

    edgeIndexesOfId(id: string): number[] {
        return this._timeline.indexesOfId("edge", id);
    }

    faceIdIsShared(id: string | undefined): boolean {
        return this._timeline.idIsShared("face", id);
    }

    edgeIdIsShared(id: string | undefined): boolean {
        return this._timeline.idIsShared("edge", id);
    }

    /**
     * `IFeatureListNode.featureFaces`: the faces the feature created, by comparing the tracked
     * ids entering and leaving it (`BodyTimeline.facesCreatedAt`). A rollback preview shows a
     * truncated chain, so nothing is traced meanwhile.
     */
    featureFaces(featureId: string): number[] {
        if (this.rollbackIndex !== undefined) return [];
        const index = this.features.findIndex((x) => x.id === featureId);
        if (index < 0 || this.features[index].suppressed) return [];
        return this._timeline.facesCreatedAt(index);
    }

    get featureCount(): number {
        return this.features.length;
    }

    /**
     * `IBodyTimelineNode`: the chain state entering the feature at `index` — the geometry
     * a sketch's external references resolve against when their timeline anchor
     * (`SketchData.refPositions`) points here, so a downstream feature (e.g. a cut into
     * the referenced edge) does not make them dangle. See `BodyTimeline.stateAt`.
     */
    timelineStateAt(index: number): FeatureTimelineState | undefined {
        return this._timeline.stateAt(index);
    }

    /** Includes the final output when a new corner is appended, without changing timeline lookup semantics. */
    cornerEditStateAt(index: number): FeatureTimelineState | undefined {
        if (index < this.features.length) return this.timelineStateAt(index);
        if (index !== this.features.length) return undefined;
        const count = this.features.filter((feature) => !feature.suppressed).length;
        const entry = this._timeline.entryAt(count - 1);
        return entry && { shape: entry.shape, faceIds: entry.faceIds, edgeIds: entry.edgeIds };
    }

    /**
     * The first boolean using this tool, or face sweep using this path. Referenced curves
     * may themselves depend on this body, so they must see the state entering their consumer.
     * This timeline anchor does not change tree adoption; consumeTools only controls that.
     */
    consumingFeatureIndex(nodeId: string): number | undefined {
        const index = this.features.findIndex(
            (feature) =>
                (feature.type === "boolean" && feature.toolIds.includes(nodeId)) ||
                (feature.type === "faceSweep" && feature.path.nodeId === nodeId) ||
                (feature.type === "loft" &&
                    (feature.guided?.spine?.nodeId === nodeId ||
                        feature.guided?.boundary?.nodeId === nodeId)),
        );
        return index < 0 ? undefined : index;
    }

    // ------------------------------------------------------------------ Chain evaluation

    /**
     * Replays the feature list, reusing cached per-feature results while the feature
     * data, the variables it reads, its input shape, and its referenced node
     * shapes are all unchanged — so editing one feature only re-evaluates from that
     * feature on.
     * A session rollback (`_rollbackIndex`) stops the replay early; the truncation
     * is by feature-list index, so user-suppressed features still count.
     */
    private *evaluateChain(asynchronous: boolean, run: RebuildRun): RebuildSteps {
        const trace = PerformanceTrace.enabled
            ? PerformanceTrace.begin("body.rebuild", {
                  nodeId: this.id,
                  asynchronous,
                  rollbackIndex: this._rollbackIndex,
                  trigger: run.trigger,
              })
            : undefined;
        let input: IShape | undefined;
        let faceIds: string[] | undefined;
        let edgeIds: string[] | undefined;
        // Resolved values carry transitive expression changes. Each feature records
        // which names it reads, so unrelated table edits keep its geometry cached.
        const scope = this.document.variables.evaluate().scope;
        const nextCache: FeatureCacheEntry[] = [];
        const resolvedProfiles = new Map<string, ProfileRef[]>();
        const resolvedEdges = new Map<string, EdgeRef[]>();
        const resolvedFaces = new Map<string, Record<string, ProfileRef>>();
        const features = this.features;
        const stop = this._rollbackIndex ?? features.length;
        // Sketches already re-resolved this run (see followReferencedSketches): a
        // sketch referenced by N features was followed — re-parsed, re-scanned —
        // N times per run, while one resolution already writes fresh snapshots
        // back for every later feature.
        const followedSketches = new Set<string>();
        // Chain state entering each feature-list index — the timeline sketch external
        // refs anchor to (see `timelineStateAt`). Handed to the timeline as the in-flight
        // run for its duration, so mid-chain ref resolutions see THIS run's states.
        const timeline: FeatureTimelineState[] = [];
        let committed = false;
        let invalidSuffix = false;
        try {
            for (let index = 0; index < features.length && index < stop; index++) {
                this._timeline.beginRun(timeline);
                timeline.push({ shape: input, faceIds, edgeIds });
                const feature = features[index];
                if (feature.suppressed) continue;
                withConstructionFeaturePosition(this.document, this.id, index, () => {
                    this.followReferencedSketches(feature, followedSketches);
                    this.refreshConsumedTools(feature);
                });
                const key = this.cacheKey(
                    feature,
                    scope,
                    this._timeline.entryAt(nextCache.length)?.variableDependencies,
                );
                const cached = invalidSuffix ? undefined : this.validCacheEntry(key, input, nextCache.length);
                let step: Result<FeatureStepOutput>;
                if (cached) {
                    const featureTrace = PerformanceTrace.enabled
                        ? PerformanceTrace.begin("body.feature", {
                              nodeId: this.id,
                              index,
                              type: feature.type,
                              cacheHit: true,
                          })
                        : undefined;
                    nextCache.push(cached);
                    step = Result.ok(cached);
                    if (featureTrace) PerformanceTrace.end(featureTrace);
                } else {
                    invalidSuffix = true;
                    if (asynchronous) yield index;
                    this._timeline.beginRun(timeline);
                    const featureTrace = PerformanceTrace.enabled
                        ? PerformanceTrace.begin("body.feature", {
                              nodeId: this.id,
                              index,
                              type: feature.type,
                              cacheHit: false,
                          })
                        : undefined;
                    try {
                        const evaluation = withConstructionFeaturePosition(
                            this.document,
                            this.id,
                            index,
                            () => {
                                // The cache probe preceded a yield. Refresh dependencies and capture
                                // variable reads inside this batch's in-flight timeline.
                                if (asynchronous) {
                                    this.followReferencedSketches(feature, followedSketches);
                                    this.refreshConsumedTools(feature);
                                }
                                return this.prepareEvaluation(
                                    feature,
                                    scope,
                                    input,
                                    faceIds,
                                    edgeIds,
                                    nextCache,
                                    asynchronous &&
                                        (!run.synchronous ||
                                            (feature.type === "fillet" &&
                                                feature.cornerSetbacks !== undefined)),
                                    features.slice(index + 1, stop).every((feature) => feature.suppressed),
                                );
                            },
                        );
                        try {
                            if (evaluation.pending) yield evaluation.pending;
                            this._timeline.beginRun(timeline);
                            step = withConstructionFeaturePosition(this.document, this.id, index, () =>
                                evaluation.finish(run.synchronous),
                            );
                        } finally {
                            evaluation.pending?.cancel();
                        }
                    } finally {
                        if (featureTrace) PerformanceTrace.end(featureTrace);
                    }
                }
                if (!step.isOk) {
                    run.outcome = "failed";
                    run.failure = "feature";
                    run.failedFeatureId = feature.id;
                    return this.abandonChain(feature, step.error, features);
                }
                input = step.value.shape;
                faceIds = step.value.faceIds;
                edgeIds = step.value.edgeIds;
                if (step.value.resolvedProfiles !== undefined) {
                    resolvedProfiles.set(feature.id, step.value.resolvedProfiles);
                }
                if (step.value.resolvedEdges !== undefined) {
                    resolvedEdges.set(feature.id, step.value.resolvedEdges);
                }
                if (step.value.resolvedFaces !== undefined) {
                    resolvedFaces.set(feature.id, step.value.resolvedFaces);
                }
            }
            if (!run.current()) {
                run.cancelReason = "document-edit";
                return Result.err("Rebuild superseded");
            }
            // An empty list/rollback is an owned empty compound, not a retained chain entry.
            const result = input === undefined ? shapeFactory.combine([]) : Result.ok(input);
            if (!result.isOk) {
                run.outcome = "failed";
                run.failure = "empty-shape";
                return result;
            }
            this._timeline.commit(
                nextCache,
                timeline,
                this.currentShape(),
                this._rollbackIndex !== undefined,
            );
            this._displayRollbackIndex = this._rollbackIndex;
            committed = true;
            this.refreshAnchoredRefs(resolvedProfiles, resolvedEdges, resolvedFaces);
            // Match the anchors just written back, otherwise an unchanged restore misses.
            let cacheIndex = 0;
            for (const feature of this.features.slice(0, stop)) {
                if (feature.suppressed) continue;
                const entry = nextCache[cacheIndex];
                nextCache[cacheIndex++] = {
                    ...entry,
                    json: this.cacheKey(feature, scope, entry.variableDependencies),
                };
            }
            this.markUnresolvedExternalRefs(features);
            run.outcome = "success";
            return result;
        } catch (error) {
            run.outcome = "failed";
            run.failure = "exception";
            throw error;
        } finally {
            this._timeline.endRun();
            if (!committed) this._timeline.discard(nextCache, this.currentShape());
            if (trace)
                PerformanceTrace.end(trace, {
                    committed,
                    outcome: run.outcome,
                    cancelReason:
                        run.outcome === "cancelled" ? (run.cancelReason ?? "document-edit") : undefined,
                    failure: run.failure,
                    failedFeatureId: run.failedFeatureId,
                });
        }
    }

    /**
     * Ends the run at the feature that failed. The previous cache and shape stay: id queries
     * must keep describing the displayed shape, not a truncated prefix of a rebuild that never
     * made it to the screen. The sketch warnings are repopulated here too — they describe
     * sketch state, not the chain run, and one failing feature would otherwise wipe them off
     * the other rows.
     */
    private abandonChain(feature: FeatureData, error: string, features: FeatureData[]): Result<IShape> {
        this._featureErrors.set(feature.id, String(error));
        this.markUnresolvedExternalRefs(features);
        return Result.err(error);
    }

    /**
     * Re-solve the tools this boolean is about to read, when they are themselves derived
     * from this body — the press-pull-onto-yourself pattern (body B is swept off a face of
     * body A, then fused back into A). Those tools are circular by construction: the boolean
     * needs the tool's shape, while the tool's refs resolve against this body's chain state
     * up to that very boolean (`sourceFaceMatcher.ts`). Solving the tool HERE — after the
     * state entering this feature was pushed, so `timelineStateAt` already describes it —
     * hands the boolean the current tool instead of the previous revision's, and this body's
     * `_evaluating` flag keeps the tool's shape change from bouncing back into this run.
     *
     * Without it the two bodies trade revisions: each rebuild reads the other's stale shape
     * and hands back a new one, hundreds of rounds of kernel work per edit.
     */
    private refreshConsumedTools(feature: FeatureData): void {
        const tools =
            feature.type === "boolean"
                ? feature.toolIds
                : feature.type === "faceSweep"
                  ? [feature.path.nodeId]
                  : feature.type === "loft" && feature.guided
                    ? [feature.guided.spine?.nodeId, feature.guided.boundary?.nodeId].filter(
                          (id): id is string => typeof id === "string",
                      )
                    : [];
        for (const toolId of tools) {
            const node = this.document.modelManager.findNode((n) => n.id === toolId);
            if (node === this || !(node instanceof ParametricBodyNode)) continue;
            if (!node.references(this.id)) continue;
            node.refreshForConsumer();
        }
    }

    /** True when any feature of this body names `nodeId` — a sketch or a press-pull source. */
    private references(nodeId: string): boolean {
        return this.features.some((feature) =>
            (featureHandler(feature.type)?.nodeIds(feature, this.document) ?? []).includes(nodeId),
        );
    }

    /** `INodeReferences`: every node the feature list reads (sketches, tools, press-pull sources). */
    referencedNodeIds(): string[] {
        return [...this.referencedIds()];
    }

    /** Every node id the feature list reads, watched or not — a missing one is never watched. */
    private referencedIds(): Set<string> {
        return new Set(
            this.features.flatMap(
                (feature) => featureHandler(feature.type)?.nodeIds(feature, this.document) ?? [],
            ),
        );
    }

    /**
     * A node this body's features read entering or leaving the document: a sketch or a
     * boolean tool deleted, or either coming back through undo.
     *
     * The watch set cannot see this. It reacts to a node's property changes, and a removed
     * node emits none — so without this the features would report nothing and keep the
     * stale shape (a deleted tool's geometry still fused into the result), and the user
     * would have no way to tell the reference had gone.
     */
    private readonly handleReferencedNodeChanged = (records: NodeRecord[]) => {
        if (this._evaluating) return;
        const wanted = this.referencedIds();
        if (!records.some((record) => wanted.has(record.node.id))) return;

        const result = this.generateShape("references");
        if (result.isOk) this.shape = result;
        this.emitPropertyChanged("featuresJson", this.featuresJson);
    };

    /** A consumer refreshes its producers at their anchors, including variable-table updates. */
    private isConsumedByWatched(source?: INode): boolean {
        for (const node of this._watched.values()) {
            if (
                (source === undefined || node === source) &&
                node instanceof ParametricBodyNode &&
                node.consumingFeatureIndex(this.id) !== undefined
            ) {
                return true;
            }
        }
        return false;
    }

    /**
     * Re-runs the chain for the body that consumes this one and installs the result; a
     * failed rebuild keeps the last shape silently, exactly as a watch-triggered rebuild
     * does. Re-entrant calls are dropped — two bodies that consume each other would
     * otherwise recurse.
     */
    private refreshForConsumer(): void {
        if (this._evaluating) return;
        // generateShape cancels any suspended tool replay: its prefix may have resolved
        // against the consumer's previous timeline. This nested run completes synchronously.
        const result = this.generateShape("consumer");
        if (result.isOk) this.shape = result;
    }

    // ------------------------------------------------------------------ Following referenced sketches

    /**
     * Re-resolves the external references of the sketches this feature reads, so the chain's
     * FIRST pass already works on post-edit geometry.
     *
     * Why it cannot wait: the catch-up would otherwise run only after a successful chain (the
     * sketch's source watch fires on the emitted shape change). A first pass reading the stale
     * sketch can fail outright — a cut whose sketch geometry no longer intersects the rebuilt
     * body becomes a no-op, a downstream fillet then reports "Edge not found after rebuild" for
     * its vanished edges, the failed chain keeps the old shape, and so the watch never fires and
     * the sketch never catches up. Resolving against the in-flight timeline
     * (`BodyTimeline.beginRun`) is what makes the fresh state available this early.
     *
     * A sketch owned by a live editor session is left alone — the session's solver reconciles
     * its refs itself.
     *
     * `followedSketches` memoizes the run (one Set per `evaluateChain`): a sketch referenced by
     * several features is re-resolved once, not once per feature, since the first follow already
     * persists fresh snapshots for every later feature. One narrow exception: a sketch
     * referencing THIS body whose timeline anchor (`SketchData.refPositions`) the in-flight
     * replay has not reached yet resolves against the final-shape fallback (`timelineStateAt` is
     * not ready at that point), so that first result must NOT be pinned for the rest of the run
     * — a later feature at or past the anchor can still follow with the anchored state, and
     * memoizing would freeze the fallback resolution for the whole run.
     */
    private followReferencedSketches(feature: FeatureData, followedSketches: Set<string>): void {
        for (const id of featureHandler(feature.type)?.nodeIds(feature, this.document) ?? []) {
            if (id === this.id || followedSketches.has(id)) continue;
            const node = this.document.modelManager.findNode((n) => n.id === id);
            if (!(node instanceof SketchNode) || node.editingSession) {
                // Nothing to follow now or later this run (a session cannot start
                // mid-run) — memoize to skip the repeat lookup as well.
                followedSketches.add(id);
                continue;
            }
            node.followExternalRefs();
            if (!this.anchorStatePending(node)) followedSketches.add(id);
        }
    }

    /**
     * True when `sketch` anchors an external reference to this body
     * (`SketchData.refPositions`) at a timeline position the in-flight replay has
     * not produced yet, so the follow that just ran used the final-shape fallback
     * and must not be memoized (see `followReferencedSketches`). The gate mirrors
     * `sourceEdges`: an anchor at or past the feature count never consults the
     * timeline, so no fallback is involved and the memo applies.
     */
    private anchorStatePending(sketch: SketchNode): boolean {
        const anchor = sketch.data.refPositions?.[this.id];
        return (
            anchor !== undefined && anchor < this.featureCount && this.timelineStateAt(anchor) === undefined
        );
    }

    /**
     * Surfaces dangling profile-role external refs of consumed sketches as a feature-level
     * warning.
     *
     * - **Why a dangling flag means a genuine loss.** Refs sourced from a parametric body resolve
     *   against the shape at the sketch's timeline anchor (`SketchData.refPositions`, see
     *   `timelineStateAt`), and the sketch then builds profiles from the frozen snapshot — so a
     *   dangling flag means the edge is gone at the anchor too (the upstream geometry was edited
     *   away), and the geometry is silently wrong. Worth flagging.
     * - **And why the converse stays silent.** An edge consumed by a downstream feature of the
     *   source body itself (a cut into it) still exists at the anchor, resolves there, and never
     *   dangles — Onshape-style silence for the feature system working as intended.
     * - **Scope.** Runs only after a fully successful chain, with sketch lookups memoized per
     *   rebuild, and is truncated at the session rollback index so hidden features don't report
     *   warnings for geometry the user cannot see.
     * - **Revolve's `axisSource.nodeId` is deliberately not checked.** The axis edge re-matches
     *   through its own `EdgeRef` on the source's shape, and if the axis sketch itself is degraded
     *   that match can silently fall back to the world-space snapshot axis — an accepted, narrower
     *   degradation than rebuilding whole profiles from frozen geometry. Flagging it would warn on
     *   dangling refs unrelated to the axis line.
     */
    private markUnresolvedExternalRefs(features: FeatureData[]): void {
        const checked = new Map<string, boolean>();
        const stop = this._rollbackIndex ?? features.length;
        for (let index = 0; index < features.length && index < stop; index++) {
            const feature = features[index];
            if (feature.suppressed) continue;
            const dangling = featureSketchIds(feature).some((sketchId) => {
                let found = checked.get(sketchId);
                if (found === undefined) {
                    const sketch = findSketch(this.document, sketchId);
                    found = sketch !== undefined && danglingProfileRefs(sketch).length > 0;
                    checked.set(sketchId, found);
                }
                return found;
            });
            if (dangling) this._featureWarnings.set(feature.id, "Sketch has unresolved external references");
        }
    }

    // ------------------------------------------------------------------ Cache plumbing

    /** Cache-miss path of `evaluateFeatureStep`: evaluates the feature and stores the result. */
    private prepareEvaluation(
        feature: FeatureData,
        scope: Scope,
        input: IShape | undefined,
        faceIds: string[] | undefined,
        edgeIds: string[] | undefined,
        nextCache: FeatureCacheEntry[],
        asynchronous: boolean,
        meshResult: boolean,
    ): { pending?: IAsyncShapeOperation<IShape>; finish(synchronous: boolean): Result<FeatureStepOutput> } {
        const tracking: ShapeTracking = {
            inputFaceIds: faceIds ?? [],
            outputFaceIds: [],
            inputEdgeIds: edgeIds ?? [],
            outputEdgeIds: [],
        };
        const variables = trackVariableScope(scope);
        const context = {
            document: this.document,
            host: this,
            input,
            scope: variables.scope,
            tracking,
            meshResult,
        };
        const refs = this.snapshotNodeRefs(feature);
        // An async evaluation's cost is its wall time up to the answer: the worker's kernel
        // time is what a later rebuild of this step pays too.
        const started = performance.now();
        const prepared =
            feature.type === "fillet" && feature.cornerSetbacks !== undefined
                ? this._preparedCorner
                : undefined;
        const preparedOperation: IAsyncShapeOperation<IShape> | undefined = prepared
            ? {
                  ready: Promise.resolve(),
                  cancel: () => {},
                  canFallback: false,
                  take: () => {
                      this._preparedCorner = undefined;
                      if (prepared.json !== JSON.stringify(feature) || prepared.input !== input)
                          return Result.err("Corner preview is stale; recompute before confirming");
                      Object.assign(tracking, prepared.tracking);
                      return prepared.take();
                  },
              }
            : undefined;
        const pending =
            preparedOperation ??
            (asynchronous ? featureHandler(feature.type)?.prepareAsync?.(feature, context) : undefined);
        return {
            pending,
            finish: (synchronous) => {
                if (pending?.canFallback === false) synchronous = false;
                if (synchronous) pending?.cancel();
                const parked = pending !== undefined && !synchronous;
                const evaluationStart = parked ? started : performance.now();
                const result = parked ? pending.take() : evaluateFeature(feature, context);
                const evaluationMs = performance.now() - evaluationStart;
                if (!result.isOk) return Result.err(result.error);
                // A handler that cannot track (e.g. the kernel lacks history) leaves the
                // output empty — ids stay undefined from here on rather than guessing.
                const output: FeatureStepOutput = {
                    shape: result.value,
                    faceIds: tracking.outputFaceIds.length > 0 ? tracking.outputFaceIds : undefined,
                    edgeIds: tracking.outputEdgeIds.length > 0 ? tracking.outputEdgeIds : undefined,
                    resolvedProfiles: tracking.resolvedProfiles,
                    resolvedEdges: tracking.resolvedEdges,
                    resolvedFaces: tracking.resolvedFaces,
                };
                const variableDependencies = variables.dependencies();
                nextCache.push({
                    json: this.cacheKey(feature, scope, variableDependencies),
                    variableDependencies,
                    input,
                    refs: parked ? refs : this.snapshotNodeRefs(feature),
                    shape: output.shape,
                    faceIds: output.faceIds,
                    edgeIds: output.edgeIds,
                    evaluationMs,
                });
                return Result.ok(output);
            },
        };
    }

    /** Cache only names read by evaluation; missing names and their units are significant too. */
    private cacheKey(feature: FeatureData, scope: Scope, dependencies?: readonly string[]): string {
        const extra = featureHandler(feature.type)?.cacheKey?.(feature, this.document);
        const own = extra === undefined ? feature : [feature, extra];
        const variables =
            dependencies === undefined ? [...scope] : dependencies.map((name) => [name, scope.get(name)]);
        return JSON.stringify([own, variables]);
    }

    /** The cached entry for `index`, when the feature data, the input and the refs all still match. */
    private validCacheEntry(
        key: string,
        input: IShape | undefined,
        index: number,
    ): FeatureCacheEntry | undefined {
        const entry = this._timeline.entryAt(index);
        if (entry === undefined || entry.input !== input || entry.json !== key) {
            return undefined;
        }
        for (const [id, snapshot] of entry.refs) {
            const current = this.snapshotNode(id);
            if (
                current.shape !== snapshot.shape &&
                !(current.shape?.isOk && snapshot.shape?.isOk && current.shape.value === snapshot.shape.value)
            ) {
                return undefined;
            }
            if (current.timelineShape !== snapshot.timelineShape) return undefined;
            if (current.datumJson !== snapshot.datumJson) return undefined;
            if (!sameTransform(current.transform, snapshot.transform)) return undefined;
        }
        return entry;
    }

    private snapshotNodeRefs(feature: FeatureData): Map<string, RefSnapshot> {
        const refs = new Map<string, RefSnapshot>();
        const handler = featureHandler(feature.type);
        const ids =
            handler?.cacheRefIds?.(feature, this.document) ?? handler?.nodeIds(feature, this.document) ?? [];
        for (const id of ids) {
            // A feature may reference the host itself (e.g. an extrude sourced on one
            // of its own faces) — the input-identity check already covers that.
            if (id === this.id) continue;
            refs.set(id, this.snapshotNode(id));
        }
        return refs;
    }

    private snapshotNode(id: string): RefSnapshot {
        const node = this.document.modelManager.findNode((n) => n.id === id);
        if (node instanceof ParametricBodyNode) {
            const index = node.consumingFeatureIndex(this.id);
            const state = index === undefined ? undefined : node.timelineStateAt(index);
            if (state?.shape !== undefined) {
                return { shape: undefined, timelineShape: state.shape, transform: node.worldTransform() };
            }
        }
        if (node instanceof ConstructionNode) {
            const result = node.geometry;
            return {
                shape: undefined,
                transform: node.worldTransform(),
                datumJson: result.isOk ? JSON.stringify(result.value) : `error:${result.error}`,
            };
        }
        if (!(node instanceof ShapeNode)) return { shape: undefined, transform: undefined };
        return { shape: node.shape, transform: node.worldTransform() };
    }

    /**
     * The displayed shape. Timeline eviction keeps it alive until setShape replaces it;
     * ShapeNode.disposeInternal releases the final displayed result on node disposal.
     */
    private currentShape(): IShape | undefined {
        return this._shape.isOk ? this._shape.value : undefined;
    }

    // ------------------------------------------------------------------ Ref write-back and node watching

    /**
     * Re-anchors stored shape references to what the last evaluation actually
     * matched: each feature handler writes its matched profile fingerprints and
     * edge anchors back into the feature JSON (`FeatureHandler.applyResolvedRefs`).
     * Refs captured at pick time would otherwise measure drift from the original
     * position on every edit — and an edge ref whose id died keeps paying
     * fingerprint matching with a stale anchor on every rebuild. Runs only after a
     * fully successful chain; the rewrite is derived state (like the shape), so it
     * is neither transacted nor shape-changing.
     */
    private refreshAnchoredRefs(
        profiles: ReadonlyMap<string, ProfileRef[]>,
        edges: ReadonlyMap<string, EdgeRef[]>,
        faces: ReadonlyMap<string, Record<string, ProfileRef>>,
    ): void {
        if (profiles.size === 0 && edges.size === 0 && faces.size === 0) return;
        let changed = false;
        const features = this.features.map((feature) => {
            const next = featureHandler(feature.type)?.applyResolvedRefs?.(feature, {
                resolvedProfiles: profiles.get(feature.id),
                resolvedEdges: edges.get(feature.id),
                resolvedFaces: faces.get(feature.id),
            });
            // Untouched features skip the stringify pair — the common case.
            if (next === undefined || next === feature) return feature;
            if (JSON.stringify(next) === JSON.stringify(feature)) return feature;
            changed = true;
            return next;
        });
        if (!changed) return;
        const history = this.document.history;
        const disabled = history.disabled;
        history.disabled = true;
        try {
            // setProperty (not the shape-changing variant): the geometry is already
            // built — this only persists the re-anchored refs.
            this.setProperty("featuresJson", JSON.stringify(features));
        } finally {
            history.disabled = disabled;
        }
    }

    /** Watches the current feature references and drops stale ones (see `syncNodeWatches`). */
    private syncWatchedNodes(): void {
        const wanted = new Set(
            this.features
                .flatMap((f) => featureHandler(f.type)?.nodeIds(f, this.document) ?? [])
                // Never watch ourselves — a self-referencing feature (e.g. an extrude
                // sourced on the body's own face) would re-evaluate on every rebuild.
                .filter((id) => id !== this.id),
        );
        syncNodeWatches(this.document, this._watched, wanted, this.handleWatchedNodeChanged);
    }

    // The referenced node assigns its new shape before notifying (setProperty order),
    // so reacting to "shape" always reads fresh upstream geometry. "transform" matters
    // too: a boolean tool is mapped into this body's local space, so moving it must
    // re-evaluate. A failed rebuild (e.g. the sketch is mid-edit with an open profile)
    // keeps the last good shape silently — the feature panel shows the error — instead
    // of toasting per change.
    private readonly handleWatchedNodeChanged = (property: string, source: INode) => {
        if (property !== "shape" && property !== "transform" && property !== "geometry") return;
        this.rebuildFromUpstream("upstream", source);
    };

    /**
     * Re-derives the shape because something upstream changed — a watched node's
     * geometry, or the document's parameter table (`applyVariables`, dispatched by
     * `variableSync.ts`). A failed rebuild keeps the last good shape silently; the
     * feature panel carries the error.
     */
    private rebuildFromUpstream(trigger = "upstream", source?: INode): void {
        // Skip while evaluating: a referenced node (e.g. the sketch) may generate its
        // shape lazily mid-evaluation and notify — the in-flight pass reads it fresh.
        if (this._evaluating) return;
        // A rolled-back source (a sketch-session preview) must not re-evaluate
        // bystanders: the preview hides later features' geometry, the rebuilt shape
        // would be wrong, and the run would re-anchor refs onto the preview and
        // persist them. The session exit clears the flag BEFORE restoring the
        // shape, so the restore notification passes this guard and rebuilds.
        for (const node of this._watched.values()) {
            if (isBodyTimelineNode(node) && node.rollbackIndex !== undefined) {
                this.cancelRebuild("source-rollback");
                return;
            }
        }
        // A notification from our consumer, or a variable-table notification with no source,
        // is suppressed while a watched body CONSUMES this one: it re-solves us
        // right before its boolean, against the chain state we actually anchor to
        // (`refreshConsumedTools`). Reacting here as well would make the two trade revisions
        // forever — its shape is rebuilt from ours, so every round invalidates the other's
        // cached evaluation. The consumed body's placement of its own features still
        // rebuilds it directly, and so does the consumer once it stops consuming us.
        if (this.isConsumedByWatched(source)) return;

        const result = this.generateShape(trigger);
        if (result.isOk) {
            this.shape = result;
            this.document.visual.update();
        }
        this.emitPropertyChanged("featuresJson", this.featuresJson);
    }

    /** `IVariableConsumer`: bodies re-derive after the sketches that read the same table. */
    readonly variableSyncOrder = 1;

    /**
     * `IVariableConsumer`: the document's parameter table changed, so every feature
     * re-resolves against the new scope. The chain cache invalidates itself — the
     * scope is part of `cacheKey` — so this is a genuine rebuild, guarded the same
     * way a watched-node change is.
     */
    applyVariables(): void {
        this.rebuildFromUpstream("variables");
    }

    override disposeInternal(): void {
        this.cancelRebuild("disposed");
        this.document.history.onBeforeReplay.remove(this.beforeHistoryReplay);
        this.document.history.onAfterReplay.remove(this.afterHistoryReplay);
        this.document.history.onChanged.remove(this.historyChanged);
        // Drop session rollback state so a stale editor-side reference never triggers
        // a replay that would leak a shape onto this disposed node.
        this._rollbackIndex = undefined;
        this._displayRollbackIndex = undefined;
        this.document.modelManager.removeNodeObserver(this.handleReferencedNodeChanged);
        for (const node of this._watched.values()) {
            if (isPropertyChanged(node)) node.removePropertyChanged(this.handleWatchedNodeChanged);
        }
        this._watched.clear();
        this._children.dispose();
        this._timeline.dispose(this.currentShape());
        super.disposeInternal();
    }
}
