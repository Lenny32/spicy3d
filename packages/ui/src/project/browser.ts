// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    AnalysisNode,
    BrowserActions,
    type BrowserEntry,
    type BrowserModel,
    componentAnalysisColor,
    I18n,
    type IDocument,
    type INode,
    isNodeWarning,
    MeshNode,
    NodeSelectionHandler,
    PubSub,
    ShapeNode,
    ShapeSelectionHandler,
    ShapeTypes,
    XYZ,
} from "@spicy3d/core";
import { setSVGIcon, svg } from "@spicy3d/element";
import { type ContextMenuEntry, showContextMenu } from "../contextMenu";
import style from "./browser.module.css";
import { browserIcon } from "./browserIcons";

const ROW_HEIGHT = 28;
const OVERSCAN = 8;
type FlatRow = { entry: BrowserEntry; depth: number };

/** Virtualized tree. Only expansion, focus, scroll and the inline editor belong to the UI. */
export class Browser extends HTMLElement {
    readonly model: BrowserModel;
    readonly actions: BrowserActions;
    private readonly expanded = new Map<string, boolean>();
    private readonly content = document.createElement("div");
    private readonly rows = new Map<string, HTMLElement>();
    private flat: FlatRow[] = [];
    private selected = new Set<string>();
    private focusKey?: string;
    private anchorKey?: string;
    private dragKeys: string[] = [];
    private editingKey?: string;
    private resizeObserver?: ResizeObserver;

    constructor(readonly document: IDocument) {
        super();
        this.model = document.modelManager.browser;
        this.actions = new BrowserActions(this.model);
        this.className = style.browser;
        this.tabIndex = 0;
        this.setAttribute("role", "tree");
        this.setAttribute("aria-label", I18n.translate("browser.title"));
        this.setAttribute("aria-multiselectable", "true");
        this.content.className = style.content;
        this.append(this.content);
        this.addEventListener("scroll", this.renderRows);
        this.addEventListener("keydown", this.onKeyDown);
        this.addEventListener("dragend", this.onDragEnd);
        this.refresh();
    }

    connectedCallback(): void {
        this.model.changed.sub(this.refresh);
        this.document.selection.onNodeChanged.sub(this.onSelectionChanged);
        this.document.selection.onShapeChanged.sub(this.onSelectionChanged);
        PubSub.default.sub("analysisDisplayChanged", this.onAnalysisChanged);
        PubSub.default.sub("showProjectProperties", this.onProjectProperties);
        if (typeof ResizeObserver !== "undefined") {
            this.resizeObserver = new ResizeObserver(this.renderRows);
            this.resizeObserver.observe(this);
        }
        this.refresh();
        this.onSelectionChanged();
    }

    disconnectedCallback(): void {
        this.model.changed.remove(this.refresh);
        this.document.selection.onNodeChanged.remove(this.onSelectionChanged);
        this.document.selection.onShapeChanged.remove(this.onSelectionChanged);
        PubSub.default.remove("analysisDisplayChanged", this.onAnalysisChanged);
        PubSub.default.remove("showProjectProperties", this.onProjectProperties);
        this.resizeObserver?.disconnect();
        this.resizeObserver = undefined;
    }

    dispose(): void {
        this.disconnectedCallback();
        this.removeEventListener("scroll", this.renderRows);
        this.removeEventListener("keydown", this.onKeyDown);
        this.removeEventListener("dragend", this.onDragEnd);
        this.rows.clear();
        this.expanded.clear();
        this.flat = [];
        this.remove();
    }

    private isExpanded(entry: BrowserEntry): boolean {
        return this.expanded.get(entry.key) ?? ["document", "component", "category"].includes(entry.type);
    }

    setExpanded(expanded: boolean): void {
        for (const entry of this.model.entries.values())
            if (entry.children.length) this.expanded.set(entry.key, expanded);
        this.refresh();
    }

    private readonly refresh = () => {
        const flat: FlatRow[] = [];
        const pending = [{ key: this.model.rootKey, depth: 0 }];
        while (pending.length) {
            const { key, depth } = pending.pop()!;
            const entry = this.model.entries.get(key);
            if (!entry) continue;
            flat.push({ entry, depth });
            if (this.isExpanded(entry))
                for (let index = entry.children.length - 1; index >= 0; index--)
                    pending.push({ key: entry.children[index], depth: depth + 1 });
        }
        this.flat = flat;
        this.content.style.minWidth = `${Math.max(220, ...flat.map((row) => row.depth * 16 + 160))}px`;
        if (this.focusKey && !this.model.entries.has(this.focusKey)) this.focusKey = this.model.rootKey;
        this.content.style.height = `${flat.length * ROW_HEIGHT}px`;
        this.renderRows();
    };

    private readonly renderRows = () => {
        const start = Math.max(0, Math.floor(this.scrollTop / ROW_HEIGHT) - OVERSCAN);
        const count = Math.ceil((this.clientHeight || 560) / ROW_HEIGHT) + 2 * OVERSCAN;
        const visible = this.flat.slice(start, start + count);
        const wanted = new Set(visible.map(({ entry }) => entry.key));
        if (this.editingKey) wanted.add(this.editingKey);
        for (const [key, row] of this.rows) {
            if (!wanted.has(key)) {
                row.remove();
                this.rows.delete(key);
            }
        }
        visible.forEach(({ entry, depth }, offset) => {
            let row = this.rows.get(entry.key);
            if (!row) {
                row = this.createRow(entry);
                this.rows.set(entry.key, row);
                this.content.append(row);
            }
            row.style.top = `${(start + offset) * ROW_HEIGHT}px`;
            row.style.paddingLeft = `${depth * 16 + 4}px`;
            this.updateRow(row, entry, depth);
        });
        const focusRow = this.focusKey ? this.rows.get(this.focusKey) : undefined;
        if (focusRow) this.setAttribute("aria-activedescendant", focusRow.id);
        else this.removeAttribute("aria-activedescendant");
    };

    private createRow(entry: BrowserEntry): HTMLElement {
        const row = window.document.createElement("div");
        row.className = style.row;
        row.id = `browser-${this.document.id}-${encodeURIComponent(entry.key)}`;
        row.dataset["key"] = entry.key;
        row.setAttribute("role", "treeitem");
        const expand = window.document.createElement("button");
        expand.className = style.control;
        expand.tabIndex = -1;
        expand.dataset["expand"] = "";
        expand.onclick = (event) => {
            event.stopPropagation();
            this.toggle(entry);
        };
        const visibility = window.document.createElement("button");
        visibility.className = style.control;
        visibility.tabIndex = -1;
        visibility.dataset["visibility"] = "";
        visibility.append(svg({ icon: "icon-eye", className: style.icon }));
        visibility.onclick = (event) => {
            event.stopPropagation();
            this.actions.setVisible([entry], !(entry.node?.visible ?? false));
        };
        const icon = svg({
            icon: browserIcon(entry, this.model, this.isExpanded(entry)),
            className: `${style.icon} ${style.typeIcon}`,
        });
        icon.dataset["typeIcon"] = "";
        const name = window.document.createElement("span");
        name.className = style.name;
        name.dataset["name"] = "";
        const active = window.document.createElement("button");
        active.className = style.control;
        active.tabIndex = -1;
        active.dataset["active"] = "";
        active.onclick = (event) => {
            event.stopPropagation();
            this.actions.activate(entry);
        };
        const warning = window.document.createElement("span");
        warning.className = style.warning;
        warning.dataset["warning"] = "";
        const swatch = window.document.createElement("span");
        swatch.className = style.swatch;
        swatch.dataset["swatch"] = "";
        row.append(expand, visibility, icon, name, active, warning, swatch);
        row.onclick = (event) => this.select(entry, event);
        row.ondblclick = (event) => {
            event.stopPropagation();
            this.open(entry);
        };
        row.oncontextmenu = (event) => this.contextMenu(entry, event);
        row.ondragstart = (event) => {
            if (!entry.node?.parent || entry.originMember !== undefined || !this.actions.editable) {
                event.preventDefault();
                return;
            }
            this.dragKeys = this.selected.has(entry.key) ? [...this.selected] : [entry.key];
            event.dataTransfer?.setData("application/x-spicy3d-browser", this.document.id);
            if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
        };
        row.ondragover = (event) => {
            if (this.actions.canMove(this.dragEntries(), entry)) {
                event.preventDefault();
                row.classList.add(style.dropTarget);
                if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
            }
        };
        row.ondragleave = () => row.classList.remove(style.dropTarget);
        row.ondrop = (event) => {
            event.preventDefault();
            event.stopPropagation();
            this.actions.move(this.dragEntries(), entry);
            this.onDragEnd();
        };
        return row;
    }

    private updateRow(row: HTMLElement, entry: BrowserEntry, depth: number): void {
        row.classList.toggle(style.selected, this.selected.has(entry.key));
        row.classList.toggle(style.focused, this.focusKey === entry.key);
        row.classList.toggle(
            style.hiddenObject,
            entry.node ? !entry.node.visible || !entry.node.parentVisible : false,
        );
        row.setAttribute("aria-level", String(depth + 1));
        row.setAttribute("aria-selected", String(this.selected.has(entry.key)));
        const expand = row.querySelector<HTMLButtonElement>("[data-expand]")!;
        expand.textContent = entry.children.length ? (this.isExpanded(entry) ? "▾" : "▸") : "";
        expand.disabled = !entry.children.length;
        expand.setAttribute(
            "aria-label",
            I18n.translate(this.isExpanded(entry) ? "browser.collapse" : "browser.expand"),
        );
        if (entry.children.length) row.setAttribute("aria-expanded", String(this.isExpanded(entry)));
        else row.removeAttribute("aria-expanded");
        const visibility = row.querySelector<HTMLButtonElement>("[data-visibility]")!;
        const canHide = !!entry.node || entry.originMember !== undefined;
        visibility.style.visibility = canHide ? "visible" : "hidden";
        visibility.disabled = entry.originMember === undefined && !this.actions.editable;
        setSVGIcon(
            visibility.querySelector<SVGSVGElement>("svg")!,
            entry.node?.visible ? "icon-eye" : "icon-eye-slash",
        );
        visibility.setAttribute(
            "aria-label",
            I18n.translate(entry.node?.visible ? "items.menu.hide" : "items.menu.show"),
        );
        if (this.editingKey !== entry.key)
            row.querySelector<HTMLElement>("[data-name]")!.textContent = entry.label
                ? I18n.translate(entry.label)
                : entry.name;
        const active = row.querySelector<HTMLButtonElement>("[data-active]")!;
        const component = entry.type === "component" || entry.type === "document";
        active.style.display = component ? "" : "none";
        active.textContent = this.model.activeKey === entry.key ? "●" : "○";
        active.setAttribute("aria-label", I18n.translate("browser.activate"));
        active.title = I18n.translate(
            this.model.activeKey === entry.key ? "browser.active" : "browser.activate",
        );
        row.draggable = !!entry.node?.parent && entry.originMember === undefined && this.actions.editable;
        const icon = row.querySelector<SVGSVGElement>("[data-type-icon]")!;
        const typeIcon = browserIcon(entry, this.model, this.isExpanded(entry));
        if (icon.dataset["type"] !== typeIcon) {
            setSVGIcon(icon, typeIcon);
            icon.dataset["type"] = typeIcon;
        }
        const warning = row.querySelector<HTMLElement>("[data-warning]")!;
        const count = entry.node && isNodeWarning(entry.node) ? entry.node.warningCount : 0;
        warning.textContent = count ? "!" : "";
        warning.title =
            count && entry.node && isNodeWarning(entry.node)
                ? I18n.translate(entry.node.warningTooltip, ...(entry.node.warningTooltipArgs ?? [count]))
                : "";
        const swatch = row.querySelector<HTMLElement>("[data-swatch]")!;
        const colored =
            (entry.node instanceof ShapeNode || entry.node instanceof MeshNode) &&
            this.document.analyses.items.some(
                (item) => item.kind === "componentColors" && item.visible && item.status === "ready",
            );
        swatch.style.display = colored ? "" : "none";
        if (colored)
            swatch.style.backgroundColor = `#${componentAnalysisColor(entry.node!).toString(16).padStart(6, "0")}`;
    }

    private canSelect(node?: INode): boolean {
        const handler = this.document.visual.eventHandler;
        if (handler instanceof NodeSelectionHandler)
            return !node || !handler.filter || handler.filter.allow(node);
        if (handler instanceof ShapeSelectionHandler && handler.shapeType === ShapeTypes.shape)
            return !node || !handler.nodeFilter || handler.nodeFilter.allow(node);
        return false;
    }

    private select(entry: BrowserEntry, event: MouseEvent | KeyboardEvent): void {
        event.stopPropagation();
        this.focusKey = entry.key;
        this.focus({ preventScroll: true });
        if (entry.type === "settings" || entry.type === "units") {
            this.document.selection.clearSelection();
            PubSub.default.pub("showProjectProperties", this.document);
        } else if (this.canSelect() && (entry.node || entry.originMember !== undefined)) {
            const node = entry.node ?? this.model.originNode(entry)!;
            if (!this.canSelect(node)) return;
            if (entry.originMember !== undefined && !node.visible) this.actions.setVisible([entry], true);
            let nodes = [node];
            if (event.shiftKey && this.anchorKey) {
                const first = this.flat.findIndex((row) => row.entry.key === this.anchorKey);
                const last = this.flat.findIndex((row) => row.entry.key === entry.key);
                if (first >= 0 && last >= 0)
                    nodes = this.flat
                        .slice(Math.min(first, last), Math.max(first, last) + 1)
                        .map((row) => row.entry)
                        .filter(
                            (item) =>
                                item.node && item.originMember === undefined && this.canSelect(item.node),
                        )
                        .map((item) => item.node!);
            } else this.anchorKey = entry.key;
            if (event.ctrlKey || event.metaKey) {
                const previous = [...this.selected]
                    .map((key) => this.model.entries.get(key)?.node)
                    .filter((item): item is INode => !!item);
                const all = new Set(previous);
                for (const selected of nodes) {
                    if (all.has(selected)) all.delete(selected);
                    else all.add(selected);
                }
                this.document.selection.clearSelection();
                this.document.selection.setSelectedNodes([...all], false);
            } else {
                this.document.selection.clearSelection();
                this.document.selection.setSelectedNodes(nodes, false);
            }
        }
        this.renderRows();
    }

    private toggle(entry: BrowserEntry): void {
        if (!entry.children.length) return;
        this.focusKey = entry.key;
        this.expanded.set(entry.key, !this.isExpanded(entry));
        this.refresh();
    }

    private open(entry: BrowserEntry): void {
        if (this.actions.activate(entry)) return;
        if (entry.type === "view") {
            this.activateView(entry);
            return;
        }
        if (entry.node instanceof AnalysisNode) {
            PubSub.default.pub("showAnalysisPanel", entry.node);
            return;
        }
        if (entry.description?.edit && entry.node && this.actions.editable)
            entry.description.edit(entry.node);
        else if (entry.node && this.actions.editable && entry.originMember === undefined)
            PubSub.default.pub("nodeDoubleClicked", entry.node);
    }

    private activateView(entry: BrowserEntry): void {
        const view = this.document.application.activeView;
        if (!view || view.document !== this.document) return;
        const camera = view.cameraController;
        if (entry.view)
            camera.lookAt(entry.view.cameraPosition, entry.view.cameraTarget, entry.view.cameraUp);
        else {
            const direction =
                entry.preset === "front"
                    ? XYZ.unitY.multiply(-1)
                    : entry.preset === "right"
                      ? XYZ.unitX
                      : entry.preset === "top"
                        ? XYZ.unitZ
                        : new XYZ(1, -1, 1).normalize()!;
            const distance = Math.max(1, camera.cameraPosition.distanceTo(camera.cameraTarget));
            camera.lookAt(
                camera.cameraTarget.add(direction.multiply(distance)),
                camera.cameraTarget,
                entry.preset === "top" ? XYZ.unitY : XYZ.unitZ,
            );
        }
        view.update();
    }

    reveal(key: string): void {
        let entry = this.model.entries.get(key);
        while (entry?.parentKey) {
            this.expanded.set(entry.parentKey, true);
            entry = this.model.entries.get(entry.parentKey);
        }
        this.refresh();
        const index = this.flat.findIndex((row) => row.entry.key === key);
        if (index < 0) return;
        const top = index * ROW_HEIGHT;
        if (top < this.scrollTop) this.scrollTop = top;
        else if (top + ROW_HEIGHT > this.scrollTop + (this.clientHeight || 560))
            this.scrollTop = top + ROW_HEIGHT - (this.clientHeight || 560);
        this.renderRows();
    }

    private readonly onSelectionChanged = () => {
        this.selected = new Set(
            this.document.selection
                .getSelectedNodes()
                .map((node) => this.model.nodeKeys.get(node))
                .filter((key): key is string => !!key),
        );
        for (const shape of this.document.selection.getSelectedShapes()) {
            const node = this.document.visual.context.getNode(shape.owner);
            const key = node && this.model.nodeKeys.get(node);
            if (key) this.selected.add(key);
        }
        const key = this.selected.values().next().value;
        if (key) this.reveal(key);
        else this.renderRows();
    };
    private readonly onAnalysisChanged = (document: IDocument) => {
        if (document === this.document) this.renderRows();
    };
    private readonly onProjectProperties = (document: IDocument) => {
        if (document === this.document) {
            this.selected = new Set([`${this.model.rootKey}:settings`]);
            this.renderRows();
        }
    };

    private rename(entry: BrowserEntry): void {
        if (!this.actions.editable || entry.originMember !== undefined || (!entry.node && !entry.view))
            return;
        this.reveal(entry.key);
        const row = this.rows.get(entry.key);
        if (!row) return;
        this.editingKey = entry.key;
        const name = row.querySelector<HTMLElement>("[data-name]")!;
        const input = window.document.createElement("input");
        input.className = style.rename;
        input.value = entry.name;
        input.setAttribute("aria-label", I18n.translate("common.rename"));
        input.onpointerdown = (event) => event.stopPropagation();
        input.onclick = (event) => event.stopPropagation();
        input.ondblclick = (event) => event.stopPropagation();
        const finish = (commit: boolean) => {
            if (this.editingKey !== entry.key) return;
            this.editingKey = undefined;
            if (commit) this.actions.rename(entry, input.value);
            this.renderRows();
            this.focus({ preventScroll: true });
        };
        input.onkeydown = (event) => {
            event.stopPropagation();
            if (event.key === "Enter" || event.key === "Escape") {
                event.preventDefault();
                finish(event.key === "Enter");
            }
        };
        input.onblur = () => finish(true);
        name.replaceChildren(input);
        input.focus();
        input.select();
    }

    private contextMenu(entry: BrowserEntry, event: MouseEvent): void {
        event.preventDefault();
        event.stopPropagation();
        if (entry.node && !this.selected.has(entry.key)) this.select(entry, event);
        const selected = this.selected.has(entry.key)
            ? [...this.selected].map((key) => this.model.entries.get(key)!).filter(Boolean)
            : [entry];
        const menu: ContextMenuEntry[] = [];
        if (entry.type === "component" || entry.type === "document") {
            menu.push({ label: "browser.activate", run: () => this.actions.activate(entry) });
            if (this.actions.editable)
                menu.push({
                    label: "browser.newComponent",
                    icon: "icon-folder-plus",
                    run: () => {
                        this.actions.activate(entry);
                        PubSub.default.pub("executeCommand", "create.folder");
                    },
                });
        }
        if (entry.description?.edit && entry.node && this.actions.editable)
            menu.push({
                label: entry.description.editLabel ?? "browser.properties",
                run: () => this.open(entry),
            });
        if (entry.type === "view")
            menu.push({ label: "browser.viewActivate", run: () => this.activateView(entry) });
        if (
            selected.length === 1 &&
            this.actions.editable &&
            entry.originMember === undefined &&
            (entry.node || entry.view)
        )
            menu.push({ label: "common.rename", icon: "icon-edit", run: () => this.rename(entry) });
        if (selected.every((item) => item.node || item.originMember !== undefined)) {
            const visible = selected.every((item) => !item.node?.visible);
            menu.push({
                label: visible ? "items.menu.show" : "items.menu.hide",
                disabled: !this.actions.editable && selected.some((item) => item.originMember === undefined),
                run: () => this.actions.setVisible(selected, visible),
            });
        }
        if (
            this.actions.editable &&
            selected.every((item) => item.node?.parent && item.originMember === undefined)
        )
            menu.push({
                label: "common.delete",
                icon: "icon-delete",
                danger: true,
                run: () => this.actions.delete(selected),
            });
        if (entry.node || entry.type === "settings" || entry.type === "units")
            menu.push({
                label: "browser.properties",
                run: () => {
                    if (entry.type === "document" || !entry.node)
                        PubSub.default.pub("showProjectProperties", this.document);
                    else PubSub.default.pub("showProperties", this.document, [entry.node]);
                },
            });
        if (menu.length) showContextMenu({ x: event.clientX, y: event.clientY }, menu);
    }

    private readonly onKeyDown = (event: KeyboardEvent) => {
        const index = this.flat.findIndex((row) => row.entry.key === this.focusKey);
        const entry = this.flat[Math.max(0, index)]?.entry;
        if (!entry) return;
        let next = index;
        switch (event.key) {
            case "ArrowDown":
                next = Math.min(this.flat.length - 1, index + 1);
                break;
            case "ArrowUp":
                next = Math.max(0, index - 1);
                break;
            case "Home":
                next = 0;
                break;
            case "End":
                next = this.flat.length - 1;
                break;
            case "ArrowRight":
                if (entry.children.length && !this.isExpanded(entry)) this.toggle(entry);
                else next = Math.min(this.flat.length - 1, index + 1);
                break;
            case "ArrowLeft":
                if (entry.children.length && this.isExpanded(entry)) this.toggle(entry);
                else next = this.flat.findIndex((row) => row.entry.key === entry.parentKey);
                break;
            case "F2":
                this.rename(entry);
                break;
            case "Enter":
                this.open(entry);
                break;
            case " ":
                this.select(entry, event);
                break;
            case "Delete":
                this.actions.delete(
                    [...this.selected].map((key) => this.model.entries.get(key)!).filter(Boolean),
                );
                break;
            default:
                return;
        }
        event.preventDefault();
        event.stopPropagation();
        if (next >= 0 && next !== index && this.flat[next]) {
            this.focusKey = this.flat[next].entry.key;
            this.reveal(this.focusKey);
        }
    };
    private dragEntries(): BrowserEntry[] {
        return this.dragKeys.map((key) => this.model.entries.get(key)!).filter(Boolean);
    }
    private readonly onDragEnd = () => {
        this.dragKeys = [];
        for (const row of this.rows.values()) row.classList.remove(style.dropTarget);
    };
}

customElements.define("spicy-browser", Browser);
