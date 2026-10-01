// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import { Plane, PubSub, XYZ } from "@spicy3d/core";
import { createMockApplication, createMockView, TestDocument } from "@spicy3d/core/test-utils";
import { bsplinePointAt } from "../../src/sketch/bsplineGeometry";
import { SketchTextCommand, textOutlineMesh } from "../../src/sketch/commands/sketchText";
import { controlBSplineCurve } from "../../src/sketch/controlBSplineGeometry";
import { SketchEditor } from "../../src/sketch/editor/sketchEditor";
import { randomSketchIds } from "../../src/sketch/sketchIds";
import { SketchSolver } from "../../src/sketch/solver";
import { addTextGeometry, textContours } from "../../src/sketch/textGeometry";
import "./setup";

function fakeEditor() {
    return {
        node: { plane: Plane.XY },
        solver: new SketchSolver(Plane.XY),
        solve: rs.fn((_fine: boolean) => {}),
        commit: rs.fn(() => {}),
    };
}

test.each([
    0,
    -1,
    Infinity,
    Number.NaN,
    Number.MAX_VALUE,
])("invalid height %s leaves the sketch intact", (height) => {
    const solver = new SketchSolver(Plane.XY);
    try {
        const result = addTextGeometry(solver, { value: "HH", x: 0, y: 0, height, angle: 0 });
        expect(result.isOk).toBe(false);
        expect(result.error).toBe("error.sketch.invalidTextSize");
        expect(solver.toData()).toEqual({ entities: [], constraints: [] });
    } finally {
        solver.dispose();
    }
});

test("places exact quadratic outlines once using the configured height, angle and baseline", () => {
    const editor = fakeEditor();
    const active = rs.spyOn(SketchEditor, "getActive").mockReturnValue(editor as unknown as SketchEditor);
    try {
        const command = new SketchTextCommand();
        command.text = "o";
        command.height = 8;
        command.angle = 15;
        const options = { value: "o", x: 3, y: 4, height: 8, angle: 15 };
        (command as any).stepDatas = [{ point: new XYZ({ x: 3, y: 4, z: 0 }) }];
        (command as any).executeMainTask();
        expect(editor.solve).toHaveBeenCalledWith(true);
        expect(editor.commit).toHaveBeenCalledTimes(1);
        const contours = textContours(options);
        expect(contours.isOk).toBe(true);
        const segments = contours.value.flat();
        const entities = editor.solver.toData().entities;
        expect(entities).toHaveLength(segments.length);
        for (const [index, segment] of segments.entries()) {
            const entity = entities[index];
            expect(entity.params).toEqual(segment.flat());
            if (segment.length === 2) {
                expect(entity.type).toBe("line");
            } else {
                expect(entity.type).toBe("bspline");
                expect(entity.control).toEqual({ degree: 2, knots: [0, 1], multiplicities: [3, 3] });
                const curve = controlBSplineCurve(entity.params, entity.control!);
                expect(curve.isOk).toBe(true);
                const at = bsplinePointAt(curve.value, 0.5);
                expect(at[0]).toBeCloseTo((segment[0][0] + 2 * segment[1][0] + segment[2][0]) / 4, 12);
                expect(at[1]).toBeCloseTo((segment[0][1] + 2 * segment[1][1] + segment[2][1]) / 4, 12);
            }
        }
        expect(editor.solver.solve(true).result).toMatch(/^Ok/);
        expect(editor.solver.toData().entities).toEqual(entities);
    } finally {
        active.mockRestore();
        editor.solver.dispose();
    }
});

test.each(["", " \n ", "A中A"])("refuses %j atomically without committing", (text) => {
    const editor = fakeEditor();
    const active = rs.spyOn(SketchEditor, "getActive").mockReturnValue(editor as unknown as SketchEditor);
    const pub = rs.spyOn(PubSub.default, "pub").mockImplementation(() => {});
    try {
        const command = new SketchTextCommand();
        command.text = text;
        (command as any).stepDatas = [{ point: XYZ.zero }];
        (command as any).executeMainTask();
        expect(editor.solver.toData()).toEqual({ entities: [], constraints: [] });
        expect(editor.commit).not.toHaveBeenCalled();
        expect(pub).toHaveBeenCalledWith("displayError", expect.any(String));
    } finally {
        active.mockRestore();
        pub.mockRestore();
        editor.solver.dispose();
    }
});

test("random allocation does not collide with existing or subsequently added entities", () => {
    const solver = new SketchSolver(
        Plane.XY,
        {
            entities: [{ id: 1, type: "line", params: [-10, 0, -5, 0] }],
            constraints: [],
        },
        undefined,
        randomSketchIds,
    );
    try {
        const added = addTextGeometry(solver, { value: "Ao", x: 0, y: 0, height: 5, angle: 0 });
        expect(added.isOk).toBe(true);
        const line = solver.addLine(-10, 2, -5, 2);
        const ids = [1, ...added.value, line];
        expect(new Set(ids).size).toBe(ids.length);
        expect(solver.entities().map((e) => e.id)).toEqual(ids);
    } finally {
        solver.dispose();
    }
});

test("preview shows both contours on the sketch plane without changing the solver", () => {
    const editor = fakeEditor();
    const active = rs.spyOn(SketchEditor, "getActive").mockReturnValue(editor as unknown as SketchEditor);
    try {
        const command = new SketchTextCommand();
        command.text = "o";
        const options = { value: "o", x: 2, y: 3, height: 5, angle: 0 };
        const contours = textContours(options);
        expect(contours.isOk).toBe(true);
        expect(contours.value).toHaveLength(2);
        const mesh = textOutlineMesh(Plane.XY, options);
        expect(mesh.position.length).toBeGreaterThan(0);
        expect(mesh.position.length % 6).toBe(0);
        expect(
            Array.from(mesh.position)
                .filter((_, i) => i % 3 === 2)
                .every((z) => z === 0),
        ).toBe(true);
        const step = command.getSteps()[0];
        (step as any).handleStepData().preview(XYZ.zero);
        expect(editor.solver.toData()).toEqual({ entities: [], constraints: [] });
        expect(editor.commit).not.toHaveBeenCalled();
    } finally {
        active.mockRestore();
        editor.solver.dispose();
    }
});

test("cancelling the placement step leaves geometry and history untouched", async () => {
    const editor = fakeEditor();
    const active = rs.spyOn(SketchEditor, "getActive").mockReturnValue(editor as unknown as SketchEditor);
    const command = new SketchTextCommand();
    const doc = new TestDocument({ selection: { clearSelection: rs.fn(() => {}) } as any });
    const app = createMockApplication();
    Object.assign(app, { activeView: createMockView({ document: doc }) });
    let ready!: () => void;
    const started = new Promise<void>((resolve) => {
        ready = resolve;
    });
    rs.spyOn(command, "getSteps").mockReturnValue([
        {
            execute: (_document, controller) =>
                new Promise((resolve) => {
                    controller.onCancelled(() => resolve(undefined));
                    ready();
                }),
        },
    ]);
    try {
        const running = command.execute(app);
        await started;
        await command.cancel();
        await running;
        expect(command.isCanceled).toBe(true);
        expect(editor.solver.toData()).toEqual({ entities: [], constraints: [] });
        expect(editor.commit).not.toHaveBeenCalled();
        expect(doc.history.undoCount()).toBe(0);
    } finally {
        rs.restoreAllMocks();
        active.mockRestore();
        editor.solver.dispose();
    }
});
