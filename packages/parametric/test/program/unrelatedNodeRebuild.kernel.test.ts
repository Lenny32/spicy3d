// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * Issue #164: a body lofted through sketches on construction planes rebuilt (and every section
 * dropped its profile cache) whenever any node entered the tree — each new, unrelated sketch.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Transaction } from "@spicy3d/core";
import { createMockApplication, createMockVisualWithDocument, TestDocument } from "@spicy3d/core/test-utils";
import { initWasm, ShapeFactory } from "@spicy3d/wasm";
import { featureHandler } from "../../src/features/feature";
import { ParametricBodyNode } from "../../src/parametricBodyNode";
import { type ParametricOp, runParametricProgram } from "../../src/program/parametricProgram";
import { SketchNode } from "../../src/sketch/sketchNode";
import "../sketch/setup";

const previousFactory = Object.getOwnPropertyDescriptor(globalThis, "shapeFactory");
beforeAll(async () => {
    await initWasm({
        wasmBinary: readFileSync(
            path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../wasm/lib/spicy-wasm.wasm"),
        ),
    });
    Object.defineProperty(globalThis, "shapeFactory", {
        value: new ShapeFactory(),
        writable: true,
        configurable: true,
    });
});
afterAll(() => {
    if (previousFactory) Object.defineProperty(globalThis, "shapeFactory", previousFactory);
    else Reflect.deleteProperty(globalThis, "shapeFactory");
});
afterEach(() => {
    rs.restoreAllMocks();
});

const SECTIONS = 4;

function run(doc: TestDocument, ops: ParametricOp[]) {
    let result: ReturnType<typeof runParametricProgram> | undefined;
    Transaction.execute(doc, "test program", () => {
        result = runParametricProgram(doc, ops);
    });
    return result!;
}

/** A wall section as in the report: a B-spline, its associative offset and two joining caps. */
function section(index: number): ParametricOp[] {
    const points = Array.from({ length: 8 }, (_, i) => [i * 3, Math.sin(i / 3 + index) * 2 + 5]);
    return [
        {
            op: "construct",
            id: `plane${index}`,
            definition: { kind: "plane-offset", source: "YZ", distance: index * 10 },
        },
        {
            op: "sketch",
            id: `section${index}`,
            plane: { construction: `plane${index}` },
            entities: [{ type: "bspline", points, name: "outer" }],
            constraints: [{ kind: "Block", entities: ["outer"] }],
            actions: [
                { action: "offset", entity: "outer", distance: "wall_t", associative: true, name: "inner" },
                {
                    action: "add",
                    entities: [
                        { type: "line", params: [0, 0, 0, 1], name: "startCap" },
                        { type: "line", params: [21, 0, 21, 1], name: "endCap" },
                    ],
                    constraints: [
                        ["outer", 0, "startCap", 0],
                        ["inner", 0, "startCap", -1],
                        ["outer", -1, "endCap", 0],
                        ["inner", -1, "endCap", -1],
                    ].map(([first, firstPoint, second, secondPoint]) => ({
                        kind: "Coincident",
                        points: [
                            { entity: first, point: firstPoint },
                            { entity: second, point: secondPoint },
                        ],
                    })),
                },
            ],
        },
    ] as ParametricOp[];
}

function loftedDocument() {
    const doc = new TestDocument({ application: createMockApplication() });
    doc.visual = createMockVisualWithDocument(doc) as any;
    doc.variables.setItems([{ id: "wall", name: "wall_t", type: "length", expression: "1" }]);
    run(doc, Array.from({ length: SECTIONS }, (_, index) => section(index)).flat());
    const created = run(doc, [
        {
            op: "loft",
            id: "wall",
            sections: Array.from({ length: SECTIONS }, (_, index) => `section${index}`),
        },
    ] as ParametricOp[]);
    const body = doc.modelManager.findNode((node) => node.id === created.created[0].nodeId);
    expect(body).toBeInstanceOf(ParametricBodyNode);
    const sections = doc.modelManager.findNodes(
        (node): node is SketchNode => node instanceof SketchNode,
    ) as SketchNode[];
    expect(sections).toHaveLength(SECTIONS);
    for (const sketch of sections) expect(sketch.constructionPlaneRef?.kind).toBe("datum");
    const loft = body as ParametricBodyNode;
    expect(loft.shape.isOk).toBe(true);
    expect(loft.shape.value.volume()).toBeGreaterThan(0);
    return { doc, body: loft, sections };
}

test.each<[string, ParametricOp[]]>([
    [
        "sketch",
        [{ op: "sketch", id: "test", plane: "XY", entities: [{ type: "circle", params: [0, 0, 1] }] }],
    ],
    [
        "construction plane",
        [{ op: "construct", id: "other", definition: { kind: "plane-offset", source: "XY", distance: 7 } }],
    ],
] as [
    string,
    ParametricOp[],
][])("an unrelated %s neither rebuilds the loft nor re-derives its sections", (_, ops) => {
    const { doc, body, sections } = loftedDocument();
    const revisions = sections.map((sketch) => sketch.geometryRevision);
    const shape = body.shape.value;
    const loft = featureHandler("loft")!;
    const evaluate = rs.spyOn(loft, "evaluate");
    const changed = rs.fn((property: string) => property);
    body.onPropertyChanged(changed);
    for (const sketch of sections) sketch.onPropertyChanged(changed);

    run(doc, ops);

    expect(evaluate).not.toHaveBeenCalled();
    expect(changed.mock.calls.map(([property]) => property)).toEqual([]);
    expect(sections.map((sketch) => sketch.geometryRevision)).toEqual(revisions);
    expect(body.shape.value).toBe(shape);
});
