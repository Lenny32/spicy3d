// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { MergeConflict, MergeResult, ResolutionChoice } from "@spicy3d/core";
import {
    formatConflictValue,
    MergeNames,
    oursLabel,
    theirsLabel,
    theirsName,
} from "../src/conflicts/conflictText";
import {
    conflictFeatureId,
    conflictNodeId,
    groupConflicts,
    keepMineChoice,
    takeTheirsChoice,
} from "../src/conflicts/resolutions";

// The pure parts of the conflict panel (CLOUD-13): grouping, bulk choices, labels and values.

function conflict(path: string, extra: Partial<MergeConflict> = {}): MergeConflict {
    return {
        kind: "property",
        path,
        base: undefined,
        ours: undefined,
        theirs: undefined,
        messageKey: "merge.conflict.property{0}{1}",
        args: [],
        choices: ["ours", "theirs"],
        ...extra,
    };
}

const doc = (nodes: Record<string, unknown>[]) => ({ id: "d", models: { nodes } });
const names = new MergeNames({
    inputs: {
        base: doc([{ id: "root", __cla$$__: "FolderNode" }]),
        ours: doc([{ id: "folder-a", name: "Folder A" }]),
        theirs: doc([{ id: "folder-b", name: "Folder B" }]),
    },
    merged: doc([]),
} as unknown as MergeResult);

describe("grouping", () => {
    test("rows are grouped by the node they are about, the document's own first as listed", () => {
        const rows = [
            conflict("variable/v1/expression"),
            conflict("node/a/prop/name"),
            conflict("node/b/feature/f1/param/depth"),
            conflict("node/a/parent"),
            conflict("node/b/feature/f1/rebuild", { kind: "rebuild-failure" }),
        ].map((c) => ({ conflict: c }));

        const groups = groupConflicts(rows);

        expect(groups.map((g) => [g.nodeId, g.rows.map((r) => r.conflict.path)])).toEqual([
            [undefined, ["variable/v1/expression"]],
            ["a", ["node/a/prop/name", "node/a/parent"]],
            ["b", ["node/b/feature/f1/param/depth", "node/b/feature/f1/rebuild"]],
        ]);
        expect(conflictNodeId(rows[2].conflict)).toBe("b");
        expect(conflictFeatureId(rows[2].conflict)).toBe("f1");
        expect(conflictFeatureId(rows[1].conflict)).toBeUndefined();
    });
});

describe("bulk choices", () => {
    test.each<[ResolutionChoice[], ResolutionChoice, ResolutionChoice]>([
        [["ours", "theirs"], "ours", "theirs"],
        [["ours-first", "theirs-first", "ours", "theirs"], "ours", "theirs"],
        [["accept", "ours", "theirs"], "ours", "theirs"],
        [["ours-first", "theirs-first"], "ours-first", "theirs-first"],
        [["accept"], "accept", "accept"],
    ])("%j: keep mine = %s, take theirs = %s", (choices, mine, other) => {
        expect(keepMineChoice(choices)).toBe(mine);
        expect(takeTheirsChoice(choices)).toBe(other);
    });
});

describe("labels and values", () => {
    test("the sides: this device, the other device, an agent", () => {
        expect(oursLabel({ deviceName: "Desktop", at: 0 })).toContain("cloud.merge.thisDeviceNamedDesktop");
        expect(theirsLabel({ deviceName: "Laptop", at: 0 })).toContain("cloud.merge.otherDeviceLaptop");
        expect(theirsLabel({ deviceName: "Laptop", at: 0, kind: "mcp" })).toContain("cloud.merge.agent");
        expect(theirsName({ deviceName: "Laptop", kind: "mcp" })).toBe("cloud.merge.agentName");
        expect(theirsName({})).toBe("cloud.conflict.unknownDevice");
    });

    test.each([
        ["an absent value", conflict("node/a/prop/name"), undefined, "cloud.merge.value.absent"],
        [
            "a deletion",
            conflict("node/a", { kind: "delete-vs-modify" }),
            undefined,
            "cloud.merge.value.deleted",
        ],
        ["a parent, by its name", conflict("node/x/parent", { kind: "move" }), "folder-b", "Folder B"],
        ["a number", conflict("node/a/feature/f/param/depth"), 12.5000000001, "12.5"],
        ["an expression", conflict("variable/v/expression"), "w * 2", "w * 2"],
        [
            "a blob",
            conflict("node/a/prop/shape", { kind: "blob" }),
            { $blob: "abc" },
            "cloud.merge.value.data",
        ],
        ["an item by its name", conflict("node/a/feature/f"), { name: "Folder A" }, "Folder A"],
        ["a list", conflict("node/a/feature/f/param/edges"), [1, 2, 3], "cloud.merge.value.items3"],
        ["a flag", conflict("node/a/prop/visible"), false, "cloud.merge.value.no"],
    ])("%s", (_what, c, value, text) => {
        expect(formatConflictValue(c, value, names)).toBe(text);
    });

    test("node names come from every side ", () => {
        expect(names.node("folder-a")).toBe("Folder A");
        expect(names.node("root")).toBe("FolderNode");
        expect(names.node("unknown")).toBe("unknown");
    });
});
