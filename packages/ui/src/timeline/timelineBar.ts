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
import { div, input, svg } from "@spicy3d/element";
import { type ContextMenuEntry, showContextMenu } from "../contextMenu";
import { showDialog } from "../dialog";
import inputStyle from "../property/input.module.css";
import style from "./timelineBar.module.css";

const translate = (key: I18nKeys) => I18n.translate(key) ?? key;

/**
 * The design history of the active document along the bottom of the viewport, Fusion-timeline
 * style: one icon per step (`documentTimeline`), its name on hover and what it made highlighted
 * in the viewport. The strip scrolls sideways (the mouse wheel too) and follows new steps as they
 * appear. Click selects the step's node (a feature also opens in the body's feature list), marks
 * its icon and highlights what the step made; double-click edits it, the icon staying marked
 * through the edit session; right-click offers edit (the step, and the nodes a feature holds,
 * e.g. an extrude's sketch), suppress, rename and delete, each change one undo step.
 */
export class TimelineBar extends HTMLElement {
    private readonly track = div({ className: style.track });
    private document?: IDocument;
    private keys = new Set<string>();
    private closeMenu: (() => void) | undefined;
    /**
     * The clicked step's viewport highlight; `clear` takes it off, and is unset while a hovered
     * step's highlight shows instead (both use the same highlight state, which does not stack).
     */
    private highlight: { entry: TimelineEntry; clear: (() => void) | undefined } | undefined;
    /** Takes the hovered step's viewport highlight off again. */
    private clearHover: (() => void) | undefined;
    /**
     * The clicked or edited step, whose icon is marked. `editing` keeps it through an edit
     * session, which empties the selection, until its node is selected again.
     */
    private marked: { key: string; node: INode; editing: boolean } | undefined;
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
    }

    private readonly handleActiveViewChanged = (view: IView | undefined) => {
        this.setDocument(view?.document);
    };

    private readonly handleDocumentClosed = (document: IDocument) => {
        if (document === this.document) this.setDocument(undefined);
    };

    private setDocument(document: IDocument | undefined) {
        if (document === this.document) return;
        this.unhighlight();
        this.document?.history.onChanged.remove(this.scheduleRender);
        this.document?.selection.onNodeChanged.remove(this.handleSelectionChanged);
        this.marked = undefined;
        this.document = document;
        this.document?.history.onChanged.sub(this.scheduleRender);
        this.document?.selection.onNodeChanged.sub(this.handleSelectionChanged);
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
        if (this.marked !== undefined && !this.keys.has(this.marked.key)) this.marked = undefined;
        this.showMark();
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
                onclick: () => this.select(entry),
                ondblclick: () => this.edit(entry),
                onmouseenter: () => this.hover(entry),
                onmouseleave: () => this.unhover(),
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

    /**
     * Selects the step's node, marks its icon and highlights what the step made, until the
     * selection changes.
     */
    private select(entry: TimelineEntry) {
        const document = this.document;
        if (document === undefined) return;
        revealTimelineEntry(document, entry);
        // After the selection, whose change takes the previous highlight off.
        this.unhighlight();
        this.highlight = { entry, clear: highlightTimelineEntry(document, entry) };
        this.mark(entry, false);
        document.visual.update();
    }

    private readonly handleSelectionChanged = (nodes: INode[]) => {
        this.unhighlight();
        const marked = this.marked;
        if (marked === undefined) return;
        if (nodes.includes(marked.node)) marked.editing = false;
        else if (nodes.length > 0 || !marked.editing) this.mark(undefined);
    };

    private mark(entry: TimelineEntry | undefined, editing = false) {
        this.marked = entry === undefined ? undefined : { key: entry.key, node: entry.node, editing };
        this.showMark();
    }

    private showMark() {
        for (const item of this.track.children) {
            const marked = (item as HTMLElement).dataset["key"] === this.marked?.key;
            item.classList.toggle(style.selected, marked);
            if (marked) item.setAttribute("aria-current", "true");
            else item.removeAttribute("aria-current");
        }
    }

    private readonly unhighlight = () => {
        this.endHover();
        const highlight = this.highlight;
        if (highlight === undefined) return;
        this.highlight = undefined;
        highlight.clear?.();
        this.document?.visual.update();
    };

    /** Highlights what the hovered step made, in place of the clicked step's highlight. */
    private hover(entry: TimelineEntry) {
        const document = this.document;
        if (document === undefined) return;
        this.endHover();
        const highlight = this.highlight;
        highlight?.clear?.();
        if (highlight !== undefined) highlight.clear = undefined;
        this.clearHover = highlightTimelineEntry(document, entry);
        document.visual.update();
    }

    /** Takes the hovered step's highlight off and puts the clicked step's back. */
    private unhover() {
        const document = this.document;
        if (document === undefined || this.clearHover === undefined) return;
        this.endHover();
        const highlight = this.highlight;
        if (highlight !== undefined) highlight.clear = highlightTimelineEntry(document, highlight.entry);
        document.visual.update();
    }

    private endHover() {
        const clear = this.clearHover;
        this.clearHover = undefined;
        clear?.();
    }

    /**
     * Opens the step for editing: a feature that can be, in the interactive session it was
     * created with (its drag handles, a live preview), otherwise in the body's feature list with
     * its parameters; a node in the property panel, and what double-clicking it in the tree opens
     * (a sketch enters its editing session).
     */
    private edit(entry: TimelineEntry) {
        this.select(entry);
        this.mark(entry, true);
        if (entry.kind === "node") this.open(entry.node);
        else if (entry.feature.editable) entry.node.editFeature?.(entry.feature.id);
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
