// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    CONFLICT_KINDS,
    CONFLICT_MESSAGE_KEYS,
    I18N_KEYS,
    isWithinMergePath,
    MERGE_RULES_BEGIN,
    MERGE_RULES_END,
    MergeRuleRegistry,
    MergeRules,
    mergePath,
    parseMergePath,
    renderMergeRules,
} from "../../src";

describe("merge paths", () => {
    test("are built from ids and words, escaped like JSON Pointer tokens", () => {
        expect(mergePath("node", "body-1", "feature", "f1", "param", "depth")).toBe(
            "node/body-1/feature/f1/param/depth",
        );
        expect(mergePath("node", "sketch-1", "entity", 734251950211)).toBe(
            "node/sketch-1/entity/734251950211",
        );
        expect(mergePath("act", "Front/Top~1")).toBe("act/Front~1Top~01");
    });

    test.each([
        ["node", ["a/b", "~", "feature", "x"]],
        ["act", ["Front/Top~1"]],
        ["doc", ["name"]],
    ] as const)("parse back what %s paths are built from", (root, segments) => {
        expect(parseMergePath(mergePath(root, ...segments))).toEqual([root, ...segments]);
    });

    test("containment is by whole segments", () => {
        expect(isWithinMergePath("node/a/prop/name", "node/a")).toBe(true);
        expect(isWithinMergePath("node/a", "node/a")).toBe(true);
        expect(isWithinMergePath("node/ab/prop/name", "node/a")).toBe(false);
    });
});

describe("conflict kinds", () => {
    test("every kind has a message the locale defines", () => {
        expect(Object.keys(CONFLICT_MESSAGE_KEYS).sort()).toEqual([...CONFLICT_KINDS].sort());
        for (const key of Object.values(CONFLICT_MESSAGE_KEYS)) expect(I18N_KEYS).toContain(key);
        expect(I18N_KEYS).toContain("merge.conflict.insertAt{0}");
    });
});

describe("MergeRuleRegistry", () => {
    test("refuses a second rule for one class and a record without key", () => {
        const registry = new MergeRuleRegistry();
        registry.registerClass("A", { strategy: "value", note: "a" });
        expect(() => registry.registerClass("A", { strategy: "value", note: "again" })).toThrow(/already/);
        expect(() => registry.registerClass("B", { strategy: "record", note: "no key" })).toThrow(/key/);
    });

    test("reports classes without a rule and payloads never registered", () => {
        const registry = new MergeRuleRegistry();
        registry.registerClass("Body", {
            strategy: "node",
            properties: { featuresJson: { kind: "json", payload: "features" } },
            note: "a body",
        });
        expect(registry.uncovered(["Body", "Sketch"])).toEqual(["Sketch"]);
        expect(registry.missingPayloads()).toEqual(["features"]);
        registry.registerPayload("features", { rule: { kind: "atomic" }, note: "the list" });
        expect(registry.missingPayloads()).toEqual([]);
    });

    test("core registers the envelope and its own classes", () => {
        expect(MergeRules.classRule("Document")?.strategy).toBe("document");
        expect(MergeRules.classRule("XYZ")?.strategy).toBe("value");
        expect(MergeRules.classRule("Material")).toMatchObject({ strategy: "record", key: "id" });
        expect(MergeRules.payloadRule("construction.definition")).toBeDefined();
    });

    test("renders a deterministic, delimited section", () => {
        const registry = new MergeRuleRegistry();
        registry.registerClass("Z", { strategy: "blob", note: "z | pipe" });
        registry.registerClass("A", {
            strategy: "node",
            properties: { name: { kind: "scalar" } },
            note: "a",
        });
        registry.registerPayload("p", {
            rule: { kind: "list", key: "id", order: "timeline", segment: "item", item: { kind: "scalar" } },
            note: "a list",
        });
        const text = renderMergeRules(registry);
        expect(text.startsWith(MERGE_RULES_BEGIN)).toBe(true);
        expect(text.endsWith(MERGE_RULES_END)).toBe(true);
        expect(text.indexOf("| `A` |")).toBeLessThan(text.indexOf("| `Z` |"));
        expect(text).toContain("z \\| pipe");
        expect(text).toContain("list of `item` by `id` (timeline order)");
        expect(renderMergeRules(registry)).toBe(text);
    });
});
