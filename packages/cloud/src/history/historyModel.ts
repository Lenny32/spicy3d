// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { groupByLocalDay, type I18nKeys, parseUtc, type RelativeTimeOptions } from "@spicy3d/core";
import type { ApiSchema } from "../api";
import type { CloudVersion } from "../documents/repository";

export type VersionKind = CloudVersion["kind"];

export const VERSION_KIND_LABELS: Record<VersionKind, I18nKeys> = {
    manual: "cloud.history.kind.manual",
    auto: "cloud.history.kind.auto",
    merge: "cloud.history.kind.merge",
    restore: "cloud.history.kind.restore",
    mcp: "cloud.history.kind.mcp",
};

export const VERSION_KIND_ICONS: Record<VersionKind, string> = {
    manual: "icon-save",
    auto: "icon-history",
    merge: "icon-sync-alt",
    restore: "icon-restoreVersion",
    mcp: "icon-macro",
};

/** One version shown as its own row. */
export interface VersionRow {
    type: "version";
    version: CloudVersion;
}

/** Consecutive autosaves shown as one "N autosaves" row (expandable). */
export interface AutosaveRun {
    type: "autosaves";
    /** Stable across renders while the run keeps its newest version: that version's id. */
    key: string;
    versions: CloudVersion[];
}

export type HistoryRow = VersionRow | AutosaveRun;

export interface HistoryGroup {
    /** `today`, `yesterday`, `last7Days`, `YYYY-MM` (see `groupByLocalDay`). */
    key: string;
    label: string;
    rows: HistoryRow[];
}

export interface HistoryViewOptions extends RelativeTimeOptions {
    /** "Manual only": hides the autosaves the server may prune (see {@link isKept}). */
    manualOnly?: boolean;
    /** The document's head: always its own row, never folded into an autosave run. */
    headId?: string;
}

/**
 * Kept forever by the server's retention (SpicySrv `AutosavePruner`): every kind but `auto`, and
 * autosaves that are labeled or pinned (the head too, but it moves on).
 */
export function isKept(version: CloudVersion): boolean {
    return version.kind !== "auto" || Boolean(version.label) || version.pinned;
}

/** An unnamed, unpinned autosave that isn't the head: what "N autosaves" folds. */
function isFoldable(version: CloudVersion, headId: string | undefined): boolean {
    return !isKept(version) && version.id !== headId;
}

export function versionTime(version: CloudVersion): number {
    return parseUtc(version.createdAt);
}

/** Folds runs of two or more consecutive foldable autosaves; the order is kept. */
export function foldAutosaves(versions: readonly CloudVersion[], headId?: string): HistoryRow[] {
    const rows: HistoryRow[] = [];
    let run: CloudVersion[] = [];
    const flush = () => {
        if (run.length === 1) rows.push({ type: "version", version: run[0] });
        else if (run.length > 1) rows.push({ type: "autosaves", key: run[0].id, versions: run });
        run = [];
    };
    for (const version of versions) {
        if (isFoldable(version, headId)) {
            run.push(version);
        } else {
            flush();
            rows.push({ type: "version", version });
        }
    }
    flush();
    return rows;
}

/**
 * The history as the panel shows it: `versions` (newest first, as listed) filtered by "Manual
 * only", grouped by local day ("Today", "Yesterday", "Last 7 days", then months), consecutive
 * autosaves folded within each group.
 */
export function historyGroups(
    versions: readonly CloudVersion[],
    options: HistoryViewOptions = {},
): HistoryGroup[] {
    const shown = options.manualOnly ? versions.filter(isKept) : versions;
    return groupByLocalDay(shown, versionTime, options).map((group) => ({
        key: group.key,
        label: group.label,
        rows: foldAutosaves(group.items, options.headId),
    }));
}

/**
 * The device whose changes a merge version took in: the device of its first parent (the head it
 * merged, SpicySrv `NewVersionRequest.parentIds`), when that version is known; else `undefined`.
 */
export function mergedFromDevice(
    version: CloudVersion,
    byId: ReadonlyMap<string, CloudVersion>,
): string | undefined {
    if (version.kind !== "merge") return undefined;
    const parent = version.parentIds[0];
    return (parent && byId.get(parent)?.deviceName) || undefined;
}

/** `config.storage.autosaveRetention`; `int32` fields may come as strings. */
export type RetentionPolicy = { [K in keyof ApiSchema<"AutosaveRetentionPolicy">]: number | string };

/** The server's autosave retention as numbers. */
export function retentionOf(policy: RetentionPolicy): {
    keepAllHours: number;
    hourlyDays: number;
    dailyDays: number;
} {
    return {
        keepAllHours: Number(policy.keepAllHours),
        hourlyDays: Number(policy.hourlyDays),
        dailyDays: Number(policy.dailyDays),
    };
}
