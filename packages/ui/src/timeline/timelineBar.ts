// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    documentTimeline,
    I18n,
    type I18nKeys,
    type IApplication,
    type IDocument,
    type IView,
    Localize,
    PubSub,
    revealTimelineEntry,
    type TimelineEntry,
    Transaction,
    timelineEntryLabel,
} from "@spicy3d/core";
import { div, input, span, svg } from "@spicy3d/element";
import { showDialog } from "../dialog";
import inputStyle from "../property/input.module.css";
import style from "./timelineBar.module.css";

const translate = (key: I18nKeys) => I18n.translate(key) ?? key;

/**
 * The design history of the active document along the bottom of the viewport, Fusion-timeline
 * style: one icon per step (`documentTimeline`), its name on hover. The strip scrolls sideways
 * (the mouse wheel too) and follows new steps as they appear. Click selects the step's node (a
 * feature also opens in the body's feature list); right-click offers rename and delete, each one
 * undo step.
 */
export class TimelineBar extends HTMLElement {
    private readonly track = div({ className: style.track });
    private document?: IDocument;
    private keys = new Set<string>();
    private menu: HTMLElement | undefined;
    private renderQueued = false;

    constructor(readonly app: IApplication) {
        super();
        this.className = style.root;
        this.setAttribute("aria-label", I18n.translate("timeline.title") ?? "");
        this.append(this.track);
        this.track.addEventListener("wheel", this.handleWheel, { passive: false });
        this.render();
    }

    connectedCallback(): void {
        PubSub.default.sub("activeViewChanged", this.handleActiveViewChanged);
        PubSub.default.sub("documentClosed", this.handleDocumentClosed);
        // The first view may have been activated before the editor was built.
        this.setDocument(this.app.activeView?.document);
    }

    disconnectedCallback(): void {
        PubSub.default.remove("activeViewChanged", this.handleActiveViewChanged);
        PubSub.default.remove("documentClosed", this.handleDocumentClosed);
        this.setDocument(undefined);
        this.closeMenu();
    }

    private readonly handleActiveViewChanged = (view: IView | undefined) => {
        this.setDocument(view?.document);
    };

    private readonly handleDocumentClosed = (document: IDocument) => {
        if (document === this.document) this.setDocument(undefined);
    };

    private setDocument(document: IDocument | undefined) {
        if (document === this.document) return;
        this.document?.history.onChanged.remove(this.scheduleRender);
        this.document = document;
        this.document?.history.onChanged.sub(this.scheduleRender);
        // A document switch is not "new steps": the strip opens on the latest ones.
        this.keys = new Set();
        this.render();
        this.track.scrollLeft = this.track.scrollWidth;
    }

    /** Every committed change, undo and redo moves the history; one render per burst. */
    private readonly scheduleRender = () => {
        if (this.renderQueued) return;
        this.renderQueued = true;
        queueMicrotask(() => {
            this.renderQueued = false;
            this.render();
        });
    };

    /** Rebuilds the strip; the newest step that was not there before is scrolled into view. */
    render(): void {
        this.closeMenu();
        const document = this.document;
        this.classList.toggle(style.hidden, document === undefined);
        const entries = document === undefined ? [] : documentTimeline(document);
        const previous = this.keys;
        const items = entries.map((entry) => this.entryItem(entry));
        this.track.replaceChildren(...items);
        this.keys = new Set(entries.map((x) => x.key));
        if (previous.size === 0) return;
        const added = items.findLast((_item, i) => !previous.has(entries[i].key));
        added?.scrollIntoView?.({ behavior: "smooth", block: "nearest", inline: "nearest" });
    }

    private entryItem(entry: TimelineEntry): HTMLElement {
        const feature = entry.kind === "feature" ? entry.feature : undefined;
        const classes = [
            style.entry,
            feature?.suppressed ? style.suppressed : "",
            feature?.error !== undefined ? style.error : "",
            feature?.warning !== undefined ? style.warning : "",
        ];
        const item = div(
            {
                className: classes.filter((x) => x !== "").join(" "),
                title: this.tooltip(entry),
                onclick: () => {
                    if (this.document) revealTimelineEntry(this.document, entry);
                },
                oncontextmenu: (e: MouseEvent) => {
                    e.preventDefault();
                    e.stopPropagation();
                    this.openMenu(e.clientX, e.clientY, entry);
                },
            },
            svg({ className: style.icon, icon: entry.icon }),
        );
        item.dataset["key"] = entry.key;
        return item;
    }

    /** The step's name; a feature adds its body, and a failing or dimmed one says why. */
    private tooltip(entry: TimelineEntry): string {
        const label = timelineEntryLabel(entry, translate);
        if (entry.kind === "node") return label;
        const title = I18n.translate("timeline.feature{0}{1}", label, entry.node.name) ?? label;
        const note = entry.feature.error ?? entry.feature.warning;
        return note === undefined ? title : `${title}\n${note}`;
    }

    private readonly handleWheel = (e: WheelEvent) => {
        // A vertical wheel scrolls the horizontal strip; a trackpad's own sideways swipe passes.
        if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
        e.preventDefault();
        this.track.scrollLeft += e.deltaY;
    };

    // --- context menu ---

    private openMenu(x: number, y: number, entry: TimelineEntry) {
        this.closeMenu();
        const entries: [icon: string, display: I18nKeys, action: () => void][] = [
            ["icon-edit", "common.rename", () => this.rename(entry)],
            ["icon-delete", "common.delete", () => this.delete(entry)],
        ];
        const menu = div(
            { className: style.menu },
            ...entries.map(([icon, display, action]) =>
                div(
                    {
                        className: style.menuItem,
                        onclick: (e: MouseEvent) => {
                            e.stopPropagation();
                            this.closeMenu();
                            action();
                        },
                    },
                    svg({ className: style.menuIcon, icon }),
                    span({ textContent: new Localize(display) }),
                ),
            ),
        );
        globalThis.document.body.appendChild(menu);
        // Opens above the pointer (the bar sits at the bottom), kept inside the window.
        const margin = 4;
        const top = Math.max(margin, Math.min(y - menu.offsetHeight, window.innerHeight - menu.offsetHeight));
        const left = Math.max(margin, Math.min(x, window.innerWidth - menu.offsetWidth - margin));
        menu.style.top = `${top}px`;
        menu.style.left = `${left}px`;
        this.menu = menu;
        globalThis.document.addEventListener("click", this.handleOutsideClick, true);
        globalThis.document.addEventListener("contextmenu", this.handleOutsideClick, true);
        globalThis.document.addEventListener("keydown", this.handleMenuKeyDown);
    }

    private closeMenu() {
        if (this.menu === undefined) return;
        this.menu.remove();
        this.menu = undefined;
        globalThis.document.removeEventListener("click", this.handleOutsideClick, true);
        globalThis.document.removeEventListener("contextmenu", this.handleOutsideClick, true);
        globalThis.document.removeEventListener("keydown", this.handleMenuKeyDown);
    }

    private readonly handleOutsideClick = (e: Event) => {
        if (this.menu !== undefined && !this.menu.contains(e.target as Node)) this.closeMenu();
    };

    private readonly handleMenuKeyDown = (e: KeyboardEvent) => {
        if (e.key === "Escape") this.closeMenu();
    };

    private rename(entry: TimelineEntry) {
        const document = this.document;
        if (document === undefined) return;
        const box = input({ className: inputStyle.box, value: timelineEntryLabel(entry, translate) });
        showDialog("common.rename", box, () => {
            const name = box.value.trim();
            if (entry.kind === "feature") {
                Transaction.execute(document, "rename feature", () => {
                    entry.node.renameFeature?.(entry.feature.id, name);
                });
            } else if (name !== "") {
                Transaction.execute(document, "rename", () => {
                    entry.node.name = name;
                });
            }
        });
        setTimeout(() => {
            box.focus();
            box.select();
        });
    }

    private delete(entry: TimelineEntry) {
        const document = this.document;
        if (document === undefined) return;
        if (entry.kind === "feature") {
            Transaction.execute(document, "remove feature", () => {
                entry.node.removeFeature(entry.feature.id);
                document.visual.update();
            });
            return;
        }
        // The delete command owns the rules (consumed tools refused, current node reset, toast).
        document.selection.setSelectedNodes([entry.node], false);
        PubSub.default.pub("executeCommand", "modify.deleteNode");
    }
}

customElements.define("spicy-timeline-bar", TimelineBar);
