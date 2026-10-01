// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import { Plane, PubSub, XYZ } from "@spicy3d/core";
import { createMockApplication, createMockView, TestDocument } from "@spicy3d/core/test-utils";
import { SketchTextCommand, textOutlineMesh } from "../../src/sketch/commands/sketchText";
import { SketchEditor } from "../../src/sketch/editor/sketchEditor";
import { randomSketchIds, sequentialSketchIds } from "../../src/sketch/sketchIds";
import { shapeEntityIds } from "../../src/sketch/sketchModel";
import { SketchSolver } from "../../src/sketch/solver";
import { addTextGeometry, textContourKeys, textContours } from "../../src/sketch/textGeometry";
import "./setup";

function fakeEditor() {
    return {
        isActive: true,
        node: { plane: Plane.XY },
        solver: new SketchSolver(Plane.XY),
        solve: rs.fn((_fine: boolean) => {}),
        commit: rs.fn(() => {}),
        annotations: { setGeometryPreview: rs.fn(() => {}) },
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

test("places an editable frame only after the dialog confirms", () => {
    const editor = fakeEditor();
    const active = rs.spyOn(SketchEditor, "getActive").mockReturnValue(editor as unknown as SketchEditor);
    const pub = rs.spyOn(PubSub.default, "pub").mockImplementation(() => {});
    try {
        const command = new SketchTextCommand();
        command.text = "o";
        command.height = 8;
        command.angle = 15;
        (command as any).stepDatas = [
            { point: new XYZ({ x: 3, y: 4, z: 0 }) },
            { point: new XYZ({ x: 23, y: 14, z: 0 }) },
        ];
        (command as any).executeMainTask();
        expect(editor.commit).not.toHaveBeenCalled();
        const call = pub.mock.calls.find((call) => call[0] === "showDialog");
        expect(call).not.toBeUndefined();
        const buttons = call![3] as any;
        expect(buttons[0].shouldClose()).toBe(true);
        expect(editor.commit).toHaveBeenCalledTimes(1);
        expect(editor.solver.toData().entities).toEqual([]);
        expect(editor.solver.texts()).toHaveLength(1);
        expect(editor.solver.texts()[0]).toMatchObject({
            value: "o",
            x: 3,
            y: 4,
            height: 8,
            angle: 15,
            frame: { width: 20, height: 10 },
        });
        expect(editor.solver.texts()[0].profileIds).toHaveLength(2);
    } finally {
        active.mockRestore();
        pub.mockRestore();
        editor.solver.dispose();
    }
});

test.each(["", " \n ", "A\u4e2dA"])("invalid %j stays in the dialog without mutation", (text) => {
    const editor = fakeEditor();
    const active = rs.spyOn(SketchEditor, "getActive").mockReturnValue(editor as unknown as SketchEditor);
    const pub = rs.spyOn(PubSub.default, "pub").mockImplementation(() => {});
    try {
        const command = new SketchTextCommand();
        command.text = text;
        (command as any).stepDatas = [{ point: XYZ.zero }, { point: new XYZ({ x: 20, y: 10, z: 0 }) }];
        (command as any).executeMainTask();
        const call = pub.mock.calls.find((call) => call[0] === "showDialog");
        expect(call).not.toBeUndefined();
        expect((call![3] as any)[0].shouldClose()).toBe(false);
        expect(editor.solver.toData()).toEqual({ entities: [], constraints: [] });
        expect(editor.commit).not.toHaveBeenCalled();
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
        (command as any).stepDatas = [{ point: XYZ.zero }];
        const step = command.getSteps()[1];
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

test("script updates keep retired contour identities through solver round trips and allocations", () => {
    const solver = new SketchSolver(Plane.XY, undefined, undefined, sequentialSketchIds());
    try {
        const added = solver.addText({
            value: "B",
            x: 0,
            y: 0,
            height: 5,
            angle: 0,
            frame: { width: 20, height: 10 },
        });
        expect(added.isOk).toBe(true);
        const original = solver.text(added.value)!;
        expect(original.profileIds).toHaveLength(3);
        expect(solver.updateText(added.value, { value: "H" }).isOk).toBe(true);
        const replaced = solver.text(added.value)!.profileIds;
        expect(replaced).toHaveLength(4);
        expect(replaced.slice(1)).toEqual(original.profileIds);
        expect(original.profileIds).not.toContain(replaced[0]);
        const line = solver.addLine(50, 0, 60, 0);
        expect([original.id, ...replaced]).not.toContain(line);
        const roundTrip = new SketchSolver(Plane.XY, solver.toData(), undefined, sequentialSketchIds());
        try {
            expect(roundTrip.updateText(added.value, { height: 8, angle: 25 }).isOk).toBe(true);
            expect(roundTrip.text(added.value)!.profileIds).toEqual(replaced);
            // Retired slots stay reserved: B comes back with fresh contour identities.
            expect(roundTrip.updateText(added.value, { value: "B" }).isOk).toBe(true);
            const restored = roundTrip.text(added.value)!.profileIds;
            expect(restored).toHaveLength(7);
            expect(restored.slice(3)).toEqual(replaced);
            expect([original.id, ...replaced, line]).not.toContain(restored[0]);
            expect(new Set(restored).size).toBe(7);
            expect(roundTrip.solve(true).result).toMatch(/^Ok/);
            expect(roundTrip.text(added.value)).toMatchObject({ value: "B", height: 8, angle: 25 });
            const later = roundTrip.addPoint(50, 10);
            expect([original.id, ...restored, line]).not.toContain(later);
        } finally {
            roundTrip.dispose();
        }
    } finally {
        solver.dispose();
    }
});

test("contour identities follow glyphs, not contour indices", () => {
    const solver = new SketchSolver(Plane.XY, undefined, undefined, sequentialSketchIds());
    try {
        const added = solver.addText({
            value: "AB",
            x: 0,
            y: 0,
            height: 5,
            angle: 0,
            frame: { width: 20, height: 10 },
        });
        expect(added.isOk).toBe(true);
        const before = solver.text(added.value)!.profileIds;
        const aCount = textContourKeys("A").length;
        expect(aCount).toBe(2);
        expect(before).toHaveLength(aCount + 3);
        const aIds = before.slice(0, aCount);
        const bIds = before.slice(aCount);

        expect(solver.updateText(added.value, { value: "XB" }).isOk).toBe(true);
        const after = solver.text(added.value)!.profileIds;
        const xCount = textContourKeys("X").length;
        expect(xCount).toBe(1);
        expect(after.slice(xCount, xCount + 3)).toEqual(bIds);
        expect([...aIds, ...bIds, added.value]).not.toContain(after[0]);
        // A's contours are retired: still reserved, past the live contour slots.
        expect(after.slice(xCount + 3)).toEqual(aIds);
        const shapeIds = new Set(shapeEntityIds(solver.toData()));
        expect([...bIds, after[0]].every((id) => shapeIds.has(id))).toBe(true);
        expect(aIds.some((id) => shapeIds.has(id))).toBe(false);

        expect(solver.updateText(added.value, { value: "BX" }).isOk).toBe(true);
        const swapped = solver.text(added.value)!.profileIds;
        expect(swapped.slice(0, 3)).toEqual(bIds);
        expect(swapped[3]).toBe(after[0]);
        expect(swapped.slice(4)).toEqual(aIds);
    } finally {
        solver.dispose();
    }
});

test.each([
    { height: 9 },
    { x: 4, y: -3 },
    { angle: 30 },
    { frame: { width: 40, height: 20 } },
    { alignment: "center" as const, verticalAlignment: "middle" as const },
    { spacing: 25 },
    { flipHorizontal: true, flipVertical: true },
])("layout-only edit %o keeps every contour identity", (patch) => {
    const solver = new SketchSolver(Plane.XY, undefined, undefined, sequentialSketchIds());
    try {
        const added = solver.addText({
            value: "AB\nA",
            x: 0,
            y: 0,
            height: 5,
            angle: 0,
            frame: { width: 20, height: 10 },
        });
        expect(added.isOk).toBe(true);
        const before = solver.text(added.value)!.profileIds;
        expect(solver.updateText(added.value, patch).isOk).toBe(true);
        expect(solver.text(added.value)!.profileIds).toEqual(before);
    } finally {
        solver.dispose();
    }
});

test("contour keys match textContours order and count occurrences per glyph", () => {
    const contours = textContours({ value: "AB\nA", x: 0, y: 0, height: 5, angle: 0 });
    expect(contours.isOk).toBe(true);
    const keys = textContourKeys("AB\nA");
    expect(keys).toHaveLength(contours.value.length);
    expect(keys).toEqual(["A#0:0", "A#0:1", "B#0:0", "B#0:1", "B#0:2", "A#1:0", "A#1:1"]);
});

test("an unknown font is reported as such", () => {
    const result = textContours({ value: "A", x: 0, y: 0, height: 5, angle: 0, font: "serif" as "sans" });
    expect(result.isOk).toBe(false);
    expect(result.error).toBe("error.sketch.unsupportedTextFont");
});

test("cancelled text edits clear previews and preserve content", () => {
    const editor = fakeEditor();
    const active = rs.spyOn(SketchEditor, "getActive").mockReturnValue(editor as unknown as SketchEditor);
    const pub = rs.spyOn(PubSub.default, "pub").mockImplementation(() => {});
    try {
        const command = new SketchTextCommand();
        (command as any).stepDatas = [{ point: XYZ.zero }, { point: new XYZ({ x: 20, y: 10, z: 0 }) }];
        (command as any).executeMainTask();
        const call = pub.mock.calls.find((call) => call[0] === "showDialog");
        expect(call).not.toBeUndefined();
        const content = call![2] as HTMLElement,
            input = content.querySelector("textarea");
        expect(input).not.toBeNull();
        const dialogKey = rs.fn((_event: KeyboardEvent) => {});
        content.addEventListener("keydown", dialogKey);
        input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        expect(dialogKey).not.toHaveBeenCalled();
        input!.value = "Changed";
        input!.dispatchEvent(new Event("input", { bubbles: true }));
        expect(editor.annotations.setGeometryPreview).toHaveBeenCalledWith(
            expect.arrayContaining([expect.objectContaining({ position: expect.any(Float32Array) })]),
        );
        (call![3] as any)[1].onclick();
        expect(editor.annotations.setGeometryPreview).toHaveBeenLastCalledWith([]);
        expect(editor.commit).not.toHaveBeenCalled();
        expect(editor.solver.texts()).toEqual([]);
    } finally {
        active.mockRestore();
        pub.mockRestore();
        editor.solver.dispose();
    }
});
