// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import { Document } from "@spicy3d/app";
import { EMPTY_SCOPE, evaluateVariables, migrateDocument, PubSub, type Serialized } from "@spicy3d/core";
import { createMockApplication, loadDocumentFixtures } from "@spicy3d/core/test-utils";
import { migrateAngleSides, migrateSketchAngles } from "../src/angleMigration";
import { ConstraintKind, type SketchData } from "../src/sketch/sketchModel";
import { SketchNode } from "../src/sketch/sketchNode";
import "../src/migrations";
import "./sketch/setup";

function fixture(): Serialized {
    const found = loadDocumentFixtures().find((entry) => entry.name === "v2/sketch5-angle-side.json");
    expect(found).not.toBeUndefined();
    return structuredClone(found!.data);
}
function sketch(document: Serialized) {
    return document["models"].nodes.find((node: Serialized) => node["id"] === "sketch-angle")!;
}
function legacy(datum: number | string, degrees = -30): Serialized {
    const document = fixture();
    document["moduleVersions"]["sketch"] = 4;
    const data: SketchData = JSON.parse(sketch(document)["dataJson"]);
    const constraint = data.constraints.find((item) => item.kind === ConstraintKind.Angle)!;
    delete constraint.angleSide;
    constraint.datum = datum;
    const radians = (degrees * Math.PI) / 180;
    data.entities[0].params = [100, 0, 100 + 10 * Math.cos(radians), 10 * Math.sin(radians)];
    sketch(document)["dataJson"] = JSON.stringify(data);
    return document;
}

// Includes stale geometry, negative datums, and the ambiguous 0/180 boundaries.
test.each([
    [Math.PI / 6, -30, -1],
    ["tilt", -30, -1],
    [Math.PI / 6, 30, 1],
    [-Math.PI / 6, -30, 1],
    ["-tilt", -30, 1],
    [Math.PI / 4, -30, 1],
    [0, 0, 1],
    [Math.PI, -180, 1],
    ["missing", -30, 1],
] as const)("migration derives datum %s at %s degrees as side %s", (datum, degrees, side) => {
    const input = legacy(datum, degrees),
        before = structuredClone(input);
    const migrated = migrateDocument(input);
    expect(migrated.isOk).toBe(true);
    expect(migrated.value["moduleVersions"]).toMatchObject({ sketch: 5 });
    const data: SketchData = JSON.parse(sketch(migrated.value)["dataJson"]);
    expect(data.constraints.find((item) => item.kind === ConstraintKind.Angle)).toMatchObject({
        datum,
        angleSide: side,
    });
    expect(data.entities).toEqual(JSON.parse(sketch(before)["dataJson"]).entities);
    expect(migrated.value["userData"]).toEqual(before["userData"]);
    expect(input).toEqual(before);
    expect(migrateDocument(migrated.value).value).toEqual(migrated.value);
});

test("migration uses external line snapshots and reversed references", () => {
    const input = legacy(Math.PI / 6),
        data: SketchData = JSON.parse(sketch(input)["dataJson"]);
    const constraint = data.constraints.find((item) => item.kind === ConstraintKind.Angle)!;
    data.externalRefs = [
        {
            entityId: -10,
            nodeId: "source",
            edge: { kind: "line", start: { x: 0, y: 0, z: 0 }, end: { x: 10, y: 0, z: 0 } },
            type: "line",
            snapshot: data.entities[0].params,
            role: "reference",
        },
    ];
    constraint.refs[2].entityId = -10;
    constraint.refs[3].entityId = -10;
    const scope = evaluateVariables(input["variables"]).scope;
    expect(migrateAngleSides(data, scope).constraints.find((item) => item.id === 4)?.angleSide).toBe(-1);
    constraint.refs = [...constraint.refs.slice(2), ...constraint.refs.slice(0, 2)];
    expect(migrateAngleSides(data, scope).constraints.find((item) => item.id === 4)?.angleSide).toBe(1);
});

test.each([[], [100, 0, 100, 0]])("degenerate or missing geometry %j gets signed semantics", (params) => {
    const data: SketchData = JSON.parse(sketch(legacy(Math.PI / 6))["dataJson"]);
    data.entities[0].params = params;
    expect(migrateAngleSides(data, EMPTY_SCOPE).constraints.find((item) => item.id === 4)?.angleSide).toBe(1);
});

test.each([
    null,
    {},
    {
        models: {
            nodes: [
                null,
                { __cla$$__: "SketchNode", dataJson: "{" },
                { __cla$$__: "SketchNode", dataJson: "null" },
            ],
        },
    },
])("total document migration keeps malformed input %j", (input) => {
    // The registry only calls steps with envelopes; malformed node payloads remain for the loader.
    const envelope = { __cla$$__: "Document", ...(input ?? {}) } as Serialized;
    const before = structuredClone(envelope);
    expect(migrateSketchAngles(envelope)).toEqual(before);
});

test.each([
    4, 5,
])("Document.load accepts sketch %s and retains clockwise expression behavior", async (version) => {
    const app = createMockApplication();
    rs.stubGlobal("app", app);
    const input = version === 4 ? legacy("tilt") : fixture();
    const loaded = await Document.load(app, input);
    try {
        expect(loaded).not.toBeUndefined();
        const node = loaded!.modelManager.findNode((item) => item.id === "sketch-angle");
        expect(node).toBeInstanceOf(SketchNode);
        const solver = (node as SketchNode).createSolver();
        try {
            expect(solver.solve(true).result).toMatch(/^Ok/);
            expect(solver.toData().entities[0].params[3]).toBeCloseTo(-5, 6);
            expect(solver.toData().constraints.find((item) => item.id === 4)).toMatchObject({
                datum: "tilt",
                angleSide: -1,
            });
            const saved = loaded!.serialize();
            expect(saved["moduleVersions"]).toMatchObject({ sketch: 5 });
        } finally {
            solver.dispose();
        }
    } finally {
        loaded?.dispose();
        rs.unstubAllGlobals();
    }
});

test("Document.load refuses sketch 6 with the existing toast and leaves input untouched", async () => {
    const app = createMockApplication(),
        input = fixture();
    input["moduleVersions"]["sketch"] = 6;
    const before = structuredClone(input),
        pub = rs.spyOn(PubSub.default, "pub");
    try {
        expect(await Document.load(app, input)).toBeUndefined();
        expect(pub.mock.calls.filter(([topic]) => topic === "showToast").map((call) => call[1])).toContain(
            "error.document.newerFormat",
        );
        expect(input).toEqual(before);
        expect(app.documents.size).toBe(0);
    } finally {
        pub.mockRestore();
    }
});

test("component sketches migrate while opaque userData stays untouched", () => {
    const input = legacy("tilt"),
        componentNode = structuredClone(sketch(input));
    input["models"].components = [{ __cla$$__: "Component", id: "component", nodes: [componentNode] }];
    input["models"].nodes = [];
    input["userData"] = { models: { nodes: [structuredClone(componentNode)] } };
    const before = structuredClone(input),
        result = migrateDocument(input);
    expect(result.isOk).toBe(true);
    expect(
        JSON.parse(result.value["models"].components[0].nodes[0].dataJson).constraints.find(
            (item: SketchData["constraints"][number]) => item.id === 4,
        ).angleSide,
    ).toBe(-1);
    expect(result.value["userData"]).toEqual(before["userData"]);
    expect(input).toEqual(before);
});

test("stored origin point references use the same coordinates as the solver datum", () => {
    const data: SketchData = JSON.parse(sketch(legacy(Math.PI / 6))["dataJson"]);
    data.constraints.find((item) => item.id === 4)!.refs[0] = { entityId: -1, pointIndex: 0 };
    expect(migrateAngleSides(data, EMPTY_SCOPE).constraints.find((item) => item.id === 4)?.angleSide).toBe(
        -1,
    );
});
