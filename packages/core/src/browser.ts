// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { ConstructionNode } from "./construction/node";
import type { ConstructionDefinition, ConstructionRef } from "./construction/types";
import type { IDocument } from "./document";
import { DocumentMutations } from "./documentMutations";
import { type IEqualityComparer, type NodeRecord, PubSub, Signal, Transaction } from "./foundation";
import type { I18nKeys } from "./i18n";
import { Matrix4, XYZ } from "./math";
import { ComponentNode } from "./model/component";
import { FolderNode, isConsumedTool } from "./model/folderNode";
import { GroupNode } from "./model/groupNode";
import { MeshNode } from "./model/meshNode";
import { type INode, NodeUtils } from "./model/node";
import { ShapeNode } from "./model/shapeNode";
import { VisualNode } from "./model/visualNode";
import { ShapeTypes } from "./shape";
import { documentLengthUnit } from "./units/projectSettings";
import type { Act } from "./visual/act";

export type BrowserDescription = {
    type: string;
    category: string;
    icon: string;
    editLabel?: I18nKeys;
    edit?: (node: INode) => void;
};

/** Modules describe their objects without coupling the Browser to geometry implementations. */
export interface IBrowserProvider {
    describe(node: INode): BrowserDescription | undefined;
}

export const BrowserProviders = {
    changed: new Signal<() => void>(),
    items: new Set<IBrowserProvider>(),
    register(provider: IBrowserProvider): () => void {
        this.items.add(provider);
        this.changed.emit();
        return () => {
            this.items.delete(provider);
            this.changed.emit();
        };
    },
};

export type BrowserEntry = {
    key: string;
    parentKey?: string;
    type: string;
    name: string;
    label?: I18nKeys;
    icon: string;
    children: string[];
    owner?: FolderNode;
    node?: INode;
    view?: Act;
    preset?: "front" | "top" | "right" | "home";
    originMember?: number;
    description?: BrowserDescription;
};

const CATEGORY_LABELS: Record<string, I18nKeys> = {
    bodies: "browser.bodies",
    sketches: "browser.sketches",
    construction: "browser.construction",
    objects: "browser.objects",
};

/** A detached visual reference: changing its display state never edits document history. */
class RuntimeOriginNode extends ConstructionNode {
    override get isTransient(): boolean {
        return true;
    }
    override get reference(): ConstructionRef {
        const member = Number(this.id.split(":").at(-1));
        if (member >= 4) return { kind: "origin-plane", plane: (["XY", "ZX", "YZ"] as const)[member - 4] };
        return { kind: "fixed", geometry: this.geometry.unchecked()! };
    }
    protected override setProperty<K extends keyof this>(
        property: K,
        value: this[K],
        changed?: (property: K, oldValue: this[K]) => void,
        comparer?: IEqualityComparer<this[K]>,
    ): boolean {
        if (property !== "visible" && property !== "parentVisible") return false;
        const previous = this[property];
        if (comparer ? comparer.equals(previous, value) : previous === value) return false;
        this.setPrivateValue(property, value);
        changed?.(property, previous);
        this.emitPropertyChanged(property, previous);
        return true;
    }
}

function describe(node: INode): BrowserDescription {
    for (const provider of BrowserProviders.items) {
        const description = provider.describe(node);
        if (description) return description;
    }
    if (node instanceof ComponentNode)
        return { type: "instance", category: "components", icon: "icon-group" };
    if (node instanceof ConstructionNode) {
        return { type: node.definition.kind, category: "construction", icon: node.icon };
    }
    if (node instanceof MeshNode) return { type: "mesh", category: "bodies", icon: "icon-shape" };
    if (node instanceof ShapeNode) {
        const shapeType = node.resolvedShape?.shapeType;
        const surface = shapeType === ShapeTypes.shell || shapeType === ShapeTypes.face;
        return { type: surface ? "surface" : "solid", category: "bodies", icon: node.icon };
    }
    return { type: "object", category: "objects", icon: "icon" in node ? String(node.icon) : "icon-shape" };
}

function containerTransform(node: INode | undefined): Matrix4 {
    const ancestors: GroupNode[] = [];
    for (let current = node; current; current = current.parent)
        if (current instanceof GroupNode) ancestors.push(current);
    let result = Matrix4.identity();
    for (const ancestor of ancestors.reverse()) result = result.multiply(ancestor.transform);
    return result;
}

/** Document-owned, disposable runtime projection. None of its entries are serialized. */
export class BrowserModel {
    readonly changed = new Signal<() => void>();
    readonly entries = new Map<string, BrowserEntry>();
    readonly nodeKeys = new Map<INode, string>();
    readonly origins = new Map<string, ConstructionNode>();
    private readonly watched = new Set<INode>();
    private readonly watchedViews = new Set<Act>();
    private readonly viewKeys = new WeakMap<Act, string>();
    private nextViewId = 0;
    rootKey = "";

    constructor(readonly document: IDocument) {
        this.reconcile();
        document.modelManager.addNodeObserver(this.onStructureChanged);
        document.modelManager.onPropertyChanged(this.onManagerChanged);
        document.onPropertyChanged(this.onDocumentChanged);
        document.settings?.onPropertyChanged(this.onSettingsChanged);
        document.acts.onCollectionChanged(this.onViewsChanged);
        BrowserProviders.changed.sub(this.onProvidersChanged);
    }

    get activeKey(): string {
        return this.document.modelManager.currentNode?.id ?? this.document.modelManager.rootNode.id;
    }

    private put(entry: BrowserEntry): BrowserEntry {
        const existing = this.entries.get(entry.key);
        if (existing?.node && existing.node !== entry.node) {
            existing.node.removePropertyChanged(this.onNodeChanged);
            this.watched.delete(existing.node);
            this.nodeKeys.delete(existing.node);
        }
        if (existing) Object.assign(existing, entry);
        else this.entries.set(entry.key, entry);
        if (entry.node) {
            this.nodeKeys.set(entry.node, entry.key);
            if (!this.watched.has(entry.node)) {
                this.watched.add(entry.node);
                entry.node.onPropertyChanged(this.onNodeChanged);
            }
        }
        return existing ?? entry;
    }

    private container(owner: FolderNode, parentKey?: string): BrowserEntry {
        const root = owner === this.document.modelManager.rootNode;
        return this.put({
            key: owner.id,
            parentKey,
            type: root ? "document" : "component",
            name: owner.name,
            icon: "icon-group",
            children: this.entries.get(owner.id)?.children ?? [],
            node: owner,
            owner,
        });
    }

    private fillContainer(owner: FolderNode): FolderNode[] {
        const entry = this.entries.get(owner.id)!;
        const children: string[] = [];
        const virtual = (suffix: string, type: string, label: I18nKeys, icon = "icon-folder") => {
            const key = `${owner.id}:${suffix}`;
            const item = this.put({
                key,
                parentKey: owner.id,
                type,
                name: "",
                label,
                icon,
                children: [],
                owner,
            });
            children.push(key);
            return item;
        };
        if (owner === this.document.modelManager.rootNode) {
            const settings = virtual("settings", "settings", "browser.settings", "icon-cog");
            const key = `${owner.id}:units`;
            this.put({
                key,
                parentKey: settings.key,
                type: "units",
                name: `Units: ${documentLengthUnit(this.document)}`,
                icon: "icon-cog",
                children: [],
                owner,
            });
            settings.children = [key];
            const views = virtual("views", "views", "browser.views");
            views.children = this.viewEntries(views.key);
        }
        const origin = virtual("origin", "origin", "browser.origin", "icon-ucs");
        const names = ["Origin Point", "X Axis", "Y Axis", "Z Axis", "XY Plane", "XZ Plane", "YZ Plane"];
        origin.children = names.map((name, index) => {
            const key = `${owner.id}:origin:${index}`;
            this.put({
                key,
                parentKey: origin.key,
                type: "originMember",
                name,
                owner,
                node: this.origins.get(key),
                originMember: index,
                children: [],
                icon:
                    index === 0
                        ? "icon-constructionPoint"
                        : index < 4
                          ? "icon-constructionAxis"
                          : "icon-constructionPlane",
            });
            return key;
        });
        const categories = new Map<string, BrowserEntry[]>();
        const components: FolderNode[] = [];
        const instances: BrowserEntry[] = [];
        for (const node of owner.children()) {
            if (node instanceof FolderNode) {
                components.push(node);
                this.container(node, owner.id);
                continue;
            }
            const description = describe(node);
            const item = this.put({
                key: node.id,
                parentKey: owner.id,
                type: description.type,
                name: node.name,
                node,
                owner,
                icon: description.icon,
                description,
                children: [],
            });
            if (description.category === "components") instances.push(item);
            else {
                const items = categories.get(description.category) ?? [];
                items.push(item);
                categories.set(description.category, items);
            }
        }
        const order = [...new Set(["bodies", "sketches", "construction", ...categories.keys()])];
        for (const category of order) {
            const items = categories.get(category);
            if (!items?.length) continue;
            const folder = virtual(
                `category:${category}`,
                "category",
                CATEGORY_LABELS[category] ?? "browser.objects",
            );
            folder.description = { type: "category", category, icon: "icon-folder" };
            folder.children = items.map((item) => {
                item.parentKey = folder.key;
                return item.key;
            });
        }
        children.push(...components.map((node) => node.id), ...instances.map((item) => item.key));
        entry.children = children;
        return components;
    }

    private viewEntries(parentKey: string): string[] {
        const presets = ["front", "top", "right", "home"] as const;
        const keys = presets.map((preset) => {
            const key = `${parentKey}:${preset}`;
            this.put({
                key,
                parentKey,
                type: "view",
                name: preset[0].toUpperCase() + preset.slice(1),
                icon: "icon-eye",
                children: [],
                preset,
            });
            return key;
        });
        for (const view of this.document.acts) {
            let key = this.viewKeys.get(view);
            if (!key) {
                key = `${parentKey}:saved:${this.nextViewId++}`;
                this.viewKeys.set(view, key);
            }
            this.put({ key, parentKey, type: "view", name: view.name, icon: "icon-eye", children: [], view });
            keys.push(key);
            if (!this.watchedViews.has(view)) {
                this.watchedViews.add(view);
                view.onPropertyChanged(this.onViewsChanged);
            }
        }
        for (const view of this.watchedViews) {
            if (!this.document.acts.contains(view)) {
                view.removePropertyChanged(this.onViewsChanged);
                this.watchedViews.delete(view);
            }
        }
        return keys;
    }

    private reconcile(): void {
        this.rootKey = this.document.modelManager.rootNode.id;
        const root = this.document.modelManager.rootNode;
        if (!(root instanceof FolderNode)) return;
        this.container(root);
        const pending = [root];
        while (pending.length) pending.push(...this.fillContainer(pending.pop()!));
        this.prune();
    }

    private prune(): void {
        const reachable = new Set<string>();
        const pending = [this.rootKey];
        while (pending.length) {
            const key = pending.pop()!;
            if (reachable.has(key)) continue;
            reachable.add(key);
            pending.push(...(this.entries.get(key)?.children ?? []));
        }
        for (const [key, entry] of this.entries) {
            if (reachable.has(key)) continue;
            this.entries.delete(key);
            if (entry.node) {
                entry.node.removePropertyChanged(this.onNodeChanged);
                this.watched.delete(entry.node);
                this.nodeKeys.delete(entry.node);
            }
            const origin = this.origins.get(key);
            if (origin) {
                origin.dispose();
                this.origins.delete(key);
            }
        }
    }

    private readonly onStructureChanged = (records: NodeRecord[]) => {
        const manager = this.document.modelManager;
        if (manager.rootNode.id !== this.rootKey || this.entries.get(this.rootKey)?.node !== manager.rootNode)
            this.reconcile();
        else {
            const dirty = new Set<FolderNode>();
            for (const record of records) {
                if (record.oldParent instanceof FolderNode) dirty.add(record.oldParent);
                if (record.newParent instanceof FolderNode) dirty.add(record.newParent);
                if (record.node instanceof FolderNode && record.newParent) dirty.add(record.node);
            }
            const pending = [...dirty];
            const done = new Set<FolderNode>();
            while (pending.length) {
                const owner = pending.pop()!;
                if (done.has(owner) || !this.entries.has(owner.id)) continue;
                done.add(owner);
                const children = this.fillContainer(owner);
                for (const child of children)
                    if (dirty.has(child) || !this.entries.get(child.id)?.children.length) pending.push(child);
            }
            this.prune();
        }
        this.changed.emit();
    };
    private readonly onProvidersChanged = () => {
        this.reconcile();
        this.changed.emit();
    };
    private readonly onManagerChanged = () => this.changed.emit();
    private readonly onDocumentChanged = () => {
        const entry = this.entries.get(this.rootKey);
        if (entry) entry.name = this.document.name;
        this.changed.emit();
    };
    private readonly onSettingsChanged = () => {
        const entry = this.entries.get(`${this.rootKey}:units`);
        if (entry) entry.name = `Units: ${documentLengthUnit(this.document)}`;
        this.changed.emit();
    };
    private readonly onViewsChanged = () => {
        const entry = this.entries.get(`${this.rootKey}:views`);
        if (entry) entry.children = this.viewEntries(entry.key);
        this.prune();
        this.changed.emit();
    };
    private readonly onNodeChanged = (property: string, node: INode) => {
        const entry = this.entries.get(this.nodeKeys.get(node) ?? "");
        if (entry) entry.name = node.name;
        if (property === "shape" && entry && !(node instanceof FolderNode)) {
            const description = describe(node);
            entry.type = description.type;
            entry.icon = description.icon;
        }
        if (node instanceof FolderNode && (property === "visible" || property === "parentVisible")) {
            for (const item of this.entries.values()) {
                if (item.owner === node && item.originMember !== undefined && item.node)
                    item.node.parentVisible = node.visible && node.parentVisible;
            }
        }
        this.changed.emit();
    };

    /** Lazily materializes a runtime datum, outside the saved model hierarchy. */
    originNode(entry: BrowserEntry): ConstructionNode | undefined {
        if (entry.originMember === undefined) return undefined;
        const existing = this.origins.get(entry.key);
        if (existing) return existing;
        const point = (value: XYZ): ConstructionRef => ({
            kind: "fixed",
            geometry: { kind: "point", point: value },
        });
        const index = entry.originMember;
        const definition: ConstructionDefinition =
            index === 0
                ? { kind: "point-vertex", vertex: point(XYZ.zero) }
                : index < 4
                  ? {
                        kind: "axis-two-points",
                        first: point(XYZ.zero),
                        second: point([XYZ.unitX, XYZ.unitY, XYZ.unitZ][index - 1]),
                    }
                  : {
                        kind: "plane-offset",
                        source: { kind: "origin-plane", plane: (["XY", "ZX", "YZ"] as const)[index - 4] },
                        distance: 0,
                    };
        const node = new RuntimeOriginNode({
            document: this.document,
            name: entry.name,
            id: entry.key,
            definition,
        });
        node.visible = false;
        node.parentVisible = !!entry.owner?.visible && !!entry.owner?.parentVisible;
        this.origins.set(entry.key, node);
        entry.node = node;
        this.nodeKeys.set(node, entry.key);
        this.watched.add(node);
        node.onPropertyChanged(this.onNodeChanged);
        this.document.visual.context.addNode([node]);
        return node;
    }

    dispose(): void {
        this.document.modelManager.removeNodeObserver(this.onStructureChanged);
        this.document.modelManager.removePropertyChanged(this.onManagerChanged);
        this.document.removePropertyChanged(this.onDocumentChanged);
        this.document.settings?.removePropertyChanged(this.onSettingsChanged);
        this.document.acts.removeCollectionChanged(this.onViewsChanged);
        BrowserProviders.changed.remove(this.onProvidersChanged);
        for (const node of this.watched) node.removePropertyChanged(this.onNodeChanged);
        for (const view of this.watchedViews) view.removePropertyChanged(this.onViewsChanged);
        for (const origin of this.origins.values()) origin.dispose();
        this.watched.clear();
        this.watchedViews.clear();
        this.origins.clear();
        this.entries.clear();
        this.nodeKeys.clear();
        this.changed.dispose();
    }
}

export interface IBrowserActions {
    activate(entry: BrowserEntry): boolean;
    rename(entry: BrowserEntry, name: string): boolean;
    setVisible(entries: BrowserEntry[], visible: boolean): boolean;
    canMove(entries: BrowserEntry[], target: BrowserEntry): boolean;
    move(entries: BrowserEntry[], target: BrowserEntry): boolean;
    delete(entries: BrowserEntry[]): boolean;
}

/** All document edits use the existing model and transaction/command infrastructure. */
export class BrowserActions implements IBrowserActions {
    constructor(readonly model: BrowserModel) {}
    get editable(): boolean {
        return !this.model.document.repository?.isReadOnly && !DocumentMutations.isHeld(this.model.document);
    }
    activate(entry: BrowserEntry): boolean {
        if (!(entry.node instanceof FolderNode)) return false;
        this.model.document.modelManager.currentNode = entry.node;
        return true;
    }
    rename(entry: BrowserEntry, name: string): boolean {
        name = name.trim();
        if (!this.editable || !name || entry.originMember !== undefined || (!entry.node && !entry.view))
            return false;
        const doc = this.model.document;
        if (entry.node === doc.modelManager.rootNode) doc.name = name;
        else
            Transaction.execute(doc, "rename", () => {
                if (entry.node) entry.node.name = name;
                else entry.view!.name = name;
            });
        return true;
    }
    setVisible(entries: BrowserEntry[], visible: boolean): boolean {
        if (!entries.length || entries.some((entry) => !entry.node && entry.originMember === undefined))
            return false;
        if (!this.editable && entries.some((entry) => entry.originMember === undefined)) return false;
        const doc = this.model.document;
        const update = () => {
            for (const entry of entries) {
                const node = entry.node ?? this.model.originNode(entry)!;
                node.visible = visible;
            }
        };
        if (entries.every((entry) => entry.originMember !== undefined)) update();
        else Transaction.execute(doc, "change visible", update);
        doc.visual.update();
        return true;
    }
    canMove(entries: BrowserEntry[], target: BrowserEntry): boolean {
        if (
            !this.editable ||
            !entries.length ||
            !target.owner ||
            !["document", "component", "category"].includes(target.type)
        )
            return false;
        return entries.every((entry) => {
            const node = entry.node;
            if (!node?.parent || entry.originMember !== undefined || isConsumedTool(node)) return false;
            if (target.type === "category" && entry.description?.category !== target.description?.category)
                return false;
            for (let ancestor: INode | undefined = target.owner; ancestor; ancestor = ancestor.parent)
                if (ancestor === node) return false;
            return (
                this.model.nodeKeys.has(node) &&
                this.model.entries.get(target.owner!.id)?.node === target.owner
            );
        });
    }
    move(entries: BrowserEntry[], target: BrowserEntry): boolean {
        if (!this.canMove(entries, target)) return false;
        const inverse = containerTransform(target.owner).invert();
        if (!inverse) return false;
        const nodes = NodeUtils.findTopLevelNodes(new Set(entries.map((entry) => entry.node!)));
        const transforms = new Map<INode, Matrix4>();
        for (const node of nodes) {
            if (node instanceof VisualNode || node instanceof GroupNode)
                transforms.set(node, containerTransform(node.parent).multiply(node.transform));
        }
        Transaction.execute(this.model.document, "move node", () => {
            for (const node of nodes) {
                const transform = transforms.get(node);
                if (transform && (node instanceof VisualNode || node instanceof GroupNode)) {
                    const local = inverse.multiply(transform);
                    if (!node.transform.equals(local)) node.transform = local;
                }
                node.parent!.move(node, target.owner!);
            }
        });
        this.model.document.visual.update();
        return true;
    }
    delete(entries: BrowserEntry[]): boolean {
        if (
            !this.editable ||
            !entries.length ||
            entries.some((entry) => !entry.node?.parent || entry.originMember !== undefined)
        )
            return false;
        this.model.document.selection.setSelectedNodes(
            entries.map((entry) => entry.node!),
            false,
        );
        PubSub.default.pub("executeCommand", "modify.deleteNode");
        return true;
    }
}
