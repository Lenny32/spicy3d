// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    FolderNode,
    type IDisposable,
    type IDocument,
    type INode,
    type ISelection,
    ShapeTypes,
    Signal,
    VisualNode,
    type VisualShapeData,
    type VisualState,
    VisualStates,
} from "@spicy3d/core";

export class SelectionManager implements ISelection, IDisposable {
    readonly onNodeChanged = new Signal<(selected: INode[]) => void>();
    readonly onShapeChanged = new Signal<(selected: VisualShapeData[]) => void>();

    private readonly selectedSet = new Set<INode>();
    private selectedShapeSet = [] as [VisualShapeData, VisualState][];
    private readonly highlightedNodes = new Set<VisualNode>();
    private readonly watchedNodes = new Set<INode>();

    constructor(readonly document: IDocument) {
        document.modelManager.addNodeObserver(this.refreshNodeHighlights);
    }

    private readonly refreshNodeHighlights = () => {
        const desired = new Set<VisualNode>();
        const watched = new Set<INode>();
        const pending = [...this.selectedSet];
        while (pending.length) {
            const node = pending.pop()!;
            watched.add(node);
            if (node instanceof FolderNode) pending.push(...node.children());
            else if (node instanceof VisualNode && node.visible && node.parentVisible) desired.add(node);
        }
        for (const node of this.watchedNodes)
            if (!watched.has(node)) node.removePropertyChanged(this.onHighlightPropertyChanged);
        for (const node of watched)
            if (!this.watchedNodes.has(node)) node.onPropertyChanged(this.onHighlightPropertyChanged);
        this.watchedNodes.clear();
        for (const node of watched) this.watchedNodes.add(node);
        for (const node of this.highlightedNodes) {
            if (desired.has(node)) continue;
            const visual = this.document.visual.context.getVisual(node);
            if (visual)
                this.document.visual.highlighter.removeState(
                    visual,
                    VisualStates.edgeSelected,
                    ShapeTypes.shape,
                );
        }
        for (const node of desired) {
            if (this.highlightedNodes.has(node)) continue;
            const visual = this.document.visual.context.getVisual(node);
            if (visual)
                this.document.visual.highlighter.addState(
                    visual,
                    VisualStates.edgeSelected,
                    ShapeTypes.shape,
                );
        }
        this.highlightedNodes.clear();
        for (const node of desired) this.highlightedNodes.add(node);
    };
    private readonly onHighlightPropertyChanged = (property: string) => {
        if (property === "visible" || property === "parentVisible") this.refreshNodeHighlights();
    };

    setSelectedNodes(nodes: INode[], toggle: boolean): number {
        if (toggle) {
            const selected = nodes.filter((m) => this.selectedSet.has(m));
            const unSelected = nodes.filter((m) => !this.selectedSet.has(m));
            this.removeSelectedNodes(selected, false);
            this.addSelectedNode(unSelected, true);
        } else {
            this.removeSelectedNodes(this.selectedSet, false);
            this.addSelectedNode(nodes, true);
        }
        this.document.visual.update();
        return this.selectedSet.size;
    }

    getSelectedNodes(): INode[] {
        return Array.from(this.selectedSet);
    }

    getSelectedVisualNodes(): VisualNode[] {
        return Array.from(
            this.selectedSet
                .values()
                .filter((x): x is VisualNode => x instanceof VisualNode && !x.isTransient),
        );
    }

    getSelectedNodeLength(): number {
        return this.selectedSet.size;
    }

    setSelectedShapes(shapes: VisualShapeData[], selectedState: VisualState, toggle: boolean): number {
        if (toggle) {
            const toRemove = this.selectedShapeSet.filter((x) =>
                shapes.some((s) => SelectionManager.isSameShapeData(s, x[0])),
            );
            const toAdd = shapes.filter(
                (s) => !toRemove.some((x) => SelectionManager.isSameShapeData(s, x[0])),
            );
            this.removeSelectedShapes(toRemove, false);
            this.addSelectedShapes(toAdd, selectedState, true);
        } else {
            this.removeSelectedShapes(this.selectedShapeSet, false);
            this.addSelectedShapes(shapes, selectedState, true);
        }
        this.document.visual.update();
        return this.selectedShapeSet.length;
    }

    getSelectedShapes(): VisualShapeData[] {
        return Array.from(this.selectedShapeSet).map((x) => x[0]);
    }

    /**
     * Cloned nodes share the same shape id (serialization preserves it), so identity
     * must include the owner visual and sub-shape indexes, not just the shape id.
     */
    private static isSameShapeData(a: VisualShapeData, b: VisualShapeData): boolean {
        return (
            a.owner === b.owner &&
            a.shape.id === b.shape.id &&
            a.indexes.length === b.indexes.length &&
            a.indexes.every((v, i) => v === b.indexes[i])
        );
    }

    clearSelection(): void {
        this.removeSelectedNodes(this.selectedSet, this.selectedSet.size > 0);
        this.removeSelectedShapes(this.selectedShapeSet, this.selectedShapeSet.length > 0);
        this.selectedShapeSet.length = 0;
        this.selectedSet.clear();
        this.document.visual.update();
    }

    private addSelectedShapes(shapes: VisualShapeData[], selectedState: VisualState, publish: boolean) {
        for (const shape of shapes) {
            this.document.visual.highlighter.addState(
                shape.owner,
                selectedState,
                shape.shape.shapeType,
                ...shape.indexes,
            );
            this.selectedShapeSet.push([shape, selectedState]);
        }
        if (publish) this.onShapeChanged.emit(this.selectedShapeSet.map((x) => x[0]));
    }

    private removeSelectedShapes(selected: Array<[VisualShapeData, VisualState]>, publish: boolean): void {
        for (const [s, state] of selected) {
            this.document.visual.highlighter.removeState(s.owner, state, s.shape.shapeType, ...s.indexes);
        }
        this.selectedShapeSet = this.selectedShapeSet.filter((x) => !selected.includes(x));
        if (publish) this.onShapeChanged.emit(this.selectedShapeSet.map((x) => x[0]));
    }

    private addSelectedNode(nodes: INode[], publish: boolean): void {
        for (const node of nodes) {
            this.selectedSet.add(node);
        }
        this.refreshNodeHighlights();
        if (publish) this.onNodeChanged.emit(Array.from(this.selectedSet));
    }

    private removeSelectedNodes(nodes: INode[] | Set<INode>, publish: boolean): void {
        for (const node of nodes) {
            this.selectedSet.delete(node);
        }
        this.refreshNodeHighlights();
        if (publish) this.onNodeChanged.emit(Array.from(this.selectedSet));
    }

    dispose(): void {
        this.clearSelection();
        this.document.modelManager.removeNodeObserver(this.refreshNodeHighlights);
        this.onNodeChanged.dispose();
        this.onShapeChanged.dispose();
    }
}
