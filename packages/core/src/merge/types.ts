// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { I18nKeys } from "../i18n";
import type { Serialized } from "../serialize";

// The data model of the three-way merge of two versions of a document against their common base
// (docs/merge.md). Declarations only: the engine that produces these is CLOUD-12, the conflict
// panel that consumes them CLOUD-13.

/** The three inputs of a merge. `ours` is this device's version, `theirs` the other device's (the server head). */
export type MergeSide = "base" | "ours" | "theirs";

/** The conflict taxonomy shared by the engine and the resolution UI (docs/merge.md, "Conflicts"). */
export type ConflictKind =
    /** Both sides set the same property (or feature parameter, sketch field, ...) to different values. */
    | "property"
    /** One side deleted an item the other side changed (or added something inside / referencing it). */
    | "delete-vs-modify"
    /** Both sides moved the same node to different parents. */
    | "move"
    /** The two sides' moves, each fine on its own, put a node inside its own subtree. */
    | "cycle"
    /** Order matters and the sides disagree: both inserted at the same timeline position, or both reordered one item differently. */
    | "order"
    /** After the merge a reference (sketch, edge, profile, variable, node, entity) points at nothing. */
    | "dangling-ref"
    /** Both sides added different items under the same id (a collision the id scheme makes vanishingly rare). */
    | "duplicate-id"
    /** A feature or node that rebuilds in both parents fails in the merge (the WASM validation pass). */
    | "rebuild-failure"
    /** Both sides replaced the same opaque geometry (BREP, mesh, image) with different content. */
    | "blob";

export const CONFLICT_KINDS: readonly ConflictKind[] = [
    "property",
    "delete-vs-modify",
    "move",
    "cycle",
    "order",
    "dangling-ref",
    "duplicate-id",
    "rebuild-failure",
    "blob",
];

/**
 * The message of each kind (`args` in docs/merge.md, "Conflicts"). Concurrent timeline inserts are
 * an `order` conflict with `merge.conflict.insertAt{0}`.
 */
export const CONFLICT_MESSAGE_KEYS: Readonly<Record<ConflictKind, I18nKeys>> = {
    property: "merge.conflict.property{0}{1}",
    "delete-vs-modify": "merge.conflict.deleteVsModify{0}",
    move: "merge.conflict.move{0}",
    cycle: "merge.conflict.cycle{0}{1}",
    order: "merge.conflict.order{0}",
    "dangling-ref": "merge.conflict.danglingRef{0}{1}",
    "duplicate-id": "merge.conflict.duplicateId{0}",
    "rebuild-failure": "merge.conflict.rebuildFailure{0}{1}",
    blob: "merge.conflict.blob{0}{1}",
};

/**
 * What the user may pick for a conflict (docs/merge.md lists which choices each kind offers):
 * `ours` / `theirs` — that side's value (for a delete-vs-modify, that side's deletion or edit);
 * `ours-first` / `theirs-first` — keep both, in that order (concurrent timeline inserts);
 * `accept` — keep the merged document as it is (a dangling reference or a rebuild failure the
 * user fixes afterwards).
 */
export type ResolutionChoice = "ours" | "theirs" | "ours-first" | "theirs-first" | "accept";

export interface MergeConflict {
    readonly kind: ConflictKind;
    /**
     * Where the conflict is, in the scheme of {@link mergePath}: built from ids only, never from
     * array positions, so the same conflict has the same path after a re-merge onto a newer head —
     * CLOUD-13 re-applies the user's choices by path.
     */
    readonly path: string;
    /** The value at `path` in each version, in serialized (JSON) form; `undefined` = absent there. */
    readonly base: unknown;
    readonly ours: unknown;
    readonly theirs: unknown;
    /** `I18n.translate(messageKey, ...args)` describes the conflict. */
    readonly messageKey: I18nKeys;
    readonly args: readonly unknown[];
    /**
     * The choices the resolution UI offers; the first is what the unresolved merge holds: `ours`
     * for a two-sided conflict, `ours-first` for concurrent timeline inserts, `accept` for a
     * dangling reference or a rebuild failure.
     */
    readonly choices: readonly ResolutionChoice[];
}

/** A user's pick for the conflict at `path`. */
export interface MergeResolution {
    readonly path: string;
    readonly choice: ResolutionChoice;
}

export type ChangeKind = "added" | "removed" | "modified" | "renamed" | "moved" | "reordered";

/**
 * One semantic difference between two versions, e.g. "Extrude 3: depth 10 → 15 mm". Produced by
 * the diff (history Compare, the "View changes" of a clean merge) with the same path scheme as
 * conflicts, so a change and a conflict about the same thing share their path.
 */
export interface Change {
    readonly kind: ChangeKind;
    readonly path: string;
    /**
     * The model node the change belongs to — what the UI highlights and groups by; `undefined`
     * for document-level changes (name, variables, settings, acts, materials).
     */
    readonly nodeId?: string;
    /** Serialized value before and after; `undefined` = absent. */
    readonly before: unknown;
    readonly after: unknown;
    readonly messageKey: I18nKeys;
    readonly args: readonly unknown[];
}

/** The three versions a merge ran on, migrated to this build's format (what a re-merge with choices starts from). */
export interface MergeInputs {
    readonly base: Serialized;
    readonly ours: Serialized;
    readonly theirs: Serialized;
}

export interface MergeResult {
    /**
     * The merged document, valid and loadable even while conflicts remain: every conflicting
     * location holds its first choice (see {@link MergeConflict.choices}), so an unresolved merge
     * is "mine plus every non-conflicting change of theirs".
     */
    readonly merged: Serialized;
    /** Deterministic order: document fields, variables, acts, materials, components, then nodes in merged tree order. */
    readonly conflicts: readonly MergeConflict[];
    /** What the merge changed relative to `ours` — the "View changes" list of a clean merge. */
    readonly changes: readonly Change[];
    /** The inputs, migrated: `resolveMerge` / `applyResolutions` re-merge from them with the user's choices. */
    readonly inputs: MergeInputs;
    /** The user's choices this result applies (a later `resolveMerge` keeps them, adding its own). */
    readonly resolutions: readonly MergeResolution[];
    /** The conflicts those choices answered (no longer in `conflicts`, still resolvable again by path). */
    readonly resolved: readonly MergeConflict[];
}

// ------------------------------------------------------------------ Paths

/**
 * The first segment of a merge path. The grammar under each root is in docs/merge.md ("Paths").
 */
export type MergePathRoot = "doc" | "variable" | "act" | "material" | "component" | "node";

/** Escapes one path segment like a JSON Pointer token (RFC 6901): `~` → `~0`, `/` → `~1`. */
function escapeSegment(segment: string | number): string {
    return String(segment).replaceAll("~", "~0").replaceAll("/", "~1");
}

function unescapeSegment(segment: string): string {
    return segment.replaceAll("~1", "/").replaceAll("~0", "~");
}

/**
 * Builds a merge path from its segments, e.g. `mergePath("node", bodyId, "feature", featureId,
 * "param", "depth")` → `node/<bodyId>/feature/<featureId>/param/depth`. Segments are ids, keys
 * and fixed words — never array indexes.
 */
export function mergePath(root: MergePathRoot, ...segments: readonly (string | number)[]): string {
    return [root, ...segments].map(escapeSegment).join("/");
}

/** The segments of a path built by {@link mergePath} (root first). */
export function parseMergePath(path: string): string[] {
    return path.split("/").map(unescapeSegment);
}

/** Whether `path` is `ancestor` or lies below it (`node/a` contains `node/a/prop/name`, not `node/ab`). */
export function isWithinMergePath(path: string, ancestor: string): boolean {
    return path === ancestor || path.startsWith(`${ancestor}/`);
}
