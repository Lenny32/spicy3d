// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { I18n, type I18nKeys, type MergeConflict, type ResolutionChoice, type Result } from "@spicy3d/core";
import { button, div, h2, h3, li, span, ul } from "@spicy3d/element";
import type { ConflictResolution, ConflictRow, FinishError } from "./conflictResolution";
import style from "./conflicts.module.css";
import {
    CHOICE_LABELS,
    conflictDescription,
    formatConflictValue,
    MergeNames,
    oursLabel,
    theirsLabel,
    theirsName,
} from "./conflictText";
import { groupConflicts } from "./resolutions";

export interface ConflictPanelOptions {
    resolution: ConflictResolution;
    /** The × button, and a finished or vanished conflict. */
    onClose: () => void;
    /** "Save mine as a copy" (the other version stays the head). */
    saveCopy: () => Promise<Result<unknown, { kind: string }>>;
    /** "Open latest" (this device's changes dropped). */
    openLatest: () => Promise<void>;
}

/**
 * The conflict side panel (CLOUD-13), next to the viewport and non-modal: the conflicts grouped by
 * body / node, each with what it is about, this device's and the other side's value (the base on
 * hover) and its choices — Keep this / Take other / Keep both where the conflict offers it;
 * rebuild failures with "Open failing feature" and Accept. Selecting a row shows the object
 * (highlight, timeline, sketch entity). Bulk "Keep all mine" / "Take all from <other>", a live
 * preview of the merge, "Save mine as a copy", "Open latest", "Export merge report", and Finish
 * (re-validated first) which pushes the merge.
 *
 * Rendering only reads the resolution's state; every change comes from a click, and the
 * resolution's `onChanged` renders again — a render never loads or changes anything.
 */
export class ConflictPanel extends HTMLElement {
    private selected?: string;
    private busy = false;
    private error?: string;

    constructor(readonly options: ConflictPanelOptions) {
        super();
        this.className = style.panel;
        this.setAttribute("role", "complementary");
        this.setAttribute("aria-label", I18n.translate("cloud.merge.title"));
        options.resolution.onChanged = () => this.onResolutionChanged();
        this.render();
    }

    get resolution(): ConflictResolution {
        return this.options.resolution;
    }

    private onResolutionChanged() {
        if (this.resolution.isResolvedElsewhere) {
            this.options.onClose();
            return;
        }
        this.render();
    }

    // ---- Rendering ---------------------------------------------------------------------------

    render(): void {
        const resolution = this.resolution;
        const names = new MergeNames(resolution.result);
        const rows = resolution.rows;
        const sides = resolution.sides;
        const children: HTMLElement[] = [
            div(
                { className: style.header },
                h2({ textContent: I18n.translate("cloud.merge.title") }),
                button({
                    type: "button",
                    className: style.close,
                    textContent: "×",
                    title: I18n.translate("common.close"),
                    onclick: () => this.options.onClose(),
                }),
            ),
            div({ className: style.documentName, textContent: resolution.document.name }),
            div(
                { className: style.sides },
                span({ textContent: I18n.translate("cloud.merge.mine") }),
                span({ textContent: oursLabel(sides.ours) }),
                span({ textContent: I18n.translate("cloud.merge.theirs") }),
                span({ textContent: theirsLabel(sides.theirs) }),
            ),
        ];
        if (resolution.undone) {
            children.push(
                div({
                    className: style.message,
                    textContent: I18n.translate("cloud.merge.undoneMessage{0}", theirsName(sides.theirs)),
                }),
            );
        }
        if (resolution.notes.length > 0) {
            const notes = ul(
                { className: style.notes },
                ...resolution.notes.map((n) => li({ textContent: n })),
            );
            notes.dataset["notes"] = "";
            children.push(notes);
        }
        children.push(this.toolbar(rows), this.list(rows, names), this.footer(rows));
        this.replaceChildren(...children);
    }

    private action(
        label: I18nKeys,
        run: () => unknown,
        options: { args?: unknown[]; primary?: boolean } = {},
    ) {
        const element = button({
            type: "button",
            textContent: I18n.translate(label, ...(options.args ?? [])),
            disabled: this.busy,
            onclick: () => void run(),
        });
        if (options.primary) element.classList.add(style.primary);
        element.dataset["action"] = label.slice(label.lastIndexOf(".") + 1).replace(/\{\d\}/g, "");
        return element;
    }

    private toolbar(rows: ConflictRow[]): HTMLElement {
        const resolution = this.resolution;
        const hasChoices = rows.some((r) => !r.rebuild);
        const previewing = resolution.previewDocument !== undefined;
        const preview = this.action(previewing ? "cloud.merge.hidePreview" : "cloud.merge.showPreview", () =>
            previewing ? resolution.closePreview() : resolution.showPreview(),
        );
        preview.setAttribute("aria-pressed", String(previewing));
        return div(
            { className: style.toolbar },
            ...(hasChoices
                ? [
                      this.action("cloud.merge.keepAllMine", () => resolution.chooseAll("ours")),
                      this.action("cloud.merge.takeAllTheirs{0}", () => resolution.chooseAll("theirs"), {
                          args: [theirsName(resolution.sides.theirs)],
                      }),
                  ]
                : []),
            preview,
        );
    }

    private list(rows: ConflictRow[], names: MergeNames): HTMLElement {
        const list = div({ className: style.list });
        list.dataset["list"] = "";
        if (rows.length === 0) {
            list.append(
                div({ className: style.empty, textContent: I18n.translate("cloud.merge.nothingLeft") }),
            );
            return list;
        }
        for (const group of groupConflicts(rows)) {
            const title =
                group.nodeId === undefined
                    ? I18n.translate("cloud.merge.documentGroup")
                    : names.node(group.nodeId);
            const nodeId = group.nodeId;
            const header = button({
                type: "button",
                className: style.groupButton,
                textContent: title,
                onclick: () => {
                    if (nodeId !== undefined) this.resolution.reveal({ path: `node/${nodeId}` });
                },
            });
            const element = div(
                { className: style.group },
                h3({}, header),
                ...group.rows.map((row) => this.row(row, names)),
            );
            element.dataset["group"] = group.nodeId ?? "document";
            list.append(element);
        }
        return list;
    }

    private row(row: ConflictRow, names: MergeNames): HTMLElement {
        const { conflict } = row;
        const description = button({
            type: "button",
            className: style.description,
            textContent: conflictDescription(conflict),
            onclick: () => {
                this.selected = conflict.path;
                this.resolution.reveal(conflict);
                this.render();
            },
        });
        const element = div({ className: style.row }, description);
        element.dataset["path"] = conflict.path;
        element.dataset["kind"] = conflict.kind;
        element.toggleAttribute("data-resolved", row.choice !== undefined);
        element.toggleAttribute("data-selected", this.selected === conflict.path);
        if (row.rebuild) {
            element.append(
                div(
                    { className: style.actions },
                    this.action("cloud.merge.openFailing", () => this.resolution.openFailing(conflict)),
                    this.choiceButton(conflict, "accept", row.choice, "cloud.merge.choice.acceptFailure"),
                ),
            );
            return element;
        }
        if (this.hasSides(conflict)) element.append(this.values(conflict, names));
        element.append(
            div(
                { className: style.choices },
                ...conflict.choices.map((choice) => this.choiceButton(conflict, choice, row.choice)),
            ),
        );
        return element;
    }

    private hasSides(conflict: MergeConflict): boolean {
        return conflict.kind !== "order" && (conflict.ours !== undefined || conflict.theirs !== undefined);
    }

    /** This device's and the other side's value; the base shows on hover. */
    private values(conflict: MergeConflict, names: MergeNames): HTMLElement {
        const base = I18n.translate(
            "cloud.merge.base{0}",
            formatConflictValue(conflict, conflict.base, names),
        );
        const value = (text: string) => span({ textContent: text, title: base });
        const values = div(
            { className: style.values, title: base },
            span({ textContent: I18n.translate("cloud.merge.mine") }),
            value(formatConflictValue(conflict, conflict.ours, names)),
            span({ textContent: theirsName(this.resolution.sides.theirs) }),
            value(formatConflictValue(conflict, conflict.theirs, names)),
        );
        values.dataset["values"] = "";
        return values;
    }

    private choiceButton(
        conflict: MergeConflict,
        choice: ResolutionChoice,
        chosen: ResolutionChoice | undefined,
        label: I18nKeys = CHOICE_LABELS[choice],
    ): HTMLElement {
        const element = button({
            type: "button",
            textContent: I18n.translate(label, theirsName(this.resolution.sides.theirs)),
            disabled: this.busy,
            onclick: () => {
                this.selected = conflict.path;
                this.resolution.choose(conflict.path, choice);
            },
        });
        element.dataset["choice"] = choice;
        element.setAttribute("aria-pressed", String(chosen === choice));
        return element;
    }

    private footer(rows: ConflictRow[]): HTMLElement {
        const resolution = this.resolution;
        const open = rows.filter((r) => r.choice === undefined).length;
        const validation = resolution.validation;
        const status = div({
            className: style.status,
            textContent:
                this.error ??
                (validation === "running"
                    ? I18n.translate("cloud.merge.validating")
                    : open > 0
                      ? I18n.translate("cloud.merge.open{0}{1}", open, rows.length)
                      : I18n.translate(
                            validation === "done" || validation === "failed"
                                ? "cloud.merge.ready"
                                : "cloud.merge.readyToValidate",
                        )),
        });
        status.setAttribute("role", "status");
        status.toggleAttribute("data-error", this.error !== undefined);
        const finish = this.action(
            resolution.undone && rows.length === 0 ? "cloud.merge.mergeAgain" : "cloud.merge.finish",
            () => this.finish(),
            { primary: true },
        );
        (finish as HTMLButtonElement).disabled =
            this.busy || validation === "running" || rows.some((r) => !r.rebuild && r.choice === undefined);
        return div(
            { className: style.footer },
            status,
            div(
                { className: style.actions },
                finish,
                this.action("cloud.merge.revalidate", () => this.revalidate()),
            ),
            div(
                { className: style.actions },
                this.action("cloud.conflict.saveCopy", () => this.run(() => this.options.saveCopy())),
                this.action("cloud.conflict.openLatest", () =>
                    this.run(async () => this.options.openLatest()),
                ),
                this.action("cloud.merge.exportReport", () => resolution.exportReport()),
            ),
        );
    }

    // ---- Actions -----------------------------------------------------------------------------

    private async run(action: () => Promise<unknown>) {
        this.busy = true;
        this.error = undefined;
        this.render();
        try {
            const result = (await action()) as Result<unknown, { kind: string }> | undefined;
            if (result && typeof result === "object" && "isOk" in result && !result.isOk) {
                this.error = I18n.translate("cloud.merge.failed{0}", result.error.kind);
            }
        } finally {
            this.busy = false;
            if (!this.resolution.isDisposed) this.render();
        }
    }

    /** "Re-validate": merged again with the document as it is now (a fixed feature), then rebuilt. */
    async revalidate(): Promise<void> {
        this.error = undefined;
        const remerged = this.resolution.remergeFromDocument();
        if (!remerged.isOk) {
            this.error = I18n.translate("cloud.merge.failed{0}", remerged.error.message);
            this.render();
            return;
        }
        await this.resolution.validate();
    }

    /** "Finish": pushes the merge, or says what is still to answer. */
    async finish(): Promise<void> {
        this.busy = true;
        this.error = undefined;
        this.render();
        let finished: Result<void, FinishError>;
        try {
            finished = await this.resolution.finish();
        } finally {
            this.busy = false;
        }
        if (finished.isOk) {
            this.options.onClose();
            return;
        }
        this.error = finishMessage(finished.error);
        if (!this.resolution.isDisposed) this.render();
    }
}

function finishMessage(error: FinishError): string {
    switch (error.kind) {
        case "unresolved":
            return I18n.translate("cloud.merge.stillOpen{0}", error.count);
        case "rebuild":
            return I18n.translate("cloud.merge.acceptFailures{0}", error.count);
        case "changed":
            return I18n.translate("cloud.merge.changed");
        case "failed":
            return I18n.translate("cloud.merge.failed{0}", error.message);
    }
}

customElements.define("spicy-cloud-conflicts", ConflictPanel);
