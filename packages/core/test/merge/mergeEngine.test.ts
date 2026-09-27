// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    diffDocuments,
    expressionNames,
    JsonEquality,
    MergeRuleRegistry,
    MergeRules,
    mergeDocuments,
    mergeOrder,
    NODE_PROPERTIES,
    type Serialized,
    sha256Hex,
    sha256HexSync,
    stableKeys,
} from "../../src";

// Pieces of the merge engine on their own (the fixture corpus and the property tests, which need
// every module's rules, are in packages/builder/test/merge*.test.ts).

const encoder = new TextEncoder();

describe("sha256HexSync", () => {
    test.each(["", "abc", "x".repeat(1000), "é€𝄞"])("hashes %j like SubtleCrypto", async (text) => {
        const bytes = encoder.encode(text);
        expect(sha256HexSync(bytes)).toBe(await sha256Hex(bytes));
    });
});

describe("JsonEquality", () => {
    const eq = new JsonEquality();

    test("is exact and ignores key order and absent keys", () => {
        expect(eq.equals({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true);
        expect(eq.equals({ a: 1, b: undefined }, { a: 1, c: null })).toBe(true);
        expect(eq.equals(0.1 + 0.2, 0.3)).toBe(false);
        expect(eq.equals(0, -0)).toBe(false);
        expect(eq.equals(Number.NaN, Number.NaN)).toBe(true);
        expect(eq.equals([1, 2], [2, 1])).toBe(false);
    });

    test("compares an inline value with a manifest reference by hash, in the reference's encoding", async () => {
        const text = "BREP ".repeat(100);
        const ref = { $blob: await sha256Hex(encoder.encode(text)) };
        expect(eq.equals(text, ref)).toBe(true);
        expect(eq.equals(ref, `${text}!`)).toBe(false);
        const numbers = [1.5, 2, -3];
        const float32 = {
            $blob: await sha256Hex(new Uint8Array(new Float32Array(numbers).buffer)),
            $as: "float32",
        };
        expect(eq.equals(numbers, float32)).toBe(true);
        expect(eq.equals([1.5, 2, -4], float32)).toBe(false);
    });
});

describe("list order", () => {
    const index = (keys: string[]) => new Map(keys.map((k, i) => [k, i]));

    test("the stable items of a side keep the earliest base items", () => {
        expect([...stableKeys(index(["a", "b", "c"]), ["a", "c", "b"])].sort()).toEqual(["a", "b"]);
        expect([...stableKeys(index(["a", "b", "c", "d"]), ["d", "a", "b", "c"])].sort()).toEqual([
            "a",
            "b",
            "c",
        ]);
    });

    test("stable lists: both sides' inserts at one place, ours first; a deleted anchor falls back", () => {
        const sides = { base: ["a", "b", "c"], ours: ["a", "x", "b", "c"], theirs: ["a", "y", "c"] };
        const result = mergeOrder(sides, new Set(["a", "x", "y", "c"]), { timeline: false });
        expect(result.order).toEqual(["a", "x", "y", "c"]);
        expect(result.insertConflicts).toEqual([]);
    });

    test("an item moved by both sides to one place is placed once; to two places: ours (stable) or a conflict (timeline)", () => {
        const same = { base: ["a", "b", "c"], ours: ["c", "a", "b"], theirs: ["c", "a", "b"] };
        expect(mergeOrder(same, new Set(same.base), { timeline: true }).order).toEqual(["c", "a", "b"]);
        const apart = {
            base: ["a", "b", "c", "d"],
            ours: ["a", "d", "b", "c"],
            theirs: ["a", "b", "d", "c"],
        };
        const stable = mergeOrder(apart, new Set(apart.base), { timeline: false });
        expect(stable.order).toEqual(["a", "d", "b", "c"]);
        const timeline = mergeOrder(apart, new Set(apart.base), { timeline: true });
        expect(timeline.positionConflicts).toEqual([{ key: "d", base: "c", ours: "a", theirs: "b" }]);
        const theirs = mergeOrder(apart, new Set(apart.base), {
            timeline: true,
            positionChoice: () => "theirs",
        });
        expect(theirs.order).toEqual(["a", "b", "d", "c"]);
    });

    test("timeline: different items placed at one anchor conflict; the choice orders or drops them", () => {
        const sides = { base: ["a", "b"], ours: ["a", "b", "x"], theirs: ["a", "b", "y"] };
        const keep = new Set(["a", "b", "x", "y"]);
        const conflicted = mergeOrder(sides, keep, { timeline: true });
        expect(conflicted.insertConflicts).toEqual([{ anchor: "b", ours: ["x"], theirs: ["y"] }]);
        expect(conflicted.order).toEqual(["a", "b", "x", "y"]);
        const order = (choice: "theirs-first" | "ours" | "theirs") =>
            mergeOrder(sides, keep, { timeline: true, insertChoice: () => choice }).order;
        expect(order("theirs-first")).toEqual(["a", "b", "y", "x"]);
        expect(order("ours")).toEqual(["a", "b", "x"]);
        expect(order("theirs")).toEqual(["a", "b", "y"]);
    });
});

describe("expressionNames", () => {
    test.each([
        ["w / 2", ["w"]],
        ["40 mm", []],
        ["(w + 2) cm * sin(angle)", ["w", "angle"]],
        ["pi * r2 ^ 2", ["r2"]],
        [12, []],
    ])("%j uses %j", (expression, names) => {
        expect(expressionNames(expression)).toEqual(names);
    });
});

// ------------------------------------------------------------------ Rule kinds, on a test registry

const rules = new MergeRuleRegistry();
rules.registerClass("Document", MergeRules.classRule("Document")!);
rules.registerClass("FolderNode", { strategy: "node", properties: NODE_PROPERTIES, note: "" });
rules.registerClass("Gadget", {
    strategy: "node",
    properties: { ...NODE_PROPERTIES, dataJson: { kind: "json", payload: "test.gadget" } },
    note: "",
});
rules.registerPayload("test.gadget", {
    segment: "gadget",
    note: "",
    rule: {
        kind: "object",
        fields: { counter: { kind: "max" }, floor: { kind: "min" }, cache: { kind: "derived" } },
        groups: { axis: ["axis", "axisEdge"] },
    },
});

function gadgetDocument(data: Record<string, unknown>, acts: object[] = []): Serialized {
    return {
        __cla$$__: "Document",
        formatVersion: 1,
        moduleVersions: {},
        id: "doc",
        name: "Doc",
        models: {
            nodes: [
                { __cla$$__: "FolderNode", id: "root", name: "Doc", visible: true },
                {
                    __cla$$__: "Gadget",
                    id: "g",
                    name: "Gadget",
                    visible: true,
                    parentId: "root",
                    dataJson: JSON.stringify(data),
                },
            ],
            materials: [],
            components: [],
        },
        variables: [],
        settings: {},
        acts,
        userData: {},
    } as unknown as Serialized;
}

function gadget(base: object, ours: object, theirs: object) {
    const result = mergeDocuments(
        gadgetDocument(base as any),
        gadgetDocument(ours as any),
        gadgetDocument(theirs as any),
        rules,
    );
    expect(result.isOk).toBe(true);
    const node = result.value.merged["models"].nodes[1];
    return { data: JSON.parse(node.dataJson), conflicts: result.value.conflicts };
}

describe("rule kinds", () => {
    test("max / min: three-way first; both changed → the larger / smaller; a side that drops it wins", () => {
        expect(gadget({ counter: 5 }, { counter: 7 }, { counter: 5 }).data).toEqual({ counter: 7 });
        expect(gadget({ counter: 5 }, { counter: 7 }, { counter: 9 }).data).toEqual({ counter: 9 });
        expect(gadget({ floor: -100 }, { floor: -104 }, { floor: -101 }).data).toEqual({ floor: -104 });
        expect(gadget({ counter: 5 }, {}, { counter: 5 }).data).toEqual({});
        expect(gadget({ counter: 5 }, {}, { counter: 9 }).data).toEqual({});
    });

    test("derived: the side that changed it, else ours — never a conflict", () => {
        expect(gadget({ cache: 1 }, { cache: 1 }, { cache: 2 })).toEqual({
            data: { cache: 2 },
            conflicts: [],
        });
        expect(gadget({ cache: 1 }, { cache: 3 }, { cache: 2 })).toEqual({
            data: { cache: 3 },
            conflicts: [],
        });
    });

    test("a group of alternative fields is one value, at its group's path", () => {
        const base = { axis: [0, 0, 1] };
        const merged = gadget(base, { axisEdge: "e1" }, { axis: [1, 0, 0] });
        expect(merged.data).toEqual({ axisEdge: "e1" });
        expect(merged.conflicts.map((c) => [c.kind, c.path, c.ours, c.theirs])).toEqual([
            ["property", "node/g/gadget/axis", { axisEdge: "e1" }, { axis: [1, 0, 0] }],
        ]);
        // one side switching the alternative, the other untouched: taken whole
        expect(gadget(base, { axisEdge: "e1" }, base).data).toEqual({ axisEdge: "e1" });
    });

    test("acts of one name are told apart by occurrence: act/<name>, then act/<name>/#2", () => {
        const act = (name: string, z: number) => ({
            __cla$$__: "Act",
            name,
            cameraPosition: { x: 0, y: 0, z, __cla$$__: "XYZ" },
            cameraTarget: { x: 0, y: 0, z: 0, __cla$$__: "XYZ" },
            cameraUp: { x: 0, y: 1, z: 0, __cla$$__: "XYZ" },
        });
        const base = gadgetDocument({}, [act("View", 1), act("View", 2), act("View#2", 3)]);
        const ours = gadgetDocument({}, [act("View", 1), act("View", 5), act("View#2", 3)]);
        const theirs = gadgetDocument({}, [act("View", 1), act("View", 6), act("View#2", 3)]);
        const result = mergeDocuments(base, ours, theirs);
        expect(result.value.merged["acts"]).toEqual(ours["acts"]);
        expect(result.value.conflicts.map((c) => c.path)).toEqual(["act/View/#2/cameraPosition"]);
    });
});

describe("diffDocuments", () => {
    test("lists changes at the merge's paths, recomputed state left out", () => {
        const changes = diffDocuments(
            gadgetDocument({ counter: 1, cache: 1 }),
            gadgetDocument({ counter: 2, cache: 2 }),
            rules,
        );
        expect(changes.value).toEqual([]);
        const renamed = gadgetDocument({});
        renamed["models"].nodes[1].name = "Widget";
        expect(
            diffDocuments(gadgetDocument({}), renamed, rules).value.map((c) => [c.kind, c.path, c.args]),
        ).toEqual([["renamed", "node/g/prop/name", ["Gadget", "Widget"]]]);
    });
});
