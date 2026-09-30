// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { I18n, PubSub } from "@spicy3d/core";
import type { SketchEditor } from "./sketchEditor";

/** Settings commit only after the solver validates the entire layout; Cancel touches nothing. */
export function promptControlBSpline(editor: SketchEditor, id: number): void {
    const entity = editor.solver.entity(id);
    if (!entity?.control) return;
    const content = document.createElement("div");
    const fields = ["degree", "knots", "multiplicities", "weights"] as const;
    const initial = [
        String(entity.control.degree),
        entity.control.knots.join(", "),
        entity.control.multiplicities.join(", "),
        (entity.control.weights ?? Array(entity.params.length / 2).fill(1)).join(", "),
    ];
    const inputs = fields.map((field, i) => {
        const row = document.createElement("label");
        row.textContent = I18n.translate(`sketch.controlBSpline.${field}`);
        const input = document.createElement("input");
        input.name = field;
        input.value = initial[i];
        row.append(input);
        content.append(row);
        return input;
    });
    const hint = document.createElement("p");
    hint.textContent = I18n.translate("sketch.controlBSpline.help");
    const error = document.createElement("p");
    error.style.color = "red";
    content.append(hint, error);
    PubSub.default.pub("showDialog", "dialog.title.controlBSpline", content, [
        {
            content: "common.confirm",
            onclick: () => {},
            shouldClose: () => {
                const numbers = (input: HTMLInputElement) =>
                    input.value
                        .split(/[\s,]+/)
                        .filter(Boolean)
                        .map(Number);
                const result = editor.solver.setControlBSpline(id, {
                    degree: Number(inputs[0].value),
                    knots: numbers(inputs[1]),
                    multiplicities: numbers(inputs[2]),
                    weights: numbers(inputs[3]),
                });
                if (!result.isOk) {
                    error.textContent = result.error;
                    return false;
                }
                editor.solve(true);
                editor.commit();
                return true;
            },
        },
        { content: "common.cancel", onclick: () => {} },
    ]);
}
