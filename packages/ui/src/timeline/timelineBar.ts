// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    AnalysisNode,
    documentTimeline,
    highlightTimelineEntry,
    I18n,
    type I18nKeys,
    type IApplication,
    type IDocument,
    type INode,
    type IView,
    isNodeIcon,
    PubSub,
    revealTimelineEntry,
    type TimelineEntry,
    Transaction,
    timelineEntryLabel,
} from "@spicy3d/core";
import { button, div, input, span, svg } from "@spicy3d/element";
import { type ContextMenuEntry, showContextMenu } from "../contextMenu";
import { showDialog } from "../dialog";
import { FeatureEditor } from "../property/featureEditor";
import inputStyle from "../property/input.module.css";
import style from "./timelineBar.module.css";

const translate = (key: I18nKeys) => I18n.translate(key) ?? key;

/**
 * The design history of the active document along the bottom of the viewport, Fusion-timeline
 * style: one icon per step (`documentTimeline`), its name on hover. The strip scrolls sideways
 * (the mouse wheel too) and follows new steps as they appear. Click selects the step's node (a
 * feature also opens in the body's feature list) and highlights what the step made in the
 * viewport; double-click edits it; right-click offers edit (the step, and the nodes a feature
 * holds, e.g. an extrude's sketch), suppress, rename and delete, each change one undo step.
 * Editing a feature opens its editor above the step (e.g. an extrude's depth and its sketch),
 * and the step's result stays highlighted while it rebuilds.
 */
export class TimelineBar extends HTMLElement {
    private readonly track = div({ className: style.track });
    private document?: IDocument;
    private keys = new Set<string>();
    private closeMenu: (() => void) | undefined;
    /** Takes the clicked step's viewport highlight off again. */
    private clearHighlight: (() => void) | undefined;
    /** The clicked step: marked in the strip while its result is highlighted. */
    private activeKey: string | undefined;
    /** The feature whose editor is open above the strip. */
    private editor: { readonly key: string; readonly panel: HTMLElement } | undefined;
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
        this.closeMenu?.();
        this.closeEditor();
    }

    private readonly handleActiveViewChanged = (view: IView | undefined) => {
        this.setDocument(view?.document);
    };

    private readonly handleDocumentClosed = (document: IDocument) => {
        if (document === this.document) this.setDocument(undefined);
    };

    private setDocument(document: IDocument | undefined) {
        if (document === this.document) return;
        this.closeEditor();
        this.unhighlight();
        this.document?.history.onChanged.remove(this.scheduleRender);
        this.document?.selection.onNodeChanged.remove(this.unhighlight);
        this.document = document;
        this.document?.history.onChanged.sub(this.scheduleRender);
        this.document?.selection.onNodeChanged.sub(this.unhighlight);
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
        this.closeMenu?.();
        // A rebuild renumbers faces: the highlight would land on the wrong ones.
        this.unhighlight();
        const document = this.document;
        this.classList.toggle(style.hidden, document === undefined);
        const entries = document === undefined ? [] : documentTimeline(document);
        const previous = this.keys;
        const items = entries.map((entry) => this.entryItem(entry));
        this.track.replaceChildren(...items);
        this.keys = new Set(entries.map((x) => x.key));
        this.refreshEditor(entries);
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
            entry.key === this.activeKey ? style.active : "",
        ];
        const item = div(
            {
                className: classes.filter((x) => x !== "").join(" "),
                title: this.tooltip(entry),
                onclick: () => this.select(entry),
                ondblclick: () => this.edit(entry),
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

    /** Selects the step's node and highlights what the step made, until the selection changes. */
    private select(entry: TimelineEntry) {
        const document = this.document;
        if (document === undefined) return;
        if (this.editor !== undefined && this.editor.key !== entry.key) this.closeEditor();
        revealTimelineEntry(document, entry);
        // After the selection, whose change takes the previous highlight off.
        this.unhighlight();
        this.highlight(entry);
    }

    private highlight(entry: TimelineEntry) {
        const document = this.document;
        if (document === undefined) return;
        this.clearHighlight = highlightTimelineEntry(document, entry);
        this.setActive(entry.key);
        document.visual.update();
    }

    private readonly unhighlight = () => {
        this.setActive(undefined);
        const clear = this.clearHighlight;
        if (clear === undefined) return;
        this.clearHighlight = undefined;
        clear();
        this.document?.visual.update();
    };

    private setActive(key: string | undefined) {
        this.activeKey = key;
        for (const item of this.track.children) {
            (item as HTMLElement).classList.toggle(
                style.active,
                (item as HTMLElement).dataset["key"] === key,
            );
        }
    }

    /**
     * Opens the step for editing: a feature in the body's feature list, with its parameters; a
     * node in the property panel, and what double-clicking it in the tree opens (a sketch enters
     * its editing session).
     */
    private edit(entry: TimelineEntry) {
        this.select(entry);
        if (entry.kind === "node") this.open(entry.node);
        else this.openEditor(entry);
    }

    // --- feature editor ---

    /** Opens the feature's editor above its step: its parameters and the nodes it holds. */
    private openEditor(entry: Extract<TimelineEntry, { kind: "feature" }>) {
        const document = this.document;
        if (document === undefined) return;
        this.closeEditor();
        const panel = div({ className: style.editor });
        // Captured: the editor's boxes keep their keys from the app's shortcuts.
        panel.addEventListener(
            "keydown",
            (e) => {
                if (e.key !== "Escape") return;
                e.stopPropagation();
                this.closeEditor();
            },
            true,
        );
        this.editor = { key: entry.key, panel };
        this.fillEditor(document, entry);
        this.append(panel);
        panel.querySelector("input")?.focus();
    }

    private fillEditor(document: IDocument, entry: Extract<TimelineEntry, { kind: "feature" }>) {
        const panel = this.editor?.panel;
        if (panel === undefined) return;
        const header = div(
            { className: style.editorHeader },
            svg({ className: style.icon, icon: entry.icon }),
            span({ className: style.editorTitle, textContent: timelineEntryLabel(entry, translate) }),
            span({ className: style.editorBody, textContent: entry.node.name }),
            button(
                {
                    className: style.editorClose,
                    title: I18n.translate("common.close") ?? "",
                    onclick: () => this.closeEditor(),
                },
                svg({ className: style.icon, icon: "icon-times" }),
            ),
        );
        panel.replaceChildren(
            header,
            new FeatureEditor(document, entry.node, entry.feature, () => this.closeEditor()),
        );
        this.placeEditor(entry.key);
    }

    /** Above its step, kept inside the bar. */
    private placeEditor(key: string) {
        const panel = this.editor?.panel;
        const item = [...this.track.children].find((x) => (x as HTMLElement).dataset["key"] === key);
        if (panel === undefined || item === undefined) return;
        const bar = this.getBoundingClientRect();
        const left = item.getBoundingClientRect().left - bar.left;
        const width = panel.offsetWidth;
        panel.style.left = `${Math.max(4, Math.min(left, bar.width - width - 4))}px`;
    }

    /**
     * After a change (an edit in the editor, an undo): the open editor shows the feature as it
     * is now, and its rebuilt result is highlighted again. A feature that is gone closes it.
     */
    private refreshEditor(entries: TimelineEntry[]) {
        const editor = this.editor;
        const document = this.document;
        if (editor === undefined || document === undefined) return;
        const entry = entries.find((x) => x.key === editor.key);
        if (entry?.kind !== "feature") {
            this.closeEditor();
            return;
        }
        const focused = [...editor.panel.querySelectorAll("input")].indexOf(
            globalThis.document.activeElement as HTMLInputElement,
        );
        this.fillEditor(document, entry);
        if (focused >= 0) editor.panel.querySelectorAll("input")[focused]?.focus();
        this.highlight(entry);
    }

    private closeEditor() {
        const editor = this.editor;
        if (editor === undefined) return;
        this.editor = undefined;
        editor.panel.remove();
    }

    private open(node: INode) {
        if (node instanceof AnalysisNode) PubSub.default.pub("showAnalysisPanel", node);
        else PubSub.default.pub("nodeDoubleClicked", node);
    }

    // --- context menu ---

    private openMenu(x: number, y: number, entry: TimelineEntry) {
        const label = timelineEntryLabel(entry, translate);
        const entries: ContextMenuEntry[] = [
            { icon: entry.icon, label: "timeline.edit{0}", args: [label], run: () => this.edit(entry) },
        ];
        if (entry.kind === "feature") entries.push(...this.featureActions(entry));
        entries.push(
            "separator",
            { icon: "icon-edit", label: "common.rename", run: () => this.rename(entry) },
            "separator",
            { icon: "icon-delete", label: "common.delete", danger: true, run: () => this.delete(entry) },
        );
        this.closeMenu = showContextMenu({ x, y }, entries);
    }

    /** Editing a feature's surroundings: the nodes it holds (an extrude's sketch), its picks, suppression. */
    private featureActions(entry: Extract<TimelineEntry, { kind: "feature" }>): ContextMenuEntry[] {
        const { node, feature } = entry;
        const actions: ContextMenuEntry[] = (feature.references ?? []).map((ref) => ({
            icon: isNodeIcon(ref.node) ? ref.node.icon : "icon-edit",
            label: "timeline.edit{0}",
            args: [translate(ref.display)],
            run: () => node.activateReference?.(feature.id, ref.key),
        }));
        if (feature.reselectable) {
            actions.push({
                icon: "icon-sync-alt",
                label: "features.reselect",
                run: () => node.reselectShapes?.(feature.id),
            });
        }
        actions.push({
            icon: feature.suppressed ? "icon-eye" : "icon-eye-slash",
            label: feature.suppressed ? "features.unsuppress" : "features.suppress",
            run: () => this.toggleSuppressed(entry),
        });
        return actions;
    }

    private toggleSuppressed(entry: Extract<TimelineEntry, { kind: "feature" }>) {
        const document = this.document;
        if (document === undefined) return;
        Transaction.execute(document, "toggle feature", () => {
            entry.node.setFeatureSuppressed(entry.feature.id, !entry.feature.suppressed);
            document.visual.update();
        });
    }

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
            this.deleteFeature(document, entry);
            return;
        }
        // The delete command owns the rules (consumed tools refused, current node reset, toast).
        document.selection.setSelectedNodes([entry.node], false);
        PubSub.default.pub("executeCommand", "modify.deleteNode");
    }

    /**
     * Features after this one may be built on its faces and edges, so deleting it can break them:
     * asked first unless it is the body's last feature (as the feature list does).
     */
    private deleteFeature(document: IDocument, entry: Extract<TimelineEntry, { kind: "feature" }>) {
        const remove = () =>
            Transaction.execute(document, "remove feature", () => {
                entry.node.removeFeature(entry.feature.id);
                document.visual.update();
            });
        const items = entry.node.featureItems();
        const later = items.length - 1 - items.findIndex((x) => x.id === entry.feature.id);
        if (later <= 0) {
            remove();
            return;
        }
        const name = timelineEntryLabel(entry, translate);
        showDialog(
            "features.delete.title",
            div({ textContent: I18n.translate("features.delete.warning{0}{1}", name, later) }),
            [{ content: "common.delete", onclick: remove }, { content: "common.cancel" }],
        );
    }
}

customElements.define("spicy-timeline-bar", TimelineBar);
