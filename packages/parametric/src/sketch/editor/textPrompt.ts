// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { I18n, PubSub } from "@spicy3d/core";
import type { SketchTextSettings } from "../sketchText";
import { textContours } from "../textGeometry";
import { textFrameMesh, textOutlineMesh } from "../textVisual";
import type { SketchEditor } from "./sketchEditor";
import style from "./textPrompt.module.css";

/** Modal edits are previews until Confirm; closing or cancelling never mutates the solver. */
export function promptSketchText(editor: SketchEditor, initial: SketchTextSettings, id?: number): void {
    const content = document.createElement("div");
    content.className = style.content;
    const fields = new Map<string, HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>();
    const add = (name: string, input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement) => {
        const label = document.createElement("label");
        label.className = style.field;
        label.textContent = I18n.translate(`sketch.text.${name}` as Parameters<typeof I18n.translate>[0]);
        input.name = name;
        label.append(input);
        content.append(label);
        fields.set(name, input);
    };
    const value = document.createElement("textarea");
    value.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && !event.ctrlKey && !event.metaKey) event.stopPropagation();
    });
    value.rows = 4;
    value.value = initial.value;
    add("value", value);
    for (const [name, number] of Object.entries({
        x: initial.x,
        y: initial.y,
        height: initial.height,
        angle: initial.angle,
        width: initial.frame.width,
        frameHeight: initial.frame.height,
        spacing: initial.spacing ?? 0,
    })) {
        const input = document.createElement("input");
        input.type = "number";
        input.step = "any";
        input.value = String(number);
        add(name, input);
    }
    for (const [name, choices, selected] of [
        ["alignment", ["left", "center", "right"], initial.alignment ?? "left"],
        ["verticalAlignment", ["bottom", "middle", "top"], initial.verticalAlignment ?? "bottom"],
    ] as const) {
        const input = document.createElement("select");
        for (const choice of choices) {
            const option = document.createElement("option");
            option.value = choice;
            option.textContent = I18n.translate(
                `sketch.text.${choice}` as Parameters<typeof I18n.translate>[0],
            );
            input.append(option);
        }
        input.value = selected;
        add(name, input);
    }
    for (const name of ["flipHorizontal", "flipVertical"] as const) {
        const input = document.createElement("input");
        input.type = "checkbox";
        input.checked = initial[name] ?? false;
        add(name, input);
    }
    const error = document.createElement("p");
    error.className = style.error;
    content.append(error);
    const read = (): SketchTextSettings => {
        const number = (key: string) => {
            const text = fields.get(key)!.value.trim();
            return text === "" ? Number.NaN : Number(text);
        };
        return {
            ...initial,
            value: value.value,
            x: number("x"),
            y: number("y"),
            height: number("height"),
            angle: number("angle"),
            spacing: number("spacing"),
            frame: { width: number("width"), height: number("frameHeight") },
            alignment: fields.get("alignment")!.value as SketchTextSettings["alignment"],
            verticalAlignment: fields.get("verticalAlignment")!
                .value as SketchTextSettings["verticalAlignment"],
            flipHorizontal: (fields.get("flipHorizontal") as HTMLInputElement).checked,
            flipVertical: (fields.get("flipVertical") as HTMLInputElement).checked,
        };
    };
    const clear = () => {
        if (editor.isActive) editor.annotations.setGeometryPreview([]);
    };
    const preview = () => {
        if (!editor.isActive) return;
        const settings = read(),
            valid = textContours(settings);
        error.textContent = valid.isOk ? "" : I18n.translate(valid.error);
        editor.annotations.setGeometryPreview(
            valid.isOk
                ? [textOutlineMesh(editor.node.plane, settings), textFrameMesh(editor.node.plane, settings)]
                : [],
        );
    };
    content.addEventListener("input", preview);
    preview();
    PubSub.default.pub("showDialog", "command.sketch.text", content, [
        {
            content: "common.confirm",
            onclick: () => {},
            shouldClose: () => {
                if (!editor.isActive) return true;
                const result =
                    id === undefined ? editor.solver.addText(read()) : editor.solver.updateText(id, read());
                if (!result.isOk) {
                    error.textContent = I18n.translate(result.error);
                    return false;
                }
                clear();
                editor.solve(true);
                editor.commit();
                return true;
            },
        },
        { content: "common.cancel", onclick: clear },
    ]);
    queueMicrotask(() => content.closest("dialog")?.addEventListener("close", clear, { once: true }));
}
