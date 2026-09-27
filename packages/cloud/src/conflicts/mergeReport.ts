// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { download, type MergeConflict, type MergeResolution, type MergeResult } from "@spicy3d/core";
import type { SyncConflict, SyncSide } from "../sync/syncEngine";

/** The format tag of a merge report file ("Export merge report", for bug reports). */
export const MERGE_REPORT_FORMAT = "spicy3d.mergeReport";

export interface MergeReport {
    format: typeof MERGE_REPORT_FORMAT;
    version: 1;
    documentId: string;
    /** ISO 8601 (UTC). */
    exportedAt: string;
    sides: { base: SyncSide; ours: SyncSide; theirs: SyncSide };
    /** The three versions merged (migrated to this build's format), as stored. */
    base: unknown;
    ours: unknown;
    theirs: unknown;
    /** Every conflict: still open, then answered (with the user's choice). */
    conflicts: (MergeConflict & { choice?: string })[];
    resolutions: MergeResolution[];
    /** Choices dropped because a re-merge no longer had their path. */
    dropped: MergeResolution[];
}

/** The report of a merge being resolved: the inputs, the conflicts and the choices so far. */
export function mergeReport(
    conflict: SyncConflict,
    result: MergeResult,
    options: { rebuildFailures?: readonly MergeConflict[]; dropped?: readonly MergeResolution[] } = {},
): MergeReport {
    const chosen = new Map(result.resolutions.map((r) => [r.path, r.choice]));
    const conflicts = [...result.conflicts, ...(options.rebuildFailures ?? []), ...result.resolved].map(
        (c) => {
            const choice = chosen.get(c.path);
            return choice === undefined ? { ...c } : { ...c, choice };
        },
    );
    return {
        format: MERGE_REPORT_FORMAT,
        version: 1,
        documentId: conflict.docId,
        exportedAt: new Date().toISOString(),
        sides: { base: conflict.base, ours: conflict.ours, theirs: conflict.theirs },
        base: result.inputs.base,
        ours: result.inputs.ours,
        theirs: result.inputs.theirs,
        conflicts,
        resolutions: [...result.resolutions],
        dropped: [...(options.dropped ?? [])],
    };
}

/** Downloads the report as `<name> merge report.json`. */
export function downloadMergeReport(report: MergeReport, name: string): void {
    // An absent side is left out, as in the merge fixtures.
    const json = JSON.stringify(report, undefined, 2);
    download([json], `${name} merge report.json`);
}
