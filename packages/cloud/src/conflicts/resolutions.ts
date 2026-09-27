// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type MergeConflict,
    type MergeError,
    type MergeResolution,
    type MergeResult,
    parseMergePath,
    type ResolutionChoice,
    Result,
    resolveMerge,
} from "@spicy3d/core";

// The pure part of the conflict panel (CLOUD-13): the user's choices reapplied to a merge by path,
// and the conflicts grouped by the node they are about.

/** The user's choices reapplied to a merge (a fresh one: onto a newer head, or after an edit). */
export interface ReappliedResolutions {
    result: MergeResult;
    /** The choices that applied. */
    applied: MergeResolution[];
    /** The choices whose path the merge no longer has (or no longer offers that choice): dropped. */
    dropped: MergeResolution[];
}

/**
 * Applies `choices` to `result` by path, in rounds: a choice can create a conflict (taking one
 * side's version of a reference can leave another dangling), which a later choice answers — a
 * single `resolveMerge` call can't, it only knows the conflicts there are before it. What is left
 * once no round applies anything is `dropped`.
 */
export function reapplyResolutions(
    result: MergeResult,
    choices: readonly MergeResolution[],
): Result<ReappliedResolutions, MergeError> {
    let current = result;
    let pending = [...new Map(choices.map((c) => [c.path, c])).values()];
    const applied: MergeResolution[] = [];
    for (;;) {
        const known = new Map([...current.conflicts, ...current.resolved].map((c) => [c.path, c]));
        const now = pending.filter((c) => known.get(c.path)?.choices.includes(c.choice));
        if (now.length === 0) break;
        const resolved = resolveMerge(current, now);
        if (!resolved.isOk) return Result.err(resolved.error);
        current = resolved.value;
        applied.push(...now);
        pending = pending.filter((c) => !now.includes(c));
    }
    return Result.ok({ result: current, applied, dropped: pending });
}

/**
 * "Keep mine" for one conflict: this device's side when offered, else this device's first (both
 * kept), else as merged (a dangling reference or a rebuild failure, fixed afterwards).
 */
export function keepMineChoice(choices: readonly ResolutionChoice[]): ResolutionChoice {
    if (choices.includes("ours")) return "ours";
    if (choices.includes("ours-first")) return "ours-first";
    return choices.includes("accept") ? "accept" : choices[0];
}

/** "Take other" for one conflict: the other device's side, else its first, else as merged. */
export function takeTheirsChoice(choices: readonly ResolutionChoice[]): ResolutionChoice {
    if (choices.includes("theirs")) return "theirs";
    if (choices.includes("theirs-first")) return "theirs-first";
    return choices.includes("accept") ? "accept" : choices[0];
}

/** The node a conflict is about (`node/<id>/…`); `undefined` for document fields, variables, … */
export function conflictNodeId(conflict: Pick<MergeConflict, "path">): string | undefined {
    const [root, id] = parseMergePath(conflict.path);
    return root === "node" ? id : undefined;
}

/** The feature a conflict is about (`node/<body>/feature/<id>/…`). */
export function conflictFeatureId(conflict: Pick<MergeConflict, "path">): string | undefined {
    const segments = parseMergePath(conflict.path);
    return segments[0] === "node" && segments[2] === "feature" ? segments[3] : undefined;
}

export interface ConflictGroup<T extends { conflict: MergeConflict }> {
    /** The node's id, or `undefined` for the document's own conflicts. */
    nodeId?: string;
    rows: T[];
}

/**
 * Rows grouped by the node they are about, in the order the merge lists them (document fields
 * first, then nodes in tree order); a node's rows stay together even when a rebuild failure of
 * it comes at the end.
 */
export function groupConflicts<T extends { conflict: MergeConflict }>(
    rows: readonly T[],
): ConflictGroup<T>[] {
    const groups = new Map<string, ConflictGroup<T>>();
    for (const row of rows) {
        const nodeId = conflictNodeId(row.conflict);
        const key = nodeId ?? "";
        let group = groups.get(key);
        if (!group) {
            group = nodeId === undefined ? { rows: [] } : { nodeId, rows: [] };
            groups.set(key, group);
        }
        group.rows.push(row);
    }
    return [...groups.values()];
}
