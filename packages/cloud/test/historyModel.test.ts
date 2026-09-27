// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { CloudVersion } from "../src/documents/repository";
import {
    foldAutosaves,
    historyGroups,
    isKept,
    mergedFromDevice,
    retentionOf,
} from "../src/history/historyModel";

const NOW = Date.parse("2026-09-27T12:00:00Z");
const ZONE = { now: NOW, timeZone: "Europe/Paris" };
let sequence = 0;

function version(createdAt: string, fields: Partial<CloudVersion> = {}): CloudVersion {
    sequence++;
    return {
        id: `v${String(sequence).padStart(3, "0")}`,
        documentId: "doc-1",
        parentIds: [],
        kind: "auto",
        label: null,
        pinned: false,
        createdAt,
        deviceName: "Desk – Firefox",
        clientId: "tab",
        formatVersion: 1,
        manifestSha256: "m",
        thumbnailSha256: null,
        sizeBytes: 1,
        ...fields,
    };
}

/** Rows as `kind` / `auto×N`, per group key. */
function shape(groups: ReturnType<typeof historyGroups>) {
    return groups.map((g) => [
        g.key,
        g.rows.map((r) => (r.type === "version" ? r.version.kind : `auto×${r.versions.length}`)),
    ]);
}

describe("history rows", () => {
    test("grouped by local day, newest first; runs of autosaves fold, kept ones and the head never do", () => {
        const versions = [
            version("2026-09-27T11:55:00Z", { kind: "auto" }), // head
            version("2026-09-27T11:50:00Z"),
            version("2026-09-27T11:45:00Z"),
            version("2026-09-27T11:40:00Z"),
            version("2026-09-27T10:00:00Z", { kind: "manual" }),
            version("2026-09-27T09:55:00Z"),
            version("2026-09-27T09:50:00Z", { label: "Sent to supplier" }),
            version("2026-09-27T09:45:00Z"),
            version("2026-09-26T15:00:00Z"),
            version("2026-09-26T14:00:00Z", { pinned: true }),
            version("2026-09-22T14:00:00Z", { kind: "restore" }),
            version("2026-08-03T14:00:00Z", { kind: "merge" }),
        ];

        const groups = historyGroups(versions, { ...ZONE, headId: versions[0].id });

        expect(shape(groups)).toEqual([
            ["today", ["auto", "auto×3", "manual", "auto", "auto", "auto"]],
            ["yesterday", ["auto", "auto"]],
            ["last7Days", ["restore"]],
            ["2026-08", ["merge"]],
        ]);
        expect(groups.map((g) => g.label)).toEqual([
            "dateTime.today",
            "dateTime.yesterday",
            "dateTime.last7Days",
            expect.stringMatching(/2026/),
        ]);
        const run = groups[0].rows[1];
        expect(run.type === "autosaves" && run.versions.map((v) => v.id)).toEqual([
            versions[1].id,
            versions[2].id,
            versions[3].id,
        ]);
        expect(run.type === "autosaves" && run.key).toBe(versions[1].id);
    });

    test("a run doesn't cross a local day boundary (Paris: 23:30 UTC is already tomorrow)", () => {
        const versions = [
            version("2026-09-26T22:30:00Z"), // 00:30 on the 27th in Paris
            version("2026-09-26T22:20:00Z"),
            version("2026-09-26T21:50:00Z"), // 23:50 on the 26th
            version("2026-09-26T21:40:00Z"),
        ];

        expect(shape(historyGroups(versions, ZONE))).toEqual([
            ["today", ["auto×2"]],
            ["yesterday", ["auto×2"]],
        ]);
    });

    test("“Manual only” keeps what the server never prunes: every kind but auto, named or pinned autosaves", () => {
        const versions = [
            version("2026-09-27T11:00:00Z"),
            version("2026-09-27T10:59:00Z", { kind: "mcp" }),
            version("2026-09-27T10:58:00Z", { label: "Named" }),
            version("2026-09-27T10:57:00Z", { pinned: true }),
            version("2026-09-27T10:56:00Z"),
            version("2026-09-27T10:55:00Z", { kind: "manual" }),
        ];

        expect(versions.map(isKept)).toEqual([false, true, true, true, false, true]);
        expect(shape(historyGroups(versions, { ...ZONE, manualOnly: true }))).toEqual([
            ["today", ["mcp", "auto", "auto", "manual"]],
        ]);
    });

    test("a single autosave between kept versions is its own row", () => {
        const rows = foldAutosaves([
            version("2026-09-27T11:00:00Z", { kind: "manual" }),
            version("2026-09-27T10:00:00Z"),
            version("2026-09-27T09:00:00Z", { kind: "manual" }),
        ]);

        expect(rows.map((r) => r.type)).toEqual(["version", "version", "version"]);
    });

    test("a merge names the device of the head it merged (its first parent), when that one is loaded", () => {
        const theirs = version("2026-09-27T10:00:00Z", { deviceName: "Laptop – Chrome" });
        const mine = version("2026-09-27T09:00:00Z");
        const merge = version("2026-09-27T11:00:00Z", { kind: "merge", parentIds: [theirs.id, mine.id] });
        const byId = new Map([theirs, mine, merge].map((v) => [v.id, v]));

        expect(mergedFromDevice(merge, byId)).toBe("Laptop – Chrome");
        expect(mergedFromDevice(merge, new Map())).toBeUndefined();
        expect(mergedFromDevice(theirs, byId)).toBeUndefined();
    });

    test("the retention policy reads int32 fields sent as strings", () => {
        expect(retentionOf({ keepAllHours: "24", hourlyDays: 7, dailyDays: "30" })).toEqual({
            keepAllHours: 24,
            hourlyDays: 7,
            dailyDays: 30,
        });
    });
});
