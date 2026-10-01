// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    documentLengthUnit,
    formatLengthParameter,
    I18n,
    lengthParameterFromInput,
    type ParameterValue,
    PubSub,
} from "@spicy3d/core";
import { type PreparedCornerSetbackEdit, prepareCornerSetbackEdit } from "../cornerSetbackEdit";
import type { FilletFeatureData } from "../features/feature";
import type { ParametricBodyNode } from "../parametricBodyNode";
import { previewMeshes } from "./featureEditPreview";
import style from "./radiusLawEditor.module.css";

/** An explicit worker preview; the body and history stay unchanged until successful confirmation. */
export function showCornerSetbackEditor(
    body: ParametricBodyNode,
    original: FilletFeatureData,
    signal?: AbortSignal,
): Promise<boolean> {
    const unit = documentLengthUnit(body.document);
    const content = document.createElement("div");
    content.className = style.editor;
    const help = document.createElement("p");
    help.textContent = I18n.translate("fillet.cornerHelp");
    const error = document.createElement("p");
    error.className = style.error;
    error.setAttribute("role", "status");
    const fields: HTMLInputElement[] = [];
    const values: ParameterValue[] = [
        original.radius,
        ...(original.cornerSetbacks?.[0]?.distances ?? [
            typeof original.radius === "number" ? original.radius * 1.25 : `(${original.radius}) * 1.25`,
            typeof original.radius === "number" ? original.radius * 1.25 : `(${original.radius}) * 1.25`,
            typeof original.radius === "number" ? original.radius * 1.25 : `(${original.radius}) * 1.25`,
        ]),
    ];
    const form = document.createElement("div");
    values.forEach((value, index) => {
        const label = document.createElement("label");
        label.textContent = `${I18n.translate(index === 0 ? "fillet.lawRadius" : "fillet.cornerSetback")} ${index || ""} (${unit})`;
        const field = document.createElement("input");
        field.type = "text";
        field.value = formatLengthParameter(value, unit);
        field.setAttribute("data-role", index === 0 ? "radius" : `setback-${index}`);
        label.append(field);
        form.append(label);
        fields.push(field);
    });
    const recompute = document.createElement("button");
    recompute.type = "button";
    recompute.textContent = I18n.translate("fillet.cornerRecompute");
    const cancelSolve = document.createElement("button");
    cancelSolve.type = "button";
    cancelSolve.textContent = I18n.translate("fillet.cornerCancelSolve");
    cancelSolve.disabled = true;
    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.textContent = I18n.translate("common.confirm");
    confirm.disabled = true;
    content.append(help, form, error, recompute, cancelSolve, confirm);

    let prepared: PreparedCornerSetbackEdit | undefined;
    let controller: AbortController | undefined;
    let previewId: number | undefined;
    let closed = false;
    let busy = false;
    let inFlight: Promise<void> | undefined;
    let resolve!: (success: boolean) => void;
    const result = new Promise<boolean>((done) => {
        resolve = done;
    });
    const clearPreview = () => {
        if (previewId !== undefined) body.document.visual.context.removeMesh(previewId);
        previewId = undefined;
        body.document.visual.context.setVisible(body, true);
        body.document.visual.update();
    };
    const discard = () => {
        prepared?.dispose();
        prepared = undefined;
        clearPreview();
        confirm.disabled = true;
    };
    const close = (success: boolean) => {
        if (closed) return;
        closed = true;
        controller?.abort();
        discard();
        signal?.removeEventListener("abort", abort);
        content.closest("dialog")?.remove();
        if (inFlight)
            void inFlight.then(
                () => resolve(success),
                () => resolve(success),
            );
        else resolve(success);
    };
    const abort = () => close(false);
    const state = (working: boolean) => {
        busy = working;
        recompute.disabled = working;
        cancelSolve.disabled = !working;
        for (const field of fields) field.disabled = working;
        confirm.disabled = working || prepared === undefined;
    };
    fields.forEach((field) => {
        field.oninput = () => {
            discard();
            error.textContent = "";
        };
    });
    cancelSolve.onclick = () => controller?.abort();
    const recomputeWork = async () => {
        if (busy || closed) return;
        discard();
        controller = new AbortController();
        state(true);
        error.textContent = I18n.translate("fillet.cornerWorking");
        const scope = body.document.variables.evaluate().scope;
        const read = (index: number) => lengthParameterFromInput(fields[index].value, unit, scope);
        const feature: FilletFeatureData = {
            ...original,
            radius: read(0),
            cornerSetbacks: [
                {
                    edges: [...original.edges] as [
                        (typeof original.edges)[number],
                        (typeof original.edges)[number],
                        (typeof original.edges)[number],
                    ],
                    distances: [read(1), read(2), read(3)],
                },
            ],
        };
        try {
            const answer = await prepareCornerSetbackEdit(body, feature, {
                signal: controller.signal,
                allowActiveCommand: true,
            });
            if (closed) {
                if (answer.isOk) answer.value.dispose();
                return;
            }
            if (!answer.isOk) error.textContent = answer.error;
            else {
                prepared = answer.value;
                const meshes = previewMeshes(body, prepared.previewShape.clone());
                if (meshes) {
                    previewId = body.document.visual.context.displayMesh(meshes, { meshOpacity: 1 });
                    body.document.visual.context.setVisible(body, false);
                    body.document.visual.update();
                }
                error.textContent = I18n.translate("fillet.cornerReady");
            }
        } catch (failure) {
            discard();
            error.textContent = failure instanceof Error ? failure.message : String(failure);
        } finally {
            if (!closed) state(false);
        }
    };
    const confirmWork = async () => {
        if (busy || closed || !prepared) return;
        controller = new AbortController();
        state(true);
        const candidate = prepared;
        prepared = undefined;
        try {
            const answer = await candidate.commit({ signal: controller.signal, allowActiveCommand: true });
            if (closed) return;
            if (answer.isOk) close(true);
            else {
                discard();
                error.textContent = answer.error;
                state(false);
            }
        } catch (failure) {
            candidate.dispose();
            if (!closed) {
                discard();
                error.textContent = failure instanceof Error ? failure.message : String(failure);
                state(false);
            }
        }
    };
    const run = (action: () => Promise<void>): Promise<void> => {
        const pending = action();
        inFlight = pending;
        void pending.then(
            () => {
                if (inFlight === pending) inFlight = undefined;
            },
            () => {
                if (inFlight === pending) inFlight = undefined;
            },
        );
        return pending;
    };
    recompute.onclick = () => run(recomputeWork);
    confirm.onclick = () => run(confirmWork);
    PubSub.default.pub("showDialog", "dialog.title.cornerSetback", content, [
        {
            content: "common.cancel",
            onclick: () => close(false),
        },
    ]);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) close(false);
    return result;
}
