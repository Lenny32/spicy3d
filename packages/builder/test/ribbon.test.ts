// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { I18N_KEYS, type RibbonTabProfile } from "@spicy3d/core";
import { SketchRibbonProfiles } from "@spicy3d/parametric";
import { DefaultRibbon, mergeRibbonProfiles, ParametricRibbonProfiles } from "../src/ribbon";

/** The order `AppBuilder.useParametric` applies the extras in. */
const parametricExtras = [...ParametricRibbonProfiles, ...SketchRibbonProfiles];

function findGroup(tabs: RibbonTabProfile[], tabName: string, groupName: string) {
    const group = tabs.find((t) => t.tabName === tabName)?.groups.find((g) => g.groupName === groupName);
    expect(group).not.toBeUndefined();
    return group!;
}

describe("DefaultRibbon", () => {
    test("should have the SOLID / SURFACE / UTILITIES workflow tabs", () => {
        expect(DefaultRibbon.map((t) => t.tabName)).toEqual([
            "ribbon.tab.solid",
            "ribbon.tab.surface",
            "ribbon.tab.utilities",
        ]);
    });

    test("SOLID should have Fusion's task groups", () => {
        expect(DefaultRibbon[0].groups.map((g) => g.groupName)).toEqual([
            "ribbon.group.create",
            "ribbon.group.modify",
            "ribbon.group.assemble",
            "ribbon.group.construct",
            "ribbon.group.inspect",
            "ribbon.group.insert",
        ]);
    });

    test("SURFACE should have create, modify and convert groups", () => {
        expect(DefaultRibbon[1].groups.map((g) => g.groupName)).toEqual([
            "ribbon.group.create",
            "ribbon.group.modify",
            "ribbon.group.convert",
        ]);
    });

    test("should only hold direct-modeling commands", () => {
        const all = DefaultRibbon.flatMap((t) =>
            t.groups.flatMap((g) => [...flattenItems(g.items), ...(g.collapsedItems ?? [])]),
        );
        expect(all.some((x) => x.startsWith("feature.") || x.startsWith("sketch."))).toBe(false);
    });

    test("should keep formerly visible commands reachable in some group", () => {
        const all = DefaultRibbon.flatMap((t) =>
            t.groups.flatMap((g) => [...flattenItems(g.items), ...(g.collapsedItems ?? [])]),
        );
        for (const key of [
            "create.box",
            "create.line",
            "modify.fillet",
            "boolean.join",
            "convert.toSolid",
            "measure.select",
            "file.import",
            "test.performance",
        ]) {
            expect(all).toContain(key);
        }
    });

    test("file.export should leave the ribbon for the quick commands", () => {
        const all = DefaultRibbon.flatMap((t) => t.groups.flatMap((g) => flattenItems(g.items)));
        expect(all).not.toContain("file.export");
    });

    test("SOLID/CREATE should start with the direct sweep and loft without parametric", () => {
        const create = findGroup(DefaultRibbon, "ribbon.tab.solid", "ribbon.group.create");
        expect(flattenItems(create.items).slice(0, 2)).toEqual(["create.sweep", "create.loft"]);
    });
});

describe("SketchRibbonProfiles", () => {
    test("the contextual sketch tab should end with FINISH SKETCH", () => {
        const sketchTab = SketchRibbonProfiles.find((t) => t.tabName === "ribbon.tab.sketch")!;
        expect(sketchTab.contextual).toBe(true);
        expect(sketchTab.groups.map((g) => g.groupName)).toEqual([
            "ribbon.group.create",
            "ribbon.group.modify",
            "ribbon.group.constraint",
            "ribbon.group.dimension",
            "ribbon.group.finish",
        ]);
        const finish = sketchTab.groups.at(-1)!;
        expect(finish.primary).toBe(true);
        expect(finish.items).toEqual(["sketch.exit", "sketch.autoConstrain"]);
        expect(flattenItems(sketchTab.groups[0].items)).toContain("sketch.spline");
    });

    test("constraint group should be icon-only and hold all 18 constraint tools", () => {
        const group = findGroup(SketchRibbonProfiles, "ribbon.tab.sketch", "ribbon.group.constraint");
        expect(group.iconOnly).toBe(true);
        const items = flattenItems(group.items);
        expect(items.length).toBe(18);
        expect(items.every((x) => x.startsWith("constraint."))).toBe(true);
    });

    test("dimension group should hold the 6 dimensions", () => {
        const group = findGroup(SketchRibbonProfiles, "ribbon.tab.sketch", "ribbon.group.dimension");
        const items = flattenItems(group.items);
        expect(items.length).toBe(6);
        expect(items.every((x) => x.startsWith("dimension."))).toBe(true);
    });
});

describe("mergeRibbonProfiles", () => {
    test("with parametric, SOLID/CREATE should lead with sketch.create then the features", () => {
        const merged = mergeRibbonProfiles(DefaultRibbon, parametricExtras);
        const create = findGroup(merged, "ribbon.tab.solid", "ribbon.group.create");
        expect(flattenItems(create.items).slice(0, 5)).toEqual([
            "sketch.create",
            "feature.extrude",
            "feature.revolve",
            "create.sweep",
            "create.loft",
        ]);
        expect(create.collapsedItems?.[0]).toBe("sketch.enter");
    });

    test("with parametric, SOLID/MODIFY should lead with the feature commands", () => {
        const merged = mergeRibbonProfiles(DefaultRibbon, parametricExtras);
        const modify = findGroup(merged, "ribbon.tab.solid", "ribbon.group.modify");
        expect(flattenItems(modify.items)).toEqual([
            "feature.fillet",
            "feature.chamfer",
            "feature.fuse",
            "feature.cut",
            "feature.common",
            "modify.shell",
            "modify.move",
        ]);
        expect(modify.collapsedItems?.[0]).toBe("feature.variable");
    });

    test("should append the contextual sketch tab after the base tabs", () => {
        const merged = mergeRibbonProfiles(DefaultRibbon, parametricExtras);
        expect(merged.map((t) => t.tabName)).toEqual([
            "ribbon.tab.solid",
            "ribbon.tab.surface",
            "ribbon.tab.utilities",
            "ribbon.tab.sketch",
        ]);
    });

    test("should carry the group flags of a contributed group", () => {
        const merged = mergeRibbonProfiles(DefaultRibbon, parametricExtras);
        expect(findGroup(merged, "ribbon.tab.sketch", "ribbon.group.constraint").iconOnly).toBe(true);
    });

    test("should not mutate the base profiles", () => {
        const before = JSON.stringify(DefaultRibbon);
        mergeRibbonProfiles(DefaultRibbon, parametricExtras);
        expect(JSON.stringify(DefaultRibbon)).toBe(before);
    });
});

describe("ribbon command keys", () => {
    test("every ribbon command should have an i18n name", () => {
        const merged = mergeRibbonProfiles(DefaultRibbon, parametricExtras);
        const all = merged.flatMap((t) =>
            t.groups.flatMap((g) => [...flattenItems(g.items), ...(g.collapsedItems ?? [])]),
        );
        const missing = all.filter((key) => !I18N_KEYS.includes(`command.${key}` as never));
        expect(missing).toEqual([]);
    });
});

/** Recursively flatten item entries that may be strings, string arrays, or {type, items} objects. */
function flattenItems(items: any[]): string[] {
    const result: string[] = [];
    for (const item of items) {
        if (typeof item === "string") {
            result.push(item);
        } else if (Array.isArray(item)) {
            result.push(...item);
        } else if (typeof item === "object" && "items" in item && Array.isArray(item.items)) {
            result.push(...flattenItems(item.items));
        }
    }
    return result;
}
