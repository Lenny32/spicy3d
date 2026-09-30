// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IDocument } from "./document";
import {
    type CollectionChangedArgs,
    Logger,
    NodeLinkedListHistoryRecord,
    type NodeRecord,
    Observable,
    ObservableCollection,
    Transaction,
} from "./foundation";
import { type Material, PhongMaterial } from "./material";
import type { Component } from "./model/component";
import { FolderNode } from "./model/folderNode";
import { type INode, type INodeLinkedList, NodeUtils } from "./model/node";
import { UnknownNode } from "./model/unknownNode";
import { PerformanceTrace } from "./performanceTrace";
import { InternalClassName, type Serialized, Serializer } from "./serialize";

/** JSON with object keys sorted: equal for equal records whatever their key order. */
function canonicalJson(value: unknown): string {
    return JSON.stringify(value, (_key, item) =>
        item && typeof item === "object" && !Array.isArray(item)
            ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
            : item,
    );
}

export type OnNodeChanged = (records: NodeRecord[]) => void;

/** The material reference a node carries, if any — both `GeometryNode` and `MeshNode` have one. */
function materialIdOf(node: INode): string | string[] | undefined {
    return (node as { materialId?: string | string[] }).materialId;
}

/** A node's material reference as a list; a missing one contributes nothing. */
function materialIdsOf(materialId: string | string[] | undefined): readonly string[] {
    if (materialId === undefined) return [];
    return Array.isArray(materialId) ? materialId : [materialId];
}

export interface PreparedModelGraph {
    readonly root: INodeLinkedList;
    /** Adopt the validated root without notifications; caller publishes all documents in one turn. */
    adopt(): void;
    rollbackAdoption(): void;
    /** Re-enters candidate lookup without publishing a node or touching the live tree. */
    run<T>(action: () => T): T;
    dispose(): void;
}

export class ModelManager extends Observable {
    private preparingRecovery = false;
    get isPreparingRecovery(): boolean {
        return this.preparingRecovery;
    }

    /** Candidate nodes are bound to this document; validation temporarily sees their own graph. */
    prepareRecoveryNodes(nodes: Serialized[], validate: () => void): PreparedModelGraph {
        let root: INodeLinkedList | undefined;
        let disposed = false;
        let adopted = false;
        const previousPublishedRoot = this._rootNode;
        const previousCurrentNode = this._currentNode;
        const constructed: INode[] = [];
        const run = <T>(action: () => T): T => {
            if (disposed) throw new Error("Recovery candidate has been disposed");
            const previousRoot = this._rootNode;
            const previousPreparing = this.preparingRecovery;
            const previousDeserializing = this._deserializing;
            const previousDisabled = this.document.history.disabled;
            try {
                this.preparingRecovery = true;
                this._deserializing = true;
                this.document.history.disabled = true;
                if (root) this._rootNode = root;
                const result = action();
                if (result && typeof result === "object" && "then" in result)
                    throw new Error("Recovery preparation must be synchronous");
                return result;
            } finally {
                this._rootNode = previousRoot;
                this.preparingRecovery = previousPreparing;
                this._deserializing = previousDeserializing;
                this.document.history.disabled = previousDisabled;
            }
        };
        const dispose = () => {
            if (disposed || adopted) return;
            run(() => {
                for (const node of constructed) node.dispose();
            });
            disposed = true;
        };
        try {
            run(() => {
                root = NodeUtils.deserializeNodeSync(
                    this.document,
                    structuredClone(nodes),
                    (doc, data) => new UnknownNode(doc, data),
                    (node) => {
                        constructed.push(node);
                        if (constructed.length === 1 && NodeUtils.isLinkedListNode(node)) {
                            root = node;
                            this._rootNode = root;
                        }
                    },
                );
                if (!root) throw new Error("Recovery checkpoint has no root node");
                this._rootNode = root;
                const validation: unknown = validate();
                if (validation && typeof validation === "object" && "then" in validation)
                    throw new Error("Recovery validation must be synchronous");
            });
        } catch (error) {
            dispose();
            throw error;
        }
        return {
            root: root!,
            run,
            dispose,
            rollbackAdoption: () => {
                if (!adopted) return;
                this._rootNode = previousPublishedRoot;
                this._currentNode = previousCurrentNode;
                adopted = false;
            },
            adopt: () => {
                if (disposed) throw new Error("Recovery candidate has been disposed");
                if (adopted) return;
                this._rootNode = root!;
                this._currentNode = undefined;
                adopted = true;
            },
        };
    }

    /** Publish replacement after every open document has adopted and the fresh kernel is active. */
    notifyRecoveryReplacement(previousRoot: INodeLinkedList): void {
        previousRoot.removePropertyChanged(this.handleRootNodeNameChanged);
        this.rootNode.onPropertyChanged(this.handleRootNodeNameChanged);
        this.notifyNodeChanged([
            { node: previousRoot, action: "remove" },
            { node: this.rootNode, action: "add" },
        ]);
    }

    /** Dispose detached old nodes without removing newly published visuals with the same stable IDs. */
    disposeRecoveryRoot(root: INodeLinkedList): void {
        const previous = this.preparingRecovery;
        this.preparingRecovery = true;
        try {
            root.dispose();
        } finally {
            this.preparingRecovery = previous;
        }
    }

    private readonly _nodeChangedObservers = new Set<OnNodeChanged>();
    private _deserializing = false;
    /** Records collected while {@link applyContent} runs, dispatched once when it is done. */
    private _batch: NodeRecord[] | undefined;

    private readonly _components = new ObservableCollection<Component>();
    private readonly _materials = new ObservableCollection<Material>();
    private recoveryComponents?: ObservableCollection<Component>;
    private recoveryMaterials?: ObservableCollection<Material>;
    get components(): ObservableCollection<Component> {
        return this.recoveryComponents ?? this._components;
    }
    get materials(): ObservableCollection<Material> {
        return this.recoveryMaterials ?? this._materials;
    }

    withRecoveryCollections<T>(
        components: readonly Component[],
        materials: readonly Material[],
        action: () => T,
    ): T {
        const previousComponents = this.recoveryComponents;
        const previousMaterials = this.recoveryMaterials;
        const stagedComponents = new ObservableCollection<Component>();
        const stagedMaterials = new ObservableCollection<Material>();
        stagedComponents.push(...components);
        stagedMaterials.push(...materials);
        try {
            this.recoveryComponents = stagedComponents;
            this.recoveryMaterials = stagedMaterials;
            return action();
        } finally {
            this.recoveryComponents = previousComponents;
            this.recoveryMaterials = previousMaterials;
        }
    }

    private _rootNode: INodeLinkedList | undefined;
    get rootNode(): INodeLinkedList {
        if (this._rootNode === undefined) {
            this._rootNode = this.initRootNode();
        }
        return this._rootNode;
    }
    set rootNode(value: INodeLinkedList) {
        if (this._rootNode === value) return;

        this._rootNode?.removePropertyChanged(this.handleRootNodeNameChanged);
        this._rootNode = value ?? new FolderNode({ document: this.document, name: this.document.name });
        this._rootNode.onPropertyChanged(this.handleRootNodeNameChanged);
    }

    private _currentNode?: INodeLinkedList;
    get currentNode(): INodeLinkedList | undefined {
        return this._currentNode;
    }
    set currentNode(value: INodeLinkedList | undefined) {
        this.setProperty("currentNode", value);
    }

    constructor(readonly document: IDocument) {
        super();
        this.rootNode = this.initRootNode();
        this.materials.onCollectionChanged(this.handleMaterialChanged);
        this.components.onCollectionChanged(this.handleComponentChanged);
    }

    private readonly handleRootNodeNameChanged = (prop: string) => {
        if (prop === "name") {
            this.document.name = this.rootNode.name;
        }
    };

    initRootNode() {
        return new FolderNode({ document: this.document, name: this.document.name });
    }

    addNodeObserver(observer: OnNodeChanged) {
        this._nodeChangedObservers.add(observer);
    }

    removeNodeObserver(observer: OnNodeChanged) {
        this._nodeChangedObservers.delete(observer);
    }

    notifyNodeChanged(records: NodeRecord[]) {
        if (this._deserializing) return;
        if (this._batch !== undefined) {
            this._batch.push(...records);
            return;
        }
        Transaction.add(this.document, new NodeLinkedListHistoryRecord(records));
        this._nodeChangedObservers.forEach((x) => {
            x(records);
        });
    }

    addNode(...nodes: INode[]): void {
        (this.currentNode ?? this.rootNode).add(...nodes);
    }

    findNode(predicate: (value: INode) => boolean) {
        if (!this._rootNode) return undefined;

        return NodeUtils.findNode(this._rootNode, predicate);
    }

    findNodes(predicate?: (value: INode) => boolean) {
        if (!this._rootNode) return [];

        return NodeUtils.findNodes(this._rootNode, predicate);
    }

    serialize() {
        return {
            components: this.components.map((x) => Serializer.serializeObject(x)),
            nodes: NodeUtils.serializeNode(this.rootNode),
            materials: this.materials.map((x) => Serializer.serializeObject(x)),
        };
    }

    async deserialize(data: { components: Serialized[]; nodes: Serialized[]; materials: Serialized[] }) {
        this.materials.push(
            ...data.materials.map((x: Serialized) => Serializer.deserializeObject(this.document, x)),
        );

        this.components.push(
            ...data.components.map((x: Serialized) => Serializer.deserializeObject(this.document, x)),
        );

        // Defer node notifications until the new tree replaces rootNode: displaying a
        // node mid-load can generate shapes that reference other nodes (e.g. a
        // parametric body referencing a sketch), which findNode cannot reach while
        // _rootNode is still the old root.
        this._deserializing = true;
        const span = PerformanceTrace.enabled
            ? PerformanceTrace.begin("model.deserialize", { nodeCount: data.nodes.length })
            : undefined;
        try {
            const rootNode = await NodeUtils.deserializeNode(
                this.document,
                data.nodes,
                (document, node) => new UnknownNode(document, node),
            );
            this.rootNode = rootNode!;
            this.ensureMaterials();
        } finally {
            this._deserializing = false;
            if (PerformanceTrace.enabled) PerformanceTrace.end(span);
        }
        this.notifyNodeChanged([{ action: "add", node: this.rootNode }]);
    }

    /**
     * Makes the model equal to `data` (the `models` of a serialized document), changing only what
     * differs: a node whose serialized form (and parent) is unchanged stays the same object, in
     * place or moved to its new position; the others are removed or created. Views and the camera
     * are untouched. Observers hear one batched notification, once the tree is in its final state
     * — a body referencing a replaced sketch re-evaluates against the new one, never a half-applied
     * tree. The records join the open transaction like any edit.
     */
    applyContent(data: { components?: Serialized[]; nodes: Serialized[]; materials?: Serialized[] }): void {
        this.applyRecords(this.materials, data.materials ?? []);
        this.applyRecords(this.components, data.components ?? []);

        const current = new Map<string, { node: INode; record: string }>();
        const walk = (node: INode, parentId: string | undefined) => {
            const record: Serialized = Serializer.serializeObject(node);
            if (parentId !== undefined) (record as Record<string, unknown>)["parentId"] = parentId;
            current.set(node.id, { node, record: canonicalJson(record) });
            if (!NodeUtils.isLinkedListNode(node)) return;
            for (let child = node.firstChild; child !== undefined; child = child.nextSibling)
                walk(child, node.id);
        };
        walk(this.rootNode, undefined);

        const target = data.nodes;
        const rootId = this.rootNode.id;
        const kept = new Set<string>([rootId]);
        for (const record of target.slice(1)) {
            const id = record["id"] as string;
            const parentId = record["parentId"] as string | undefined;
            const existing = current.get(id);
            if (
                existing &&
                parentId !== undefined &&
                kept.has(parentId) &&
                existing.record === canonicalJson(record)
            ) {
                kept.add(id);
            }
        }
        const targetRoot = target[0]?.["id"];
        // the root is kept (views and the tree hold it); its own properties follow the record
        const rootRecord = target[0] as Record<string, unknown> | undefined;
        if (typeof rootRecord?.["name"] === "string" && this.rootNode.name !== rootRecord["name"]) {
            this.rootNode.name = rootRecord["name"];
        }
        if (typeof rootRecord?.["visible"] === "boolean" && this.rootNode.visible !== rootRecord["visible"]) {
            this.rootNode.visible = rootRecord["visible"];
        }
        const parentOf = (record: Serialized) => {
            const parentId = record["parentId"] as string | undefined;
            return parentId === targetRoot ? rootId : parentId;
        };

        this._batch = [];
        try {
            // Removed or replaced nodes first (their subtrees hold no kept node): ids never repeat.
            for (const [id, { node }] of current) {
                if (kept.has(id) || id === rootId) continue;
                const parent = node.parent;
                if (parent !== undefined && kept.has(parent.id)) parent.remove(node);
            }
            if (this._currentNode !== undefined && !kept.has(this._currentNode.id))
                this.currentNode = undefined;
            // Then every node in pre-order after the previous sibling it has in `data`.
            const live = new Map<string, INode>([[rootId, this.rootNode]]);
            for (const id of kept) live.set(id, current.get(id)!.node);
            const lastChild = new Map<string, INode | undefined>();
            for (const record of target.slice(1)) {
                const id = record["id"] as string;
                let parent = live.get(parentOf(record) ?? rootId) as INodeLinkedList | undefined;
                if (parent === undefined || !NodeUtils.isLinkedListNode(parent)) {
                    // a record out of pre-order, or under a node that holds no children: kept, at the root
                    Logger.warn(
                        `applyContent: ${id} has no usable parent ${String(record["parentId"])}, put at the root`,
                    );
                    parent = this.rootNode;
                }
                const previous = lastChild.get(parent.id);
                let node = kept.has(id) ? live.get(id)! : undefined;
                if (node !== undefined) {
                    if (node.previousSibling !== previous) parent.move(node, parent, previous);
                } else {
                    node = Serializer.isRegistered(record[InternalClassName])
                        ? (Serializer.deserializeObject(this.document, record) as INode)
                        : new UnknownNode(this.document, record);
                    parent.insertAfter(previous, node);
                    live.set(id, node);
                }
                lastChild.set(parent.id, node);
            }
        } finally {
            const records = this._batch;
            this._batch = undefined;
            if (records.length > 0) this.notifyNodeChanged(records);
        }
        this.ensureMaterials();
    }

    /** Materials / components by id: unchanged ones kept, the others removed or created. */
    private applyRecords<T extends { id: string }>(
        collection: ObservableCollection<T>,
        records: Serialized[],
    ) {
        const wanted = new Map(records.map((record) => [record["id"] as string, canonicalJson(record)]));
        const stale = collection.filter(
            (item) => wanted.get(item.id) !== canonicalJson(Serializer.serializeObject(item as object)),
        );
        if (stale.length > 0) collection.remove(...stale);
        const kept = new Set(collection.map((item) => item.id));
        const added = records
            .filter((record) => !kept.has(record["id"] as string))
            .map((record) => Serializer.deserializeObject(this.document, record) as T);
        if (added.length > 0) collection.push(...added);
    }

    /**
     * Fills in the materials a loaded document references but its `materials` list no longer
     * holds, so rendering does not throw `Material not found` — the node tree and the material
     * list are separate arrays, and an interrupted or hand-edited save can leave them out of step.
     *
     * The placeholder keeps the referenced id, so every node resolves; it is a grey
     * `PhongMaterial` the user can restyle.
     */
    private ensureMaterials() {
        const known = new Set(this.materials.map((x) => x.id));
        const backfill = (materialId: string | string[] | undefined) => {
            for (const id of materialIdsOf(materialId)) {
                // An empty id is "nothing assigned" — the `GeometryNode` default when the
                // document had no materials yet — not a reference to repair. Backfilling it
                // would write a nameless material into every later save.
                if (id === "" || known.has(id)) continue;
                known.add(id);
                this.materials.push(
                    new PhongMaterial({ id, document: this.document, name: "replaced", color: 0xaaaaaa }),
                );
            }
        };

        // The nodes a component owns hang off the component, not off the linked-list tree,
        // so both walks are needed to cover everything that can carry a `materialId`.
        for (const node of NodeUtils.children(this.rootNode)) backfill(materialIdOf(node));
        for (const component of this.components) {
            for (const node of component.nodes) backfill(materialIdOf(node));
        }
    }

    override disposeInternal(): void {
        super.disposeInternal();
        this._nodeChangedObservers.clear();
        this.materials.removeCollectionChanged(this.handleMaterialChanged);
        this.components.removeCollectionChanged(this.handleComponentChanged);
        this._rootNode?.removePropertyChanged(this.handleRootNodeNameChanged);
        this._rootNode?.dispose();
        this.materials.forEach((x) => x.dispose());
        this.materials.clear();
        this._rootNode = undefined;
        this._currentNode = undefined;
    }

    private readonly handleMaterialChanged = (args: CollectionChangedArgs) => {
        if (args.action === "add") {
            Transaction.add(this.document, {
                name: "MaterialChanged",
                dispose() {},
                undo: () => this.materials.remove(...args.items),
                redo: () => this.materials.push(...args.items),
            });
        } else if (args.action === "remove") {
            Transaction.add(this.document, {
                name: "MaterialChanged",
                dispose() {},
                undo: () => this.materials.push(...args.items),
                redo: () => this.materials.remove(...args.items),
            });
        }
    };

    private readonly handleComponentChanged = (args: CollectionChangedArgs) => {
        if (args.action === "add") {
            Transaction.add(this.document, {
                name: "ComponentChanged",
                dispose() {},
                undo: () => this.components.remove(...args.items),
                redo: () => this.components.push(...args.items),
            });
        } else if (args.action === "remove") {
            Transaction.add(this.document, {
                name: "ComponentChanged",
                dispose() {},
                undo: () => this.components.push(...args.items),
                redo: () => this.components.remove(...args.items),
            });
        }
    };
}
