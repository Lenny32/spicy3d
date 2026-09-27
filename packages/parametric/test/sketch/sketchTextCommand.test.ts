// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import { Plane, PubSub, XYZ } from "@spicy3d/core";
import { SketchTextCommand, textOutlineMesh } from "../../src/sketch/commands/sketchText";
import { SketchEditor } from "../../src/sketch/editor/sketchEditor";
import { SketchSolver } from "../../src/sketch/solver";
import "./setup";

function fakeEditor() {
    const solver = new SketchSolver(Plane.XY);
    return {
        node: { plane: Plane.XY },
        solver,
        solve: rs.fn((_fine: boolean) => {}),
        commit: rs.fn(() => {}),
        screenTolerance: () => 0.5,
    };
}

type FakeEditor = ReturnType<typeof fakeEditor>;

/** Runs the command's commit with its single step at (x, y). */
function place(command: SketchTextCommand, editor: FakeEditor, x: number, y: number) {
    const getActive = rs.spyOn(SketchEditor, "getActive").mockReturnValue(editor as any);
    (command as any).stepDatas = [{ point: new XYZ({ x, y, z: 0 }) }];
    try {
        (command as any).executeMainTask();
    } finally {
        getActive.mockRestore();
    }
}

function command(settings: { text?: string; height?: number; angle?: number } = {}) {
    const result = new SketchTextCommand();
    if (settings.text !== undefined) result.text = settings.text;
    if (settings.height !== undefined) result.height = settings.height;
    if (settings.angle !== undefined) result.angle = settings.angle;
    return result;
}

describe("sketch text command", () => {
    let editor: FakeEditor;
    beforeEach(() => {
        editor = fakeEditor();
    });
    afterEach(() => {
        editor.solver.dispose();
    });

    test("places a text at the picked point and commits", () => {
        place(command({ text: "AB", height: 8, angle: 15 }), editor, 3, 4);
        expect(editor.solver.textsData()).toEqual([
            { id: expect.any(Number), value: "AB", x: 3, y: 4, height: 8, angle: 15 },
        ]);
        expect(editor.commit).toHaveBeenCalledTimes(1);
    });

    test("clicking inside an existing text applies the settings to it, keeping its place", () => {
        place(command({ text: "Hello" }), editor, 0, 0);
        const [first] = editor.solver.textsData();
        place(command({ text: "Bye", height: 3 }), editor, 1, 1);
        expect(editor.solver.textsData()).toEqual([{ ...first, value: "Bye", height: 3, angle: 0 }]);
    });

    test("an empty text deletes the clicked text", () => {
        place(command({ text: "Hello" }), editor, 0, 0);
        place(command({ text: " " }), editor, 1, 1);
        expect(editor.solver.textsData()).toEqual([]);
        expect(editor.commit).toHaveBeenCalledTimes(2);
    });

    test("an empty text over empty space is refused", () => {
        const pub = rs.spyOn(PubSub.default, "pub").mockImplementation(() => {});
        try {
            place(command({ text: "" }), editor, 50, 50);
            expect(pub).toHaveBeenCalledWith("showToast", "error.sketch.emptyText");
            expect(editor.solver.textsData()).toEqual([]);
            expect(editor.commit).not.toHaveBeenCalled();
        } finally {
            pub.mockRestore();
        }
    });

    test("invalid heights are ignored", () => {
        const text = command({ height: 4 });
        text.height = 0;
        text.height = Number.NaN;
        expect(text.height).toBe(4);
    });

    test("the preview outline is one line-segment mesh on the sketch plane", () => {
        const mesh = textOutlineMesh(Plane.XY, { id: 0, value: "o", x: 0, y: 0, height: 10 });
        expect(mesh.position.length).toBeGreaterThan(0);
        expect(mesh.position.length % 6).toBe(0);
        for (let i = 2; i < mesh.position.length; i += 3) expect(mesh.position[i]).toBe(0);
    });
});
