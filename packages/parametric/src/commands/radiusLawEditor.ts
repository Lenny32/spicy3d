// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    documentLengthUnit,
    formatLengthParameter,
    I18n,
    type IDocument,
    lengthParameterFromInput,
    MAX_FILLET_RADIUS_SAMPLES,
    type ParameterValue,
    PubSub,
} from "@spicy3d/core";
import { type FilletRadiusPoint, resolveFilletRadiusLaw } from "../features/radiusLaw";
import style from "./radiusLawEditor.module.css";

/** Edits a draft only; confirming the owning fillet command remains the document's undo step. */
export function showRadiusLawEditor(
    cadDocument: IDocument,
    initial: readonly FilletRadiusPoint[],
    onAccept: (law: FilletRadiusPoint[]) => void,
): void {
    const unit = documentLengthUnit(cadDocument);
    let points = initial.map((point) => ({ ...point }));
    const content = document.createElement("div");
    content.className = style.editor;
    const help = document.createElement("p");
    help.textContent = I18n.translate("fillet.lawHelp");
    const table = document.createElement("table");
    const head = table.createTHead().insertRow();
    for (const text of [
        I18n.translate("fillet.lawPosition"),
        `${I18n.translate("fillet.lawRadius")} (${unit})`,
        "",
    ]) {
        const cell = document.createElement("th");
        cell.textContent = text;
        head.append(cell);
    }
    const body = table.createTBody();
    const error = document.createElement("p");
    error.className = style.error;
    error.setAttribute("role", "alert");
    const add = document.createElement("button");
    add.type = "button";
    add.textContent = I18n.translate("fillet.addSample");
    let rows: { position: HTMLInputElement; radius: HTMLInputElement }[] = [];
    const readDraft = (): FilletRadiusPoint[] => {
        const scope = cadDocument.variables.evaluate().scope;
        return rows.map((row) => ({
            position: Number(row.position.value) / 100,
            radius: lengthParameterFromInput(row.radius.value, unit, scope),
        }));
    };
    const read = (): FilletRadiusPoint[] | undefined => {
        const scope = cadDocument.variables.evaluate().scope;
        const law = readDraft();
        const result = resolveFilletRadiusLaw(law, scope);
        error.textContent = result.isOk ? "" : result.error;
        return result.isOk ? law : undefined;
    };
    const render = () => {
        body.replaceChildren();
        rows = points.map((point, index) => {
            const row = body.insertRow();
            const position = document.createElement("input");
            position.type = "number";
            position.min = "0";
            position.max = "100";
            position.step = "any";
            position.value = String(point.position * 100);
            position.disabled = index === 0 || index === points.length - 1;
            position.setAttribute("data-role", "position");
            position.setAttribute("aria-label", `${I18n.translate("fillet.lawPosition")} ${index + 1}`);
            const radius = document.createElement("input");
            radius.type = "text";
            radius.value = formatLengthParameter(point.radius, unit);
            radius.setAttribute("data-role", "radius");
            radius.setAttribute("aria-label", `${I18n.translate("fillet.lawRadius")} ${index + 1} (${unit})`);
            const remove = document.createElement("button");
            remove.type = "button";
            remove.textContent = I18n.translate("common.delete");
            remove.disabled = position.disabled;
            remove.onclick = () => {
                points = readDraft().filter((_, i) => i !== index);
                error.textContent = "";
                render();
            };
            row.insertCell().append(position);
            row.insertCell().append(radius);
            row.insertCell().append(remove);
            return { position, radius };
        });
        add.disabled = points.length >= MAX_FILLET_RADIUS_SAMPLES;
    };
    add.onclick = () => {
        const law = read();
        if (!law || law.length >= MAX_FILLET_RADIUS_SAMPLES) return;
        let gap = 0;
        for (let index = 1; index < law.length - 1; index++) {
            if (law[index + 1].position - law[index].position > law[gap + 1].position - law[gap].position)
                gap = index;
        }
        const scope = cadDocument.variables.evaluate().scope;
        const resolved = resolveFilletRadiusLaw(law, scope);
        if (!resolved.isOk) return;
        const radius: ParameterValue = (resolved.value[gap].radius + resolved.value[gap + 1].radius) / 2;
        points = [
            ...law.slice(0, gap + 1),
            { position: (law[gap].position + law[gap + 1].position) / 2, radius },
            ...law.slice(gap + 1),
        ];
        render();
    };
    render();
    content.append(help, table, add, error);
    let accepted: FilletRadiusPoint[] | undefined;
    PubSub.default.pub("showDialog", "fillet.radiusLaw", content, [
        {
            content: "common.confirm",
            shouldClose: () => {
                accepted = read();
                return accepted !== undefined;
            },
            onclick: () => {
                if (accepted) onAccept(accepted);
            },
        },
        { content: "common.cancel" },
    ]);
}
