// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { documentLengthUnit, PubSub } from "@spicy3d/core";
import { ConstraintKind, isStructuralConstraint } from "../sketchModel";
import type { SolveOutcome } from "../solver";
import { analyzeConstraints, applyDimensions, suggestDimensions } from "./constraintAnalyzer";
import { formatDatum } from "./dimensionLayout";
import type { SketchEditor } from "./sketchEditor";
import style from "./solverFeedback.module.css";

/** Session-owned properties and diagnostics panel. Analysis runs after fine solves only. */
export class SolverFeedback {
    readonly element = document.createElement("section");
    private readonly status = document.createElement("p");
    private readonly details = document.createElement("div");
    private readonly review = document.createElement("div");

    constructor(
        private readonly editor: SketchEditor,
        host: HTMLElement,
    ) {
        this.element.className = style.panel;
        this.element.setAttribute("aria-label", "Sketch constraints and solver feedback");
        this.status.setAttribute("role", "status");
        this.element.append(this.status, this.details, this.review);
        for (const event of ["pointerdown", "pointermove", "pointerup", "wheel", "dblclick", "keydown"]) {
            this.element.addEventListener(event, (e) => e.stopPropagation());
        }
        host.append(this.element);
    }

    update(outcome: SolveOutcome, fine: boolean): void {
        this.status.textContent = !outcome.result.startsWith("Ok")
            ? outcome.result === "Conflicting"
                ? "Over-constrained: conflicting relationships"
                : "Solver did not converge"
            : outcome.dofs === 0
              ? "Fully constrained"
              : `⚠ Under-constrained: ${outcome.dofs} degrees of freedom`;
        if (!fine) return;
        this.review.replaceChildren();
        this.details.replaceChildren();
        const diagnosis = this.editor.solver.diagnose();
        for (const [id, error] of this.editor.solver.datumErrors) this.text(`Constraint #${id}: ${error}`);
        const issues = new Set([...diagnosis.conflicting, ...diagnosis.redundant]);
        this.editor.annotations.setDiagnosticConstraints(issues);
        if (diagnosis.redundant.length && outcome.result.startsWith("Ok")) {
            this.status.textContent = `Over-constrained: redundant relationships (${outcome.dofs} degrees of freedom)`;
        }
        const data = this.editor.solver.toData();
        const analysis = analyzeConstraints(data);
        if (outcome.dofs > 0) {
            this.text(
                analysis.freeMotions.length
                    ? `Free motions: ${analysis.freeMotions.join(", ")}. Other size or position freedoms may remain.`
                    : "Remaining freedom is coupled to the geometry; the solver does not identify individual motion modes.",
            );
            this.text("Suggestions: locate a point, orient a line, then dimension remaining sizes.");
        }
        if (diagnosis.conflicting.length) {
            this.text(
                `The solver reports an incompatible set: ${diagnosis.conflicting.map((id) => `#${id}`).join(", ")}. Select a row to inspect its geometry; edit or remove a relationship. This is a set, not a proven pairwise conflict.`,
            );
        }
        if (diagnosis.redundant.length) {
            this.text(
                "Redundant relationships are already implied by other constraints. Remove one, then recheck.",
            );
            const removable = diagnosis.redundant.find((id) => {
                const constraint = data.constraints.find((c) => c.id === id);
                return constraint !== undefined && !isStructuralConstraint(constraint, data.entities);
            });
            if (removable !== undefined)
                this.button(this.details, "Remove one redundant constraint", () =>
                    this.editor.deleteConstraints([removable]),
                );
        }
        const constraints = data.constraints.filter((c) => !isStructuralConstraint(c, data.entities));
        const list = document.createElement("details");
        list.open = issues.size > 0;
        const summary = document.createElement("summary");
        summary.textContent = `Constraints (${constraints.length})`;
        list.append(summary);
        this.details.append(list);
        for (const c of constraints) {
            const row = document.createElement("div");
            if (issues.has(c.id)) row.className = style.issue;
            const suffix = diagnosis.conflicting.includes(c.id)
                ? " — conflict"
                : diagnosis.redundant.includes(c.id)
                  ? " — redundant"
                  : "";
            this.button(
                row,
                `#${c.id} ${constraintLabel(c.kind)}${c.datum === undefined ? "" : ` = ${formatDatum(c.kind, c.datum, documentLengthUnit(this.editor.document))}`}${suffix}`,
                () => this.editor.annotations.selectConstraint(c.id),
            );
            if (c.datum !== undefined || c.kind === ConstraintKind.Fix)
                this.button(row, "Edit", () => this.editor.editDatum(c.id));
            this.button(row, "Remove", () => this.editor.deleteConstraints([c.id]));
            list.append(row);
        }
        const construction = data.entities.filter((e) => e.construction);
        for (const entity of construction) {
            this.button(this.details, `Construction #${entity.id}: use as profile geometry`, () => {
                this.editor.solver.setConstruction(entity.id, false);
                this.editor.solve(true);
                this.editor.commit();
            });
        }
        for (const id of analysis.unusedConstruction) {
            this.text(`Construction #${id} does not constrain another entity.`);
            this.button(this.details, `Remove unused construction #${id}`, () =>
                this.editor.deleteEntities([id]),
            );
        }
        this.button(this.details, "Review missing dimensions", () => this.showDimensionReview());
    }

    showDimensionReview(): void {
        this.review.replaceChildren();
        const suggestions = suggestDimensions(this.editor.solver, documentLengthUnit(this.editor.document));
        const title = document.createElement("p");
        title.textContent = suggestions.length
            ? "Review dimensions before applying:"
            : "No independent size dimensions found. Resolve solver issues first, or add position/orientation constraints.";
        this.review.append(title);
        const choices = suggestions.map((suggestion) => {
            const label = document.createElement("label");
            const input = document.createElement("input");
            input.type = "checkbox";
            input.checked = true;
            label.append(input, suggestion.label);
            this.review.append(label);
            return input;
        });
        if (suggestions.length)
            this.button(this.review, "Apply selected dimensions", () => {
                const selected = suggestions.filter((_, i) => choices[i].checked);
                if (selected.length === 0) return;
                if (!applyDimensions(this.editor.solver, selected)) {
                    PubSub.default.pub(
                        "displayError",
                        "The sketch changed or these dimensions conflict. Review suggestions again.",
                    );
                    return;
                }
                this.editor.solve(true);
                this.editor.commit();
            });
        this.button(this.review, "Cancel review", () => this.review.replaceChildren());
    }

    private text(value: string): void {
        const p = document.createElement("p");
        p.textContent = value;
        this.details.append(p);
    }

    private button(parent: HTMLElement, label: string, action: () => void): void {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = label;
        button.onclick = action;
        parent.append(button);
    }

    dispose(): void {
        this.element.remove();
    }
}

function constraintLabel(kind: ConstraintKind): string {
    const labels: Record<ConstraintKind, string> = {
        [ConstraintKind.P2PCoincident]: "Coincident",
        [ConstraintKind.P2PDistance]: "Distance",
        [ConstraintKind.Equal]: "Equal",
        [ConstraintKind.PointOnLine]: "Point on line",
        [ConstraintKind.Horizontal]: "Horizontal",
        [ConstraintKind.Vertical]: "Vertical",
        [ConstraintKind.Parallel]: "Parallel",
        [ConstraintKind.Perpendicular]: "Perpendicular",
        [ConstraintKind.P2LDistance]: "Point-to-line distance",
        [ConstraintKind.Angle]: "Angle (degrees)",
        [ConstraintKind.Radius]: "Radius",
        [ConstraintKind.EqualLength]: "Equal length",
        [ConstraintKind.EqualRadius]: "Equal radius",
        [ConstraintKind.PointOnCircle]: "Point on circle",
        [ConstraintKind.Midpoint]: "Midpoint",
        [ConstraintKind.Symmetric]: "Symmetry",
        [ConstraintKind.TangentLineCircle]: "Tangent",
        [ConstraintKind.TangentCircleCircle]: "Tangent",
        [ConstraintKind.HorizontalDistance]: "Horizontal distance",
        [ConstraintKind.VerticalDistance]: "Vertical distance",
        [ConstraintKind.HorizontalAlign]: "Horizontal alignment",
        [ConstraintKind.VerticalAlign]: "Vertical alignment",
        [ConstraintKind.Fix]: "Fix point",
        [ConstraintKind.PointOnArc]: "Point on arc",
        [ConstraintKind.EqualArcRadius]: "Equal radius",
        [ConstraintKind.TangentLineArc]: "Tangent",
        [ConstraintKind.TangentArcArc]: "Tangent",
        [ConstraintKind.TangentCircleArc]: "Tangent",
        [ConstraintKind.Collinear]: "Collinear",
        [ConstraintKind.Block]: "Block",
        [ConstraintKind.EqualAngle]: "Equal angles",
        [ConstraintKind.Scale]: "Length ratio",
    };
    return labels[kind];
}
