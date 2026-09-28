// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IShape, Matrix4, Result } from "@spicy3d/core";
import type { FeatureTimelineState } from "./bodyTracking";
import { ID_COMPONENT_SEPARATOR, idIsShared, indexesOfOverlappingId } from "./trackedId";

/**
 * Owns the last full chain and, during rollback, a separate displayed prefix. Each run
 * pairs cache entries with the timeline states that borrow their shapes. Preview queries
 * never expose the retained suffix; restoration can still validate and reuse it.
 * Eviction/disposal deduplicates shapes shared by the two runs.
 */

/** Snapshot of one referenced node, used to decide whether a cached entry is still valid. */
export interface RefSnapshot {
    readonly shape: Result<IShape> | undefined;
    /** A consumed body's source is the consumer's pre-boolean shape, not its displayed result. */
    readonly timelineShape?: IShape;
    readonly datumJson?: string;
    /** World transform at capture time — moving a reference must bust the cache too. */
    readonly transform: Matrix4 | undefined;
}

export function sameTransform(left: Matrix4 | undefined, right: Matrix4 | undefined): boolean {
    if (left === undefined || right === undefined) return left === right;
    return left.equals(right);
}

/** Output of one evaluated feature, reused while the feature and its inputs stay unchanged. */
export interface FeatureCacheEntry {
    /** Serialized feature at evaluation time. */
    readonly json: string;
    /** Input shape identity at evaluation time. */
    readonly input: IShape | undefined;
    /** Referenced node states (e.g. the sketch) at evaluation time, by node id. */
    readonly refs: ReadonlyMap<string, RefSnapshot>;
    readonly shape: IShape;
    /**
     * Stable face/edge ids of `shape` (findSubShapes order), from kernel shape history.
     * Undefined when any link in the chain could not track (e.g. unsupported kernel).
     */
    readonly faceIds?: string[];
    readonly edgeIds?: string[];
}

/** Which of the two tracked id arrays a query addresses. */
export type TrackedIdKind = "face" | "edge";

export class BodyTimeline {
    private _cache: FeatureCacheEntry[] = [];
    /** Chain state entering each feature-list index, swapped atomically with `_cache`. */
    private _committed: FeatureTimelineState[] = [];
    /** A rollback owns only its new prefix; the full chain remains available for restoration. */
    private _preview: FeatureCacheEntry[] | undefined;
    private _previewTimeline: FeatureTimelineState[] | undefined;
    /**
     * Timeline of the run in flight. Exposed only during synchronous feature evaluation so a
     * mid-chain reference resolution sees the states already rebuilt by THIS run — the
     * committed timeline still describes the previous one.
     */
    private _inflight: FeatureTimelineState[] | undefined;

    /**
     * Opens a run and returns the array the caller fills with one state per visited
     * index. Callers must pair this with `endRun` so `_inflight` never outlives the run.
     */
    beginRun(timeline: FeatureTimelineState[] = []): FeatureTimelineState[] {
        this._inflight = timeline;
        return timeline;
    }

    endRun(): void {
        this._inflight = undefined;
    }

    /**
     * The chain state entering `index` — the in-flight run shadows the committed one.
     * Undefined for an empty input (index 0), an out-of-range index, or a position a
     * truncated (rolled-back) replay never reached.
     */
    stateAt(index: number): FeatureTimelineState | undefined {
        const state = (this._inflight ?? this._previewTimeline ?? this._committed)[index];
        return state?.shape === undefined ? undefined : state;
    }

    entryAt(index: number): FeatureCacheEntry | undefined {
        return this._preview?.[index] ?? this._cache[index];
    }

    /**
     * Installs a completed full run or preview, disposing evicted shapes. The node releases
     * `currentShape` after replacing its display, unless this timeline still owns it.
     */
    commit(
        next: FeatureCacheEntry[],
        timeline: FeatureTimelineState[],
        currentShape?: IShape,
        preview = false,
    ): void {
        const previous = this.ownedShapes();
        if (preview) {
            this._preview = next;
            this._previewTimeline = timeline;
        } else {
            this._cache = next;
            this._committed = timeline;
            this._preview = undefined;
            this._previewTimeline = undefined;
        }
        const kept = this.ownedShapes();
        for (const shape of previous) {
            if (!kept.has(shape) && shape !== currentShape) shape.dispose();
        }
    }

    owns(shape: IShape): boolean {
        return this.ownedShapes().has(shape);
    }

    private ownedShapes(): Set<IShape> {
        return new Set([...this._cache, ...(this._preview ?? [])].map((entry) => entry.shape));
    }

    /**
     * Failure counterpart of `commit`: drops the aborted run's entries and disposes the
     * shapes it created, so the previous cache keeps describing the displayed shape.
     */
    discard(next: FeatureCacheEntry[], currentShape?: IShape): void {
        const kept = this.ownedShapes();
        for (const shape of new Set(next.map((entry) => entry.shape))) {
            if (!kept.has(shape) && shape !== currentShape) shape.dispose();
        }
    }

    /** Drops everything, disposing tracked shapes except `currentShape`. */
    dispose(currentShape?: IShape): void {
        for (const shape of this.ownedShapes()) {
            if (shape !== currentShape) shape.dispose();
        }
        this._cache = [];
        this._committed = [];
        this._preview = undefined;
        this._previewTimeline = undefined;
        this._inflight = undefined;
    }

    /** Stable id of the n-th sub-shape of the current shape (findSubShapes order). */
    idAt(index: number, kind: TrackedIdKind): string | undefined {
        return this.idsOf(kind)?.[index];
    }

    /** Sub-shape index of a tracked id, or undefined when unknown. */
    indexOfId(kind: TrackedIdKind, id: string): number | undefined {
        const index = this.idsOf(kind)?.indexOf(id) ?? -1;
        return index < 0 ? undefined : index;
    }

    /** Indexes whose tracked id overlaps `id` — the pieces of a boolean-split sub-shape. */
    indexesOfId(kind: TrackedIdKind, id: string): number[] {
        const ids = this.idsOf(kind);
        return ids === undefined ? [] : indexesOfOverlappingId(ids, id);
    }

    /** True when several sub-shapes carry the same tracked id — pieces of a boolean split. */
    idIsShared(kind: TrackedIdKind, id: string | undefined): boolean {
        const ids = this.idsOf(kind);
        return ids !== undefined && idIsShared(ids, id);
    }

    /**
     * Faces of the final shape the feature at `index` created: those carrying an id component
     * that first appears in the chain state leaving that index. A face merged by a later boolean
     * still counts (its compound id keeps the component); one a later feature consumed is gone.
     * Empty when the index was not visited or any state involved lacks tracked ids.
     */
    facesCreatedAt(index: number): number[] {
        const states = this._previewTimeline ?? this._committed;
        const final = this.idsOf("face");
        if (index < 0 || index >= states.length || final === undefined) return [];
        const entering = states[index];
        // Nothing enters the first feature: its (absent) shape has no ids to compare with.
        const before = entering.shape === undefined ? [] : entering.faceIds;
        const after = index + 1 < states.length ? states[index + 1].faceIds : final;
        if (before === undefined || after === undefined) return [];
        const existing = new Set(before.flatMap(idComponents));
        const created = new Set(after.flatMap(idComponents).filter((x) => !existing.has(x)));
        if (created.size === 0) return [];
        return final.flatMap((id, i) => (idComponents(id).some((x) => created.has(x)) ? [i] : []));
    }

    /**
     * The final shape's id arrays. The cache is swapped only by a fully successful run,
     * so these always describe the displayed shape — a failed re-evaluation changes
     * neither.
     */
    private idsOf(kind: TrackedIdKind): string[] | undefined {
        const entry = (this._preview ?? this._cache).at(-1);
        return kind === "face" ? entry?.faceIds : entry?.edgeIds;
    }
}

function idComponents(id: string): string[] {
    return id.split(ID_COMPONENT_SEPARATOR);
}
