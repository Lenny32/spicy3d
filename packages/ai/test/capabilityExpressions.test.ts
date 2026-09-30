// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import {
    ANGLE_UNITS,
    type EvaluatedValue,
    type IShape,
    type IVariableTable,
    LENGTH_UNITS,
    Result,
    ShapeTypes,
    XYZ,
} from "@spicy3d/core";
import { createMockApplication, createMockDocument } from "@spicy3d/core/test-utils";
import { queryCapabilities, shapeCapabilities } from "../src/tools/capabilities.generated";
import { buildCapabilityTools } from "../src/tools/capabilityEngine";

const solid = { shapeType: ShapeTypes.solid } as unknown as IShape;

/** A document whose variables are wall_t = 3.75 mm and draft = 5°, with a counting evaluate(). */
function setup(factory: Record<string, unknown>) {
    const scope = new Map<string, EvaluatedValue>([
        ["wall_t", { value: 3.75, unit: LENGTH_UNITS }],
        ["draft", { value: 5, unit: ANGLE_UNITS }],
    ]);
    const evaluate = rs.fn(() => ({ scope, errors: new Map<string, string>() }));
    const doc = createMockDocument({ variables: { evaluate } as Partial<IVariableTable> });
    const nodes: any[] = [];
    (doc.modelManager as any).addNode = rs.fn((node: any) => {
        nodes.push(node);
        node.parent = { remove: () => nodes.splice(nodes.indexOf(node), 1) };
    });
    (doc.modelManager as any).findNodes = rs.fn((pred: (n: any) => boolean) => nodes.filter(pred));
    const app = createMockApplication({ shapeProvider: { factory: factory as any } });
    (app as any).activeView = { document: doc };
    rs.stubGlobal("app", app);
    return { evaluate, doc };
}

const run = async (ops: unknown[]) =>
    JSON.parse((await buildCapabilityTools()[0].handler({ ops })) as string);

describe("run_program numeric expressions", () => {
    afterEach(() => {
        rs.unstubAllGlobals();
    });

    test("length and angle expressions resolve once against the document variables and are reported", async () => {
        const box = rs.fn((_plane: unknown, _dx: number, _dy: number, _dz: number) => Result.ok(solid));
        const thick = rs.fn((_shape: IShape, _thickness: number) => Result.ok(solid));
        const arc = rs.fn((_n: XYZ, _c: XYZ, _s: XYZ, _angle: number) => Result.ok(solid));
        const { evaluate } = setup({ box, makeThickSolidBySimple: thick, arc });

        const result = await run([
            { id: "b", method: "box", args: { dx: "wall_t * 8", dy: 20, dz: "10 mm" } },
            { id: "shell", method: "makeThickSolidBySimple", args: { shape: "b", thickness: "wall_t" } },
            { method: "arc", args: { start: { x: 1, y: 0, z: 0 }, angle: "draft * 9" } },
        ]);

        expect(box.mock.calls[0].slice(1)).toEqual([30, 20, 10]);
        expect(thick.mock.calls[0][1]).toBe(3.75);
        expect(arc.mock.calls[0][3]).toBe(45);
        expect(evaluate).toHaveBeenCalledTimes(1);
        expect(result.resolved).toEqual({
            b: { dx: 30, dz: 10 },
            shell: { thickness: 3.75 },
            "ops[2]": { angle: 45 },
        });
    });

    test("plain numbers pass as before and leave no resolved entry", async () => {
        const box = rs.fn((_plane: unknown, _dx: number, _dy: number, _dz: number) => Result.ok(solid));
        setup({ box });

        const result = await run([{ id: "b", method: "box", args: { dx: 1, dy: 2, dz: 3 } }]);

        expect(box.mock.calls[0].slice(1)).toEqual([1, 2, 3]);
        expect(result).not.toHaveProperty("resolved");
    });

    test("a unit mismatch names the param and the expression", async () => {
        const box = rs.fn(() => Result.ok(solid));
        const thick = rs.fn(() => Result.ok(solid));
        setup({ box, makeThickSolidBySimple: thick });

        await expect(
            run([
                { id: "b", method: "box", args: { dx: 1, dy: 1, dz: 1 } },
                { method: "makeThickSolidBySimple", args: { shape: "b", thickness: "draft" } },
            ]),
        ).rejects.toThrow(
            'thickness must be a number or a length expression, got "draft" (Dimension mismatch: expected length, got angle)',
        );
        expect(thick).not.toHaveBeenCalled();
    });

    test("an unknown variable names the param and the expression", async () => {
        const box = rs.fn(() => Result.ok(solid));
        const thick = rs.fn(() => Result.ok(solid));
        setup({ box, makeThickSolidBySimple: thick });

        await expect(
            run([
                { id: "b", method: "box", args: { dx: 1, dy: 1, dz: 1 } },
                { method: "makeThickSolidBySimple", args: { shape: "b", thickness: "wall_t2" } },
            ]),
        ).rejects.toThrow(
            'thickness must be a number or a length expression, got "wall_t2" (Unknown identifier: wall_t2)',
        );
        expect(thick).not.toHaveBeenCalled();
    });

    test("a variable whose own expression is broken reports why it is unknown", async () => {
        const box = rs.fn(() => Result.ok(solid));
        const thick = rs.fn(() => Result.ok(solid));
        const { doc } = setup({ box, makeThickSolidBySimple: thick });
        Object.assign(doc.variables, {
            items: [
                { id: "v1", name: "wall_t", type: "length", expression: "3.75" },
                { id: "v9", name: "rim", type: "length", expression: "wall_t +" },
            ],
            evaluate: () => ({
                scope: new Map<string, EvaluatedValue>([["wall_t", { value: 3.75, unit: LENGTH_UNITS }]]),
                errors: new Map([["v9", "Unexpected end of expression"]]),
            }),
        });

        await expect(
            run([
                { id: "b", method: "box", args: { dx: 1, dy: 1, dz: 1 } },
                { method: "makeThickSolidBySimple", args: { shape: "b", thickness: "rim * 2" } },
            ]),
        ).rejects.toThrow(
            'thickness must be a number or a length expression, got "rim * 2" (Unknown identifier: rim (variable "rim" does not evaluate: Unexpected end of expression))',
        );
        expect(thick).not.toHaveBeenCalled();
    });

    test("an angle param rejects a length expression", async () => {
        const arc = rs.fn(() => Result.ok(solid));
        setup({ arc });

        await expect(
            run([{ method: "arc", args: { start: { x: 1, y: 0, z: 0 }, angle: "wall_t" } }]),
        ).rejects.toThrow('angle must be a number or an angle expression, got "wall_t"');
    });

    test("a dimensionless param takes the expression's value without a unit check", async () => {
        const pointAt = rs.fn((_parameter: number) => new XYZ(1, 2, 3));
        const edge = { shapeType: ShapeTypes.edge, pointAt };
        const line = rs.fn(() => Result.ok(edge as unknown as IShape));
        setup({ line });

        const result = await run([
            { id: "l", method: "line", args: { start: { x: 0, y: 0, z: 0 }, end: { x: 10, y: 0, z: 0 } } },
            { id: "p", method: "edge.pointAt", target: "l", args: { parameter: "wall_t * 2" } },
        ]);

        expect(pointAt.mock.calls[0][0]).toBe(7.5);
        expect(result.resolved).toEqual({ p: { parameter: 7.5 } });
        expect(result.results.p).toEqual({ x: 1, y: 2, z: 3 });
    });

    test("a non-string, non-number value is rejected naming the accepted forms", async () => {
        const box = rs.fn(() => Result.ok(solid));
        setup({ box });

        await expect(run([{ method: "box", args: { dx: true, dy: 1, dz: 1 } }])).rejects.toThrow(
            "dx must be a number or a length expression, got true",
        );
        expect(box).not.toHaveBeenCalled();
    });
});

describe("generated numeric param units", () => {
    const numericParams = [...shapeCapabilities, ...queryCapabilities].flatMap((cap) =>
        cap.params.filter((p) => p.kind === "number").map((p) => ({ method: cap.method, ...p })),
    );

    test("every numeric param carries a unit tag", () => {
        expect(numericParams.length).toBeGreaterThan(50);
        const untagged = numericParams.filter((p) => !["length", "angle", "none"].includes(p.unit ?? ""));
        expect(untagged).toEqual([]);
    });

    test("only numeric params carry a unit", () => {
        const all = [...shapeCapabilities, ...queryCapabilities].flatMap((cap) => cap.params);
        expect(all.filter((p) => p.kind !== "number" && p.unit !== undefined)).toEqual([]);
    });

    test.each([
        ["makeThickSolidBySimple", "thickness", "length"],
        ["fillet", "radius", "length"],
        ["revolve", "angle", "angle"],
        ["helix", "pitch", "length"],
        ["simplifyShape", "angleTolerance", "none"],
        ["edge.pointAt", "parameter", "none"],
        ["surface.value", "u", "none"],
        ["shape.fixShape", "tolerance", "length"],
    ])("%s.%s is tagged %s", (method, name, unit) => {
        expect(numericParams.find((p) => p.method === method && p.name === name)?.unit).toBe(unit);
    });
});
