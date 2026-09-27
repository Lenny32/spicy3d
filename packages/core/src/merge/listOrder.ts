// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { ResolutionChoice } from "./types";

// The order of an id-keyed list merged three-way (docs/merge.md, "Ordered, id-keyed lists"): diff3
// over the key sequences. Keys are unique within a sequence, so the longest common subsequence of
// base and a side is the longest increasing subsequence of the side's base indexes — patience
// sorting, O(n log n), fast on long lists (10k siblings of an imported assembly).

/** The start of a list, as an anchor. */
export const START = "\u0000start";

/**
 * The keys of `side` that keep their base order (its longest common subsequence with the base):
 * the longest increasing run of their base indexes. Among several, the one patience sorting
 * builds, which keeps the earliest base items (base `a b c`, side `a c b`: `a b` stay, `c` moved).
 */
export function stableKeys(baseIndex: ReadonlyMap<string, number>, side: readonly string[]): Set<string> {
    const keys: string[] = [];
    const indexes: number[] = [];
    for (const key of side) {
        const index = baseIndex.get(key);
        if (index !== undefined) {
            keys.push(key);
            indexes.push(index);
        }
    }
    // tails[k]: position (in `indexes`) of the smallest tail of an increasing run of length k + 1
    const tails: number[] = [];
    const previous = new Int32Array(indexes.length).fill(-1);
    for (let i = 0; i < indexes.length; i++) {
        let lo = 0;
        let hi = tails.length;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (indexes[tails[mid]] < indexes[i]) lo = mid + 1;
            else hi = mid;
        }
        if (lo > 0) previous[i] = tails[lo - 1];
        tails[lo] = i;
    }
    const stable = new Set<string>();
    for (let i = tails.at(-1) ?? -1; i >= 0; i = previous[i]) stable.add(keys[i]);
    return stable;
}

export interface OrderSides {
    readonly base: readonly string[];
    readonly ours: readonly string[];
    readonly theirs: readonly string[];
}

/** One item placed (inserted or moved) by one side after `anchor` (a key, or {@link START}). */
interface Placement {
    readonly key: string;
    readonly side: "ours" | "theirs";
    anchor: string;
}

export interface PositionConflict {
    readonly key: string;
    /** The item before it in base (`null` = the start), `undefined` when base does not have it. */
    readonly base: string | null | undefined;
    readonly ours: string | null;
    readonly theirs: string | null;
}

export interface InsertConflict {
    /** The anchor both sides placed items after ({@link START} = the start). */
    readonly anchor: string;
    readonly ours: readonly string[];
    readonly theirs: readonly string[];
}

export interface OrderOptions {
    /** `timeline`: order is semantic (conflicts); `stable`: incidental (ours first, never a conflict). */
    readonly timeline: boolean;
    /** The resolution picked for the position of `key` (`ours` / `theirs`), if any. */
    readonly positionChoice?: (key: string) => ResolutionChoice | undefined;
    /** The resolution picked for concurrent inserts after `anchor`, if any. */
    readonly insertChoice?: (anchor: string) => ResolutionChoice | undefined;
}

export interface OrderResult {
    /** The merged key sequence (only keys of `keep`, minus `dropped`). */
    readonly order: string[];
    readonly positionConflicts: PositionConflict[];
    readonly insertConflicts: InsertConflict[];
    /** Items a resolution removed: new items of the side whose concurrent inserts were dropped. */
    readonly dropped: ReadonlySet<string>;
}

function anchorValue(anchor: string): string | null {
    return anchor === START ? null : anchor;
}

/**
 * Merges the order of the items `keep` (the items the list keeps, decided beforehand): base's items
 * stable on *both* sides form the skeleton; every other item of a side is a placement right after
 * its anchor — the nearest item before it that the side kept stable (or the start). A placement
 * whose anchor does not survive falls back to the nearest surviving item before it in that side
 * (or the start). One item placed by both sides at the same anchor is one placement; at different
 * anchors it is a position conflict (timeline; merged: ours) or ours' placement (stable). Several
 * placements at one anchor: ours first (in ours' order), then theirs; in a timeline, two sides
 * placing different items at one anchor is an insert conflict.
 */
export function mergeOrder(sides: OrderSides, keep: ReadonlySet<string>, options: OrderOptions): OrderResult {
    const baseIndex = new Map(sides.base.map((key, index) => [key, index]));
    const stableOurs = stableKeys(baseIndex, sides.ours);
    const stableTheirs = stableKeys(baseIndex, sides.theirs);

    const placementsOf = (sequence: readonly string[], stable: Set<string>, side: "ours" | "theirs") => {
        const result = new Map<string, Placement>();
        let anchor = START;
        for (const key of sequence) {
            if (stable.has(key)) {
                anchor = key;
            } else if (keep.has(key)) {
                result.set(key, { key, side, anchor });
            }
        }
        return result;
    };
    const ours = placementsOf(sides.ours, stableOurs, "ours");
    const theirs = placementsOf(sides.theirs, stableTheirs, "theirs");

    // One item placed by both sides.
    const positionConflicts: PositionConflict[] = [];
    const contested = new Set<string>();
    for (const [key, mine] of ours) {
        const other = theirs.get(key);
        if (other === undefined) continue;
        contested.add(key);
        if (other.anchor === mine.anchor || !options.timeline) {
            theirs.delete(key);
            continue;
        }
        const index = baseIndex.get(key);
        positionConflicts.push({
            key,
            base: index === undefined ? undefined : index === 0 ? null : sides.base[index - 1],
            ours: anchorValue(mine.anchor),
            theirs: anchorValue(other.anchor),
        });
        if (options.positionChoice?.(key) === "theirs") ours.delete(key);
        else theirs.delete(key);
    }

    // Anchors that do not survive fall back along the placing side's sequence.
    const dropped = new Set<string>();
    const survives = (key: string) => keep.has(key) && !dropped.has(key);
    const resolveAnchors = () => {
        for (const [placements, sequence] of [
            [ours, sides.ours],
            [theirs, sides.theirs],
        ] as const) {
            let position: Map<string, number> | undefined;
            for (const placement of placements.values()) {
                if (placement.anchor === START || survives(placement.anchor)) continue;
                position ??= new Map(sequence.map((key, index) => [key, index]));
                let index = (position.get(placement.anchor) ?? 0) - 1;
                while (index >= 0 && !survives(sequence[index])) index--;
                placement.anchor = index < 0 ? START : sequence[index];
            }
        }
    };
    resolveAnchors();

    // Concurrent inserts at one anchor (timeline).
    const insertConflicts: InsertConflict[] = [];
    const theirsFirst = new Set<string>();
    if (options.timeline) {
        const byAnchor = (placements: Map<string, Placement>) => {
            const groups = new Map<string, string[]>();
            for (const placement of placements.values()) {
                if (contested.has(placement.key)) continue;
                const group = groups.get(placement.anchor);
                if (group) group.push(placement.key);
                else groups.set(placement.anchor, [placement.key]);
            }
            return groups;
        };
        const oursGroups = byAnchor(ours);
        const theirsGroups = byAnchor(theirs);
        for (const [anchor, mine] of oursGroups) {
            const other = theirsGroups.get(anchor);
            if (other === undefined) continue;
            insertConflicts.push({ anchor, ours: mine, theirs: other });
            const choice = options.insertChoice?.(anchor);
            if (choice === "theirs-first") theirsFirst.add(anchor);
            const drop = choice === "ours" ? other : choice === "theirs" ? mine : [];
            const placements = choice === "ours" ? theirs : ours;
            for (const key of drop) {
                placements.delete(key);
                // a new item goes; a moved one returns to its base position (the skeleton)
                if (!baseIndex.has(key)) dropped.add(key);
            }
        }
        if (dropped.size > 0) resolveAnchors();
    }

    // Emission: the skeleton in base order, each item followed by the placements anchored at it.
    const attached = new Map<string, { ours: string[]; theirs: string[] }>();
    const attach = (placements: Map<string, Placement>, sequence: readonly string[]) => {
        for (const key of sequence) {
            const placement = placements.get(key);
            if (placement === undefined) continue;
            let slot = attached.get(placement.anchor);
            if (slot === undefined) {
                slot = { ours: [], theirs: [] };
                attached.set(placement.anchor, slot);
            }
            slot[placement.side].push(key);
        }
    };
    attach(ours, sides.ours);
    attach(theirs, sides.theirs);

    const order: string[] = [];
    const emitted = new Set<string>();
    const emitAfter = (anchor: string) => {
        const slot = attached.get(anchor);
        if (slot === undefined) return;
        const groups = theirsFirst.has(anchor) ? [slot.theirs, slot.ours] : [slot.ours, slot.theirs];
        for (const key of groups.flat()) {
            if (emitted.has(key)) continue;
            emitted.add(key);
            order.push(key);
            emitAfter(key);
        }
    };
    emitAfter(START);
    for (const key of sides.base) {
        if (!survives(key) || ours.has(key) || theirs.has(key) || emitted.has(key)) continue;
        emitted.add(key);
        order.push(key);
        emitAfter(key);
    }
    // Placements anchored at each other in a loop (each side kept the other's item stable): last,
    // in ours' then theirs' order.
    for (const key of [...sides.ours, ...sides.theirs]) {
        if (!survives(key) || emitted.has(key)) continue;
        emitted.add(key);
        order.push(key);
        emitAfter(key);
    }
    return { order, positionConflicts, insertConflicts, dropped };
}
