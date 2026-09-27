// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import { type AsyncController, Plane, type SnapResult, XYZ } from "@spicy3d/core";
import { createMockApplication, createMockView, TestDocument } from "@spicy3d/core/test-utils";
import { SketchPointStep } from "../../src/sketch/commands/sketchPointStep";
import { SketchSplineCommand } from "../../src/sketch/commands/sketchSpline";
import { SketchEditor } from "../../src/sketch/editor/sketchEditor";
import { SketchSolver } from "../../src/sketch/solver";
import "./setup";

test.each([
    { key: "Enter", count: 4, commits: 1 },
    { key: " ", count: 2, commits: 1 },
    { key: "Escape", count: 4, commits: 0 },
    { key: "Enter", count: 1, commits: 0 },
])("$key after $count points commits $commits curves", async ({ key, count, commits }) => {
    const app = createMockApplication();
    const clearSelection = rs.fn(() => {});
    const document = new TestDocument({ application: app, selection: { clearSelection } as never });
    app.activeView = createMockView({ document });
    const solver = new SketchSolver(Plane.XY);
    const editor = {
        node: { plane: Plane.XY },
        solver,
        solve: rs.fn((fine: boolean) => solver.solve(fine)),
        commit: rs.fn(() => {}),
        screenTolerance: () => 0,
    };
    rs.spyOn(SketchEditor, "getActive").mockReturnValue(editor as unknown as SketchEditor);
    let picks = 0;
    rs.spyOn(SketchPointStep.prototype, "execute").mockImplementation(async function (
        this: SketchPointStep,
        _doc,
        controller: AsyncController,
    ) {
        if (picks < count) {
            const point = new XYZ({ x: 2 + picks * 4, y: picks % 2 === 0 ? 3 : 7, z: 0 });
            picks++;
            controller.success();
            return { point, shapes: [], view: app.activeView!, type: "input" } satisfies SnapResult;
        }
        // This is the callback the point-snap event handler calls before cancelling its pick.
        (this as unknown as { handleStepData(): { onKeyDown(event: KeyboardEvent): void } })
            .handleStepData()
            .onKeyDown(new KeyboardEvent("keydown", { key }));
        controller.cancel();
        return undefined;
    });
    try {
        await new SketchSplineCommand().execute(app);
        expect(editor.commit).toHaveBeenCalledTimes(commits);
        expect(solver.entities()).toHaveLength(commits);
        expect(clearSelection).toHaveBeenCalledTimes(1);
        expect(solver.entities().map((entity) => entity.type)).toEqual(Array(commits).fill("spline"));
        expect(solver.entities().map((entity) => entity.params.length)).toEqual(
            Array(commits).fill(count * 2),
        );
        expect(editor.solve.mock.calls).toEqual(Array.from({ length: commits }, () => [true]));
    } finally {
        rs.restoreAllMocks();
        solver.dispose();
    }
});
