// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import { Plane } from "@spicy3d/core";
import type { SketchEditor } from "../../src/sketch/editor/sketchEditor";
import { SolverFeedback } from "../../src/sketch/editor/solverFeedback";
import {
    randomSketchIds,
    type SketchIdAllocator,
    sequentialSketchIds,
    setDefaultSketchIds,
} from "../../src/sketch/sketchIds";
import { ConstraintKind } from "../../src/sketch/sketchModel";
import { SketchSolver } from "../../src/sketch/solver";
import { centerRef, lineRefs } from "../../src/sketch/solverEntities";
import "./setup";

// Run with counted ids (the suites' default) and with the random ids production draws: the panel
// numbers items by their place in the sketch, never by their stored 12–13 digit ids.
const ALLOCATORS: [string, () => SketchIdAllocator][] = [
    ["counted", sequentialSketchIds],
    ["random", () => randomSketchIds],
];

describe.each(ALLOCATORS)("solver feedback (%s sketch ids)", (_name, allocator) => {
    let restoreIds: () => void;
    beforeAll(() => {
        restoreIds = setDefaultSketchIds(allocator);
    });
    afterAll(() => restoreIds());

    let solver: SketchSolver;
    let panel: SolverFeedback;
    let host: HTMLElement;
    const select = rs.fn((_id: number) => {});
    const remove = rs.fn((_ids: Iterable<number>) => {});
    const commit = rs.fn(() => {});
    beforeEach(() => {
        select.mockClear();
        remove.mockClear();
        commit.mockClear();
        solver = new SketchSolver(Plane.XY);
        host = document.createElement("div");
        document.body.append(host);
        const editor = {
            solver,
            annotations: {
                selectConstraint: select,
                setDiagnosticConstraints: rs.fn((_ids: Set<number>) => {}),
            },
            deleteConstraints: remove,
            deleteEntities: rs.fn((_ids: Iterable<number>) => {}),
            editDatum: rs.fn((_id: number) => {}),
            solve: (fine: boolean) => {
                const result = solver.solve(fine);
                panel.update(result, fine);
                return result;
            },
            commit,
        } as unknown as SketchEditor;
        panel = new SolverFeedback(editor, host);
    });
    afterEach(() => {
        panel.dispose();
        solver.dispose();
        host.remove();
    });
    function button(text: string) {
        const element = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes(text));
        expect(element).not.toBeUndefined();
        return element!;
    }

    test("panel updates status, highlights a row and provides conflict removal", () => {
        const a = solver.addLine(0, 0, 10, 0);
        panel.update(solver.solve(true), true);
        expect(host.textContent).toContain("Under-constrained: 4");
        const first = solver.addConstraint({
            kind: ConstraintKind.P2PDistance,
            refs: lineRefs(a),
            datum: 10,
        });
        solver.addConstraint({ kind: ConstraintKind.P2PDistance, refs: lineRefs(a), datum: 20 });
        panel.update(solver.solve(true), true);
        expect(host.textContent).toContain("Over-constrained");
        expect(host.textContent).toContain("incompatible set");
        button("#1 Distance").click();
        expect(host.textContent).not.toMatch(/#\d{4,}/);
        expect(select).toHaveBeenCalledWith(first);
        button("Remove").click();
        expect(remove).toHaveBeenCalledWith([first]);
    });

    test("dimensions are reviewed, deselected, then committed only on explicit apply", () => {
        solver.addLine(0, 0, 10, 0);
        solver.addCircle(20, 20, 3);
        const before = solver.toData();
        panel.showDimensionReview();
        expect(solver.toData()).toEqual(before);
        const choices = host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
        expect(choices).toHaveLength(2);
        choices[1].checked = false;
        button("Apply selected dimensions").click();
        expect(commit).toHaveBeenCalledTimes(1);
        expect(solver.toData().constraints.map((c) => c.kind)).toEqual([ConstraintKind.P2PDistance]);
    });

    test("associative offset row exposes expression and deletion", () => {
        const source = solver.addCircle(0, 0, 10);
        const target = solver.addCircle(0, 0, 12);
        const relation = solver.addConstraint({
            kind: ConstraintKind.Offset,
            refs: [source, target].map((entityId) => ({ entityId, pointIndex: 0 })),
            datum: 2,
        });
        panel.update(solver.solve(true), true);
        expect(host.textContent).toContain("Associative offset");
        button("Associative offset").click();
        expect(select).toHaveBeenCalledWith(relation);
        expect(button("Edit")).not.toBeNull();
        button("Remove").click();
        expect(remove).toHaveBeenCalledWith([relation]);
    });

    test("block appears in properties and structural arc equations cannot be removed there", () => {
        const arc = solver.addArc(0, 0, 5, 0, 0, 5);
        solver.addConstraint({ kind: ConstraintKind.Block, refs: [centerRef(arc)] });
        panel.update(solver.solve(true), true);
        expect(host.textContent).toContain("Fully constrained");
        expect(host.textContent).toContain("Block");
        expect(host.textContent).not.toContain("Point on arc");
        panel.dispose();
        expect(host.children).toHaveLength(0);
    });
});
