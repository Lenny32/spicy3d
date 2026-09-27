// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type DocumentChange,
    formatDateTime,
    I18n,
    type I18nKeys,
    PubSub,
    type Result,
    repositoryErrorMessage,
    setRelativeTime,
    watchRelativeTimes,
} from "@spicy3d/core";
import { button, div, h2, h3, img, li, span, svg, ul } from "@spicy3d/element";
import type { CloudVersion } from "../documents/repository";
import { checkbox, textField } from "../ui/forms";
import { Modal } from "../ui/modal";
import style from "./history.module.css";
import {
    type HistoryRow,
    historyGroups,
    isKept,
    mergedFromDevice,
    type RetentionPolicy,
    retentionOf,
    VERSION_KIND_ICONS,
    VERSION_KIND_LABELS,
    versionTime,
} from "./historyModel";
import { type HistoryFailure, needsNewerApp, type VersionHistory } from "./versionHistory";

/** Versions per request: a screenful and more, well within the server's 1–200. */
export const HISTORY_PAGE_SIZE = 50;
/** "Manual only" hides whole pages of autosaves: read on (at most this many pages) until a row shows. */
const MAX_PAGES_PER_LOAD = 10;
/** Scrolled this close to the end of the list, the next page loads. */
const SCROLL_MARGIN_PX = 200;
/** A label's maximum length (SpicySrv `LabelError`). */
const LABEL_MAX_LENGTH = 200;

export interface HistoryPanelOptions {
    history: VersionHistory;
    /** The server's autosave retention (`config.storage.autosaveRetention`), for the note. */
    retention: RetentionPolicy;
    onClose: () => void;
    pageSize?: number;
}

/**
 * The version history side panel of a cloud document: newest first, grouped by local day,
 * consecutive autosaves folded into "N autosaves", "Manual only", the retention note, and more
 * pages as the list is scrolled. Selecting a version shows its actions (preview, restore, name,
 * pin, save as new document, download, compare). Merges are one row, "merged changes from <device>".
 */
export class VersionHistoryPanel extends HTMLElement {
    private versions: CloudVersion[] = [];
    private nextCursor: string | undefined;
    private complete = false;
    private loading?: Promise<void>;
    private error: string | undefined;
    private manualOnly = false;
    private selected: string | undefined;
    private readonly expanded = new Set<string>();
    private readonly list: HTMLElement;
    private readonly listBody: HTMLElement;
    private readonly footer: HTMLElement;
    private stopWatching?: () => void;
    private generation = 0;

    constructor(readonly options: HistoryPanelOptions) {
        super();
        this.className = style.panel;
        options.history.onChanged = (change) => {
            if (change === "restored") void this.reload();
            else this.render();
        };
        this.setAttribute("role", "complementary");
        this.setAttribute("aria-label", I18n.translate("cloud.history.title"));
        const manualOnly = checkbox("cloud.history.manualOnly");
        manualOnly.root.title = I18n.translate("cloud.history.manualOnlyHint");
        manualOnly.input.dataset["filter"] = "manualOnly";
        manualOnly.input.onchange = () => {
            this.manualOnly = manualOnly.input.checked;
            this.render();
            void this.fillIfNeeded();
        };
        const { keepAllHours, hourlyDays, dailyDays } = retentionOf(options.retention);
        this.listBody = div({});
        this.footer = div({});
        this.list = div(
            { className: style.list, onscroll: () => this.onScroll() },
            this.listBody,
            this.footer,
        );
        this.list.dataset["list"] = "";
        this.append(
            div(
                { className: style.header },
                h2({ textContent: I18n.translate("cloud.history.title") }),
                button({
                    type: "button",
                    className: style.close,
                    textContent: "×",
                    title: I18n.translate("common.close"),
                    onclick: () => this.options.onClose(),
                }),
            ),
            div({ className: style.documentName, textContent: this.history.options.name() }),
            div({ className: style.toolbar }, manualOnly.root),
            div({
                className: style.note,
                textContent: I18n.translate(
                    "cloud.history.retention{0}{1}{2}",
                    keepAllHours,
                    hourlyDays,
                    dailyDays,
                ),
            }),
            this.list,
        );
    }

    get history(): VersionHistory {
        return this.options.history;
    }

    /** The versions loaded so far, newest first. */
    get loaded(): readonly CloudVersion[] {
        return this.versions;
    }

    get hasMore(): boolean {
        return !this.complete;
    }

    connectedCallback(): void {
        this.stopWatching = watchRelativeTimes(this.list);
        if (this.versions.length === 0 && !this.loading) void this.reload();
    }

    disconnectedCallback(): void {
        this.stopWatching?.();
        this.stopWatching = undefined;
    }

    // ---- Loading -----------------------------------------------------------------------------

    /** Starts over from the newest version (after a restore, a label…). */
    reload(): Promise<void> {
        this.generation++;
        this.versions = [];
        this.nextCursor = undefined;
        this.complete = false;
        this.error = undefined;
        this.loading = undefined;
        return this.loadMore();
    }

    /**
     * The next page; with "Manual only", pages on until a new row shows (or the history ends).
     * One load at a time: a call while one runs shares it.
     */
    loadMore(): Promise<void> {
        if (this.complete) return Promise.resolve();
        if (!this.loading) {
            const generation = this.generation;
            const loading: Promise<void> = this.loadPages(generation).finally(() => {
                // A reload meanwhile started a newer load: that one is the current load now.
                if (this.loading === loading) this.loading = undefined;
                if (generation !== this.generation) return;
                this.render();
                void this.fillIfNeeded();
            });
            this.loading = loading;
        }
        this.render();
        return this.loading;
    }

    private async loadPages(generation: number): Promise<void> {
        const before = this.visibleCount();
        for (let page = 0; page < MAX_PAGES_PER_LOAD && !this.complete; page++) {
            const result = await this.history.repository.listVersions(this.history.documentId, {
                cursor: this.nextCursor,
                limit: this.options.pageSize ?? HISTORY_PAGE_SIZE,
            });
            if (generation !== this.generation) return;
            if (!result.isOk) {
                const [key, ...args] = repositoryErrorMessage(result.error);
                this.error = I18n.translate(key, ...args);
                break;
            }
            this.error = undefined;
            const known = new Set(this.versions.map((x) => x.id));
            this.versions.push(...result.value.items.filter((x) => !known.has(x.id)));
            this.nextCursor = result.value.nextCursor;
            this.complete = this.nextCursor === undefined;
            if (this.visibleCount() > before) break;
        }
    }

    private visibleCount(): number {
        return this.manualOnly ? this.versions.filter(isKept).length : this.versions.length;
    }

    private onScroll() {
        const { scrollTop, clientHeight, scrollHeight } = this.list;
        if (scrollTop + clientHeight >= scrollHeight - SCROLL_MARGIN_PX) void this.loadMore();
    }

    private filling = false;

    /**
     * A list shorter than the panel can't be scrolled: load on until it fills (or ends). Runs once
     * a load settled (never from `render`, which a load itself calls), one fill at a time.
     */
    private async fillIfNeeded() {
        if (this.filling || this.loading) return;
        this.filling = true;
        try {
            while (
                !this.complete &&
                !this.error &&
                this.list.clientHeight > 0 && // not laid out (hidden, or tests)
                this.list.scrollHeight <= this.list.clientHeight
            ) {
                await this.loadMore();
            }
        } finally {
            this.filling = false;
        }
    }

    // ---- Rendering ---------------------------------------------------------------------------

    render(): void {
        const head = this.versions[0];
        const byId = new Map(this.versions.map((x) => [x.id, x]));
        const groups = historyGroups(this.versions, { manualOnly: this.manualOnly, headId: head?.id });
        this.listBody.replaceChildren(
            ...groups.map((group) => {
                const element = div(
                    { className: style.group },
                    h3({ textContent: group.label }),
                    ...group.rows.flatMap((row) => this.renderRow(row, head, byId)),
                );
                element.dataset["group"] = group.key;
                return element;
            }),
        );
        this.renderFooter(groups.length === 0);
    }

    private renderFooter(empty: boolean) {
        const parts: HTMLElement[] = [];
        if (this.loading) {
            parts.push(
                div({ className: style.status, textContent: I18n.translate("cloud.history.loading") }),
            );
        } else if (this.error) {
            const error = div({ className: style.status, textContent: this.error });
            error.toggleAttribute("data-error", true);
            error.setAttribute("role", "alert");
            parts.push(error);
        } else if (empty && this.complete) {
            parts.push(div({ className: style.status, textContent: I18n.translate("cloud.history.empty") }));
        }
        if (!this.loading && !this.complete) {
            parts.push(
                button({
                    type: "button",
                    className: style.more,
                    textContent: I18n.translate("cloud.history.loadMore"),
                    onclick: () => void this.loadMore(),
                }),
            );
        }
        this.footer.replaceChildren(...parts);
    }

    private renderRow(
        row: HistoryRow,
        head: CloudVersion | undefined,
        byId: Map<string, CloudVersion>,
    ): HTMLElement[] {
        if (row.type === "version") return [this.versionRow(row.version, head, byId)];
        const open = this.expanded.has(row.key);
        const toggle = button({
            type: "button",
            className: style.autosaves,
            textContent: I18n.translate(
                open ? "cloud.history.hideAutosaves{0}" : "cloud.history.autosaves{0}",
                row.versions.length,
            ),
            onclick: () => {
                if (this.expanded.has(row.key)) this.expanded.delete(row.key);
                else this.expanded.add(row.key);
                this.render();
            },
        });
        toggle.dataset["autosaves"] = String(row.versions.length);
        toggle.setAttribute("aria-expanded", String(open));
        if (!open) return [toggle];
        return [
            toggle,
            div({ className: style.nested }, ...row.versions.map((v) => this.versionRow(v, head, byId))),
        ];
    }

    private versionRow(
        version: CloudVersion,
        head: CloudVersion | undefined,
        byId: Map<string, CloudVersion>,
    ): HTMLElement {
        const thumbnail = img({ className: style.thumbnail, alt: "" });
        if (version.thumbnailSha256) {
            void this.history.repository.imageUrl(version.thumbnailSha256).then((url) => {
                if (url) thumbnail.src = url;
            });
        }
        const kind = svg({ className: style.kindIcon, icon: VERSION_KIND_ICONS[version.kind] });
        kind.setAttribute("aria-label", I18n.translate(VERSION_KIND_LABELS[version.kind]));
        const time = setRelativeTime(span({}), versionTime(version));
        const title = div({ className: style.rowTitle }, time);
        if (version.id === head?.id) {
            title.append(
                span({ className: style.badge, textContent: I18n.translate("cloud.history.current") }),
            );
        }
        if (version.pinned) {
            title.append(
                span({ className: style.badge, textContent: I18n.translate("cloud.history.pinned") }),
            );
        }
        const text = div({ className: style.rowText }, title);
        if (version.label) text.append(span({ className: style.label, textContent: version.label }));
        text.append(span({ className: style.rowMeta, textContent: this.describe(version, byId) }));

        const main = button(
            {
                type: "button",
                className: style.rowButton,
                title: I18n.translate(VERSION_KIND_LABELS[version.kind]),
                onclick: () => {
                    this.selected = this.selected === version.id ? undefined : version.id;
                    this.render();
                },
            },
            thumbnail,
            kind,
            text,
        );
        const selected = this.selected === version.id;
        main.setAttribute("aria-expanded", String(selected));
        const row = div({ className: style.row }, main);
        row.dataset["versionId"] = version.id;
        row.dataset["kind"] = version.kind;
        row.toggleAttribute("data-selected", selected);
        row.toggleAttribute("data-previewed", this.history.previewed?.id === version.id);
        if (selected) row.append(this.actions(version, head));
        return row;
    }

    /** "Manual save · Desktop – Firefox", or "Merged changes from Laptop – Chrome". */
    private describe(version: CloudVersion, byId: Map<string, CloudVersion>): string {
        const device = version.deviceName || I18n.translate("cloud.conflict.unknownDevice");
        if (version.kind === "merge") {
            const from = mergedFromDevice(version, byId) ?? I18n.translate("cloud.conflict.unknownDevice");
            return I18n.translate("cloud.history.mergedFrom{0}", from);
        }
        return `${I18n.translate(VERSION_KIND_LABELS[version.kind])} · ${device}`;
    }

    private actions(version: CloudVersion, head: CloudVersion | undefined): HTMLElement {
        const tooNew = needsNewerApp(version);
        const isHead = version.id === head?.id;
        const action = (label: I18nKeys, run: () => Promise<unknown>, disabled = false) => {
            const element = button({
                type: "button",
                textContent: I18n.translate(label),
                disabled,
                onclick: () => {
                    for (const b of actions.querySelectorAll("button")) b.disabled = true;
                    void run().finally(() => this.render());
                },
            });
            element.dataset["action"] = label.slice(label.lastIndexOf(".") + 1);
            return element;
        };
        const index = this.versions.indexOf(version);
        const actions = div(
            { className: style.actions },
            action("cloud.history.preview", () => this.preview(version), tooNew),
            action("cloud.history.restore", () => this.restore(version), tooNew || isHead),
            action("cloud.history.name", () => this.askLabel(version)),
            action(version.pinned ? "cloud.history.unpin" : "cloud.history.pin", () =>
                this.update(version, { pinned: !version.pinned }),
            ),
            action("cloud.history.saveAsNew", () => this.saveAsNew(version), tooNew),
            action("cloud.history.download", () => this.report(this.history.download(version)), tooNew),
            action(
                "cloud.history.compareCurrent",
                () => this.compare(version, () => this.history.compareWithCurrent(version, head)),
                tooNew,
            ),
            action(
                "cloud.history.comparePrevious",
                () => this.comparePrevious(version),
                tooNew || (index === this.versions.length - 1 && this.complete),
            ),
        );
        if (tooNew) {
            actions.prepend(
                div({ className: style.status, textContent: I18n.translate("cloud.history.needsUpdate") }),
            );
        }
        return actions;
    }

    // ---- Actions -----------------------------------------------------------------------------

    private async report<T>(result: Promise<Result<T, HistoryFailure>>): Promise<Result<T, HistoryFailure>> {
        const settled = await result;
        if (!settled.isOk && !settled.error.cancelled) {
            PubSub.default.pub("showToast", "cloud.history.failed{0}", settled.error.message);
        }
        return settled;
    }

    async preview(version: CloudVersion): Promise<void> {
        await this.report(this.history.showPreview(version));
    }

    /** Restores `version`; the history then reloads (`onChanged`). */
    async restore(version: CloudVersion): Promise<void> {
        await this.history.restoreAndReport(version);
    }

    async saveAsNew(version: CloudVersion): Promise<void> {
        const saved = await this.report(this.history.saveAsNew(version));
        if (saved.isOk) PubSub.default.pub("showToast", "cloud.history.copySaved");
    }

    /** Label and pin changes replace the version in the list (the server answers the new one). */
    async update(version: CloudVersion, change: { label?: string; pinned?: boolean }): Promise<void> {
        const updated = await this.report(this.history.update(version, change));
        if (!updated.isOk) return;
        const index = this.versions.findIndex((x) => x.id === version.id);
        if (index >= 0) this.versions[index] = updated.value;
        this.render();
    }

    /** "Name this version": a label (kept through pruning); an empty one removes it. */
    askLabel(version: CloudVersion): Promise<void> {
        return new Promise((resolve) => {
            const field = textField({
                label: "cloud.history.labelField",
                name: "label",
                value: version.label ?? "",
                maxLength: LABEL_MAX_LENGTH,
            });
            const modal = new Modal({
                title: "cloud.history.nameTitle",
                content: [
                    field.root,
                    div({ className: style.note, textContent: I18n.translate("cloud.history.nameHint") }),
                ],
                onCancel: () => resolve(),
                actions: [
                    { label: "common.cancel" },
                    {
                        label: "common.confirm",
                        kind: "primary",
                        submit: true,
                        run: async () => {
                            await this.update(version, { label: field.value.trim() });
                            return undefined;
                        },
                    },
                ],
            });
            modal.onClosed(() => resolve());
            modal.open();
        });
    }

    private async comparePrevious(version: CloudVersion): Promise<void> {
        let index = this.versions.indexOf(version);
        if (index === this.versions.length - 1 && !this.complete) {
            await this.loadMore();
            index = this.versions.indexOf(version);
        }
        const previous = this.versions[index + 1];
        if (!previous) return;
        await this.compare(version, () => this.history.compareVersions(previous, version));
    }

    private async compare(
        version: CloudVersion,
        run: () => Promise<Result<DocumentChange[], HistoryFailure>>,
    ): Promise<void> {
        const changes = await this.report(run());
        if (!changes.isOk) return;
        const items = changes.value.map((change) => {
            const item = li({ textContent: I18n.translate(change.message, ...change.args) });
            item.dataset["kind"] = change.kind;
            return item;
        });
        new Modal({
            title: "cloud.history.compareTitle{0}",
            titleArgs: [formatDateTime(versionTime(version))],
            wide: true,
            content:
                items.length > 0
                    ? [ul({ className: style.changes }, ...items)]
                    : [div({ textContent: I18n.translate("cloud.history.noChanges") })],
            actions: [{ label: "common.close", kind: "primary", submit: true }],
        }).open();
    }
}

customElements.define("spicy-cloud-version-history", VersionHistoryPanel);
