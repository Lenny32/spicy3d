// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { FolderNode, type IDocument, type INodeLinkedList } from "@spicy3d/core";
import { div, setSVGIcon, svg } from "@spicy3d/element";
import { TreeItem } from "./treeItem";
import style from "./treeItemGroup.module.css";

export class TreeGroup extends TreeItem {
    private _isExpanded = true;
    readonly header: HTMLElement;
    readonly items: HTMLDivElement = div({ className: `${style.container} ${style.left16px}` });
    readonly expanderIcon: SVGSVGElement;
    /** A row kept above every child node (the project's Project Properties row). */
    private pinned: HTMLElement | undefined;

    constructor(document: IDocument, node: INodeLinkedList) {
        super(document, node);
        this.expanderIcon = this.createExpanderIcon(node);
        const typeIcon = this.createTypeIcon();
        this.header = div(
            { className: `${style.row} ${style.header}` },
            this.expanderIcon,
            ...(typeIcon === undefined ? [] : [typeIcon]),
            this.name,
            this.componentSwatch,
            this.visibleIcon,
            this.warningBadge,
        );
        super.append(this.createRootContainer());
        this.refreshExpander();
    }

    private createExpanderIcon(node: INodeLinkedList): SVGSVGElement {
        // A parametric body is a linked list of consumed boolean tools, not a folder —
        // give its expander a distinct, muted look.
        const expanderClass =
            node instanceof FolderNode
                ? style.expanderIcon
                : `${style.expanderIcon} ${style.toolExpanderIcon}`;
        return svg({
            icon: this.getExpanderIcon(),
            className: expanderClass,
            onclick: this.handleExpanderClick,
        });
    }

    private createRootContainer(): HTMLDivElement {
        return div({ className: style.container }, this.header, this.items);
    }

    /** Folders always show the expander; a body shows it only with tools inside. */
    refreshExpander() {
        const hide =
            !(this.node instanceof FolderNode) && (this.node as INodeLinkedList).firstChild === undefined;
        this.expanderIcon.classList.toggle(style.hide, hide);
    }

    get isExpanded(): boolean {
        return this._isExpanded;
    }

    set isExpanded(value: boolean) {
        this._isExpanded = value;
        setSVGIcon(this.expanderIcon, this.getExpanderIcon());
        this.items.classList.toggle(style.hide, !this._isExpanded);
    }

    mainElement(): HTMLElement {
        return this.header;
    }

    override dispose() {
        super.dispose();
        this.header.remove();
        this.expanderIcon.removeEventListener("click", this.handleExpanderClick);
    }

    private readonly handleExpanderClick = (e: MouseEvent) => {
        e.stopPropagation();
        this.isExpanded = !this._isExpanded;
    };

    private getExpanderIcon() {
        return this._isExpanded ? "icon-angle-down" : "icon-angle-right";
    }

    override appendChild<T extends Node>(node: T): T {
        this.items.appendChild(node);
        return node;
    }

    override append(...nodes: Node[]): void {
        this.items.append(...nodes);
    }

    override removeChild<T extends Node>(child: T): T {
        if (child.parentNode === this.items) this.items.removeChild(child);
        return child;
    }

    addItem(...items: Node[]) {
        this.items.append(...items);
        return this;
    }

    /** Keeps `element` as the first row: a node inserted "first" lands right after it. */
    pinFirst(element: HTMLElement): void {
        this.pinned = element;
        this.items.prepend(element);
    }

    insertAfter(item: TreeItem, child: TreeItem | null): void {
        const first =
            this.pinned?.parentNode === this.items ? this.pinned.nextSibling : this.items.firstChild;
        const referenceNode = child ? child.nextSibling : first;
        this.items.insertBefore(item, referenceNode);
    }
}

customElements.define("tree-group", TreeGroup);
