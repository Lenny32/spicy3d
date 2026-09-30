// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import { type AsyncController, Plane, type SnapResult, XYZ } from "@spicy3d/core";
import { createMockApplication, createMockView, TestDocument } from "@spicy3d/core/test-utils";
import { SketchBSplineCommand } from "../../src/sketch/commands/sketchBSpline";
import { SketchPointStep } from "../../src/sketch/commands/sketchPointStep";
import { SketchEditor } from "../../src/sketch/editor/sketchEditor";
import { SketchSolver } from "../../src/sketch/solver";
import "./setup";

// away from the origin and the axes, which the auto-constraints would snap the points onto
const PICKS: [number, number][] = [
    [5, 5],
    [15, 7],
    [19, 15],
    [9, 19],
];

/**
 * Runs the B-spline tool against scripted picks: `clicks` are the picked points in order; after
 * the last one the step is cancelled with `key` (Enter finishes, Escape discards).
 */
async function draw(clicks: [number, number][], key = "Escape") {
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
        screenTolerance: () => 0.5,
    };
    rs.spyOn(SketchEditor, "getActive").mockReturnValue(editor as unknown as SketchEditor);
    let picks = 0;
    rs.spyOn(SketchPointStep.prototype, "execute").mockImplementation(async function (
        this: SketchPointStep,
        _doc,
        controller: AsyncController,
    ) {
        if (picks < clicks.length) {
            const [x, y] = clicks[picks++];
            controller.success();
            return {
                point: new XYZ({ x, y, z: 0 }),
                shapes: [],
                view: app.activeView!,
                type: "input",
            } satisfies SnapResult;
        }
        (this as unknown as { handleStepData(): { onKeyDown(event: KeyboardEvent): void } })
            .handleStepData()
            .onKeyDown(new KeyboardEvent("keydown", { key }));
        controller.cancel();
        return undefined;
    });
    try {
        await new SketchBSplineCommand().execute(app);
        return {
            entities: solver.entities(),
            commits: editor.commit.mock.calls.length,
            selectionClears: clearSelection.mock.calls.length,
        };
    } finally {
        rs.restoreAllMocks();
        solver.dispose();
    }
}

describe("B-spline tool", () => {
    test("Enter finishes an open curve through every picked point", async () => {
        const { entities, commits, selectionClears } = await draw(PICKS, "Enter");
        expect(commits).toBe(1);
        expect(entities).toEqual([
            { id: entities[0].id, type: "bspline", params: PICKS.flat(), parametrization: "chord" },
        ]);
        expect(selectionClears).toBe(1);
    });

    test("a second click on the last point finishes it too", async () => {
        const { entities, commits } = await draw([...PICKS, [9.2, 19.1]]);
        expect(commits).toBe(1);
        expect(entities[0].params).toEqual(PICKS.flat());
        expect(entities[0].periodic).toBeUndefined();
    });

    test("a click back on the first point closes it into a periodic curve", async () => {
        const { entities, commits } = await draw([...PICKS, [5.1, 4.8]]);
        expect(commits).toBe(1);
        expect(entities[0]).toMatchObject({ type: "bspline", params: PICKS.flat(), periodic: true });
    });

    test("the first point closes nothing before three points are down", async () => {
        const { entities } = await draw([PICKS[0], PICKS[1], [5.1, 5.1]], "Enter");
        // with two points down, a click next to the first one is an ordinary fit point
        expect(entities[0].params).toEqual([...PICKS[0], ...PICKS[1], 5.1, 5.1]);
        expect(entities[0].periodic).toBeUndefined();
    });

    test.each([
        [PICKS, "Escape"],
        [[PICKS[0]], "Enter"],
    ] as [[number, number][], string][])("%j then %s creates nothing", async (clicks, key) => {
        const { entities, commits } = await draw(clicks, key);
        expect(commits).toBe(0);
        expect(entities).toEqual([]);
    });
});
