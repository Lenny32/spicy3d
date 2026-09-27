// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { formatLength, type LengthUnit } from "@spicy3d/core";
import { ConstraintKind, entityRadius, type SketchConstraintData, type SketchData } from "../sketchModel";
import type { SketchSolver } from "../solver";
import { centerRef, lineRefs } from "../solverEntities";

export interface DimensionSuggestion {
    label: string;
    constraint: Omit<SketchConstraintData, "id">;
}

/**
 * Structural analysis; no numerical solves on the pointer-move path. Suggestion labels read
 * their lengths in `unit`; the suggested datums stay in millimetres.
 */
export function analyzeConstraints(data: SketchData, unit: LengthUnit = "mm") {
    const related = new Set<number>();
    const blocked = new Set<number>();
    for (const c of data.constraints) {
        const ids = new Set(c.refs.map((r) => r.entityId));
        if (ids.size > 1) for (const id of ids) related.add(id);
        if (c.kind === ConstraintKind.Block) blocked.add(c.refs[0].entityId);
    }
    // Track shared size families before numerical trials: native rank diagnostics can
    // miss equal-length dependencies at symmetric initial configurations.
    const parent = new Map(data.entities.map((e) => [e.id, e.id]));
    const root = (id: number): number => {
        let current = id;
        while (parent.has(current) && parent.get(current) !== current) current = parent.get(current)!;
        return current;
    };
    for (const c of data.constraints) {
        if (
            ![
                ConstraintKind.EqualLength,
                ConstraintKind.Scale,
                ConstraintKind.EqualRadius,
                ConstraintKind.EqualArcRadius,
            ].includes(c.kind)
        )
            continue;
        const ids = [...new Set(c.refs.map((r) => r.entityId))];
        for (const id of ids.slice(1)) parent.set(root(id), root(ids[0]));
    }
    const sized = new Set([...blocked].map(root));
    for (const c of data.constraints) {
        if (
            c.kind === ConstraintKind.Radius ||
            (c.kind === ConstraintKind.P2PDistance &&
                c.refs.length === 2 &&
                c.refs[0].entityId === c.refs[1].entityId)
        )
            sized.add(root(c.refs[0].entityId));
    }
    const suggestions: DimensionSuggestion[] = [];
    for (const e of data.entities) {
        if (e.construction || sized.has(root(e.id))) continue;
        if (e.type === "line") {
            const length = Math.hypot(e.params[2] - e.params[0], e.params[3] - e.params[1]);
            if (length > 1e-9)
                suggestions.push({
                    label: `Line #${e.id}: length ${formatLength(length, unit, { suffix: true })}`,
                    constraint: { kind: ConstraintKind.P2PDistance, refs: lineRefs(e.id), datum: length },
                });
        } else if (e.type === "circle" || e.type === "arc") {
            const radius = entityRadius(e);
            if (radius > 1e-9)
                suggestions.push({
                    label: `${e.type === "circle" ? "Circle" : "Arc"} #${e.id}: radius ${formatLength(radius, unit, { suffix: true })}`,
                    constraint: { kind: ConstraintKind.Radius, refs: [centerRef(e.id)], datum: radius },
                });
        }
    }
    // Only claim global rigid motions when all constraints are translation invariant.
    const anchored = data.constraints.some(
        (c) =>
            c.kind === ConstraintKind.Fix ||
            c.kind === ConstraintKind.Block ||
            c.refs.some((r) => r.entityId < 0),
    );
    const oriented = data.constraints.some((c) =>
        [
            ConstraintKind.Horizontal,
            ConstraintKind.Vertical,
            ConstraintKind.HorizontalAlign,
            ConstraintKind.VerticalAlign,
            ConstraintKind.HorizontalDistance,
            ConstraintKind.VerticalDistance,
        ].includes(c.kind),
    );
    const freeMotions = !anchored && data.entities.length > 0 ? ["Translate X", "Translate Y"] : [];
    if (!anchored && !oriented && data.entities.some((e) => e.type === "line" || e.type === "arc")) {
        freeMotions.push("Rotate about sketch normal (Z)");
    }
    return {
        suggestions,
        freeMotions,
        unusedConstruction: data.entities
            .filter((e) => e.construction && !related.has(e.id))
            .map((e) => e.id),
    };
}

/** Review-time trial solves discard dimensions already implied by other relationships. */
export function suggestDimensions(solver: SketchSolver, unit: LengthUnit = "mm"): DimensionSuggestion[] {
    const trial = solver.fork();
    try {
        const initial = trial.diagnose();
        if (
            trial.datumErrors.size ||
            initial.conflicting.length ||
            initial.redundant.length ||
            !trial.solve(true).result.startsWith("Ok")
        )
            return [];
        const accepted: DimensionSuggestion[] = [];
        for (const suggestion of analyzeConstraints(trial.toData(), unit).suggestions) {
            if (
                !analyzeConstraints(trial.toData()).suggestions.some(
                    (s) => s.constraint.refs[0].entityId === suggestion.constraint.refs[0].entityId,
                )
            )
                continue;
            const before = trial.toData();
            const dofs = trial.dofs();
            trial.addConstraint(suggestion.constraint);
            const outcome = trial.solve(true);
            const diagnosis = trial.diagnose();
            if (
                outcome.result.startsWith("Ok") &&
                outcome.dofs < dofs &&
                !diagnosis.conflicting.length &&
                !diagnosis.redundant.length
            ) {
                accepted.push(suggestion);
            } else trial.reset(before);
        }
        return accepted;
    } finally {
        trial.dispose();
    }
}

/** Recheck the reviewed batch against current state; apply all or nothing. */
export function applyDimensions(solver: SketchSolver, suggestions: readonly DimensionSuggestion[]): boolean {
    if (suggestions.length === 0) return false;
    const trial = solver.fork();
    try {
        const dofs = trial.dofs();
        for (const suggestion of suggestions) trial.addConstraint(suggestion.constraint);
        const outcome = trial.solve(true);
        const diagnosis = trial.diagnose();
        if (
            trial.datumErrors.size ||
            !outcome.result.startsWith("Ok") ||
            outcome.dofs >= dofs ||
            diagnosis.conflicting.length ||
            diagnosis.redundant.length
        )
            return false;
        solver.reset(trial.toData());
        return true;
    } finally {
        trial.dispose();
    }
}
