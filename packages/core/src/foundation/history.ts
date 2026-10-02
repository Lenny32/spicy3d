// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { INode, INodeLinkedList } from "../model";
import type { IDisposable } from "./disposable";
import { Signal } from "./signal";

export interface IHistoryRecord extends IDisposable {
    readonly name: string;
    undo(): void;
    redo(): void;
}

export class History implements IDisposable {
    private static readonly mutationGuards = new WeakMap<History, Set<() => void>>();

    /** Runtime pre-mutation checks, removed independently of any document serialization. */
    static addMutationGuard(history: History, guard: () => void): () => void {
        let guards = History.mutationGuards.get(history);
        if (!guards) {
            guards = new Set();
            History.mutationGuards.set(history, guards);
        }
        guards.add(guard);
        return () => guards.delete(guard);
    }

    private assertWritable(): void {
        for (const guard of History.mutationGuards.get(this) ?? []) guard();
    }

    private readonly _undos: IHistoryRecord[] = [];
    private readonly _redos: IHistoryRecord[] = [];

    disabled = false;
    undoLimits = 50;

    /** Fires after every change of the undo position (a new record, an undo or a redo). */
    readonly onChanged = new Signal<() => void>();
    /** Cancel derived work before replay can replace or dispose its inputs. */
    readonly onBeforeReplay = new Signal<() => void>();
    readonly onAfterReplay = new Signal<() => void>();

    /**
     * Stands for the empty undo stack. Replaced whenever the oldest record is dropped, so the
     * state reached by undoing everything that is left is not taken for the original one.
     */
    #bottom: object = {};

    #isUndoing = false;
    get isUndoing() {
        return this.#isUndoing;
    }
    #isRedoing = false;
    get isRedoing() {
        return this.#isRedoing;
    }

    dispose(): void {
        History.mutationGuards.delete(this);
        this._redos.forEach((record) => record.dispose());
        this._undos.forEach((record) => record.dispose());
        this.clear();
        this.onChanged.dispose();
        this.onBeforeReplay.dispose();
        this.onAfterReplay.dispose();
    }

    /**
     * An opaque token for the current undo position: two equal tokens mean the document is in
     * the same state (e.g. the one it was saved in), whatever was undone and redone in between.
     */
    position(): object {
        return this._undos.at(-1) ?? this.#bottom;
    }

    private clear(): void {
        this._undos.length = 0;
        this._redos.length = 0;
    }

    add(record: IHistoryRecord) {
        this.assertWritable();
        if (this.disabled) return;

        this._redos.length = 0;
        this._undos.push(record);

        if (this._undos.length > this.undoLimits) {
            const removed = this._undos.shift();
            removed?.dispose();
            this.#bottom = {};
        }
        this.onChanged.emit();
    }

    /** An explicitly approved runtime undo boundary after successful main-kernel reconstruction. */
    resetForRecovery(notify = true): void {
        this.assertWritable();
        const records = [...this._undos, ...this._redos];
        this.clear();
        this.#bottom = {};
        for (const record of records) {
            try {
                record.dispose();
            } catch {
                /* A retired resource cannot be replayed or re-entered. */
            }
        }
        if (notify) this.onChanged.emit();
    }

    undoCount() {
        return this._undos.length;
    }

    redoCount() {
        return this._redos.length;
    }

    undo() {
        this.assertWritable();
        this.#isUndoing = true;
        this.tryOperate(
            () => {
                const record = this._undos.pop();
                if (!record) return;
                // The position moved with the pop: listeners (isDirty) hear it even if undo throws.
                try {
                    record.undo();
                    this._redos.push(record);
                } finally {
                    this.onChanged.emit();
                }
            },
            () => {
                this.#isUndoing = false;
            },
        );
    }

    redo() {
        this.assertWritable();
        this.#isRedoing = true;
        this.tryOperate(
            () => {
                const record = this._redos.pop();
                if (!record) return;
                try {
                    record.redo();
                    this._undos.push(record);
                } finally {
                    this.onChanged.emit();
                }
            },
            () => {
                this.#isRedoing = false;
            },
        );
    }

    /** Reverts an uncommitted transaction without moving either history stack. */
    rollback(record: IHistoryRecord): void {
        this.assertWritable();
        // A nested rollback emits onAfterReplay while the outer undo is still active;
        // listeners needing the fully restored state must wait for the outer replay.
        const wasUndoing = this.#isUndoing;
        this.#isUndoing = true;
        this.tryOperate(
            () => record.undo(),
            () => {
                this.#isUndoing = wasUndoing;
            },
        );
    }

    private tryOperate(action: () => void, onFinally: () => void) {
        const previousState = this.disabled;
        this.disabled = true;
        try {
            this.onBeforeReplay.emit();
            action();
        } finally {
            this.disabled = previousState;
            onFinally();
            this.onAfterReplay.emit();
        }
    }
}

export class PropertyHistoryRecord implements IHistoryRecord {
    readonly name: string;
    constructor(
        readonly object: any,
        readonly property: string | symbol | number,
        readonly oldValue: any,
        readonly newValue: any,
    ) {
        this.name = `change ${String(property)} property`;
    }

    dispose(): void {}

    undo(): void {
        this.object[this.property] = this.oldValue;
    }

    redo(): void {
        this.object[this.property] = this.newValue;
    }
}

export type NodeAction = "add" | "remove" | "move" | "transfer" | "insertAfter" | "insertBefore";

export interface NodeRecord {
    node: INode;
    action: NodeAction;
    oldParent?: INodeLinkedList;
    oldPrevious?: INode;
    newParent?: INodeLinkedList;
    newPrevious?: INode;
}

export class NodeLinkedListHistoryRecord implements IHistoryRecord {
    readonly name: string;

    constructor(readonly records: NodeRecord[]) {
        this.name = "change node";
    }

    dispose(): void {
        this.records.forEach((record) => {
            if (record.action === "remove") {
                record.node.dispose();
            }
        });
        this.records.length = 0;
    }

    // A recorded anchor can go stale over time (e.g. the node was removed outside of the
    // history); fall back to undefined so the node at least returns to the target parent
    // instead of the move being silently skipped.
    private static normalizePrevious(
        previous: INode | undefined,
        parent: INodeLinkedList | undefined,
    ): INode | undefined {
        return previous?.parent === parent ? previous : undefined;
    }

    private handleUndo(record: NodeRecord): void {
        switch (record.action) {
            case "add":
                record.newParent?.remove(record.node);
                break;
            case "remove":
                record.oldParent?.add(record.node);
                break;
            case "transfer":
                record.oldParent?.add(record.node);
                break;
            case "move":
                record.newParent?.move(
                    record.node,
                    record.oldParent!,
                    NodeLinkedListHistoryRecord.normalizePrevious(record.oldPrevious, record.oldParent),
                );
                break;
            case "insertAfter":
                record.newParent?.remove(record.node);
                break;
            case "insertBefore":
                record.newParent?.remove(record.node);
                break;
        }
    }

    private handleRedo(record: NodeRecord): void {
        switch (record.action) {
            case "add":
                record.newParent?.add(record.node);
                break;
            case "remove":
                record.oldParent?.remove(record.node);
                break;
            case "transfer":
                record.oldParent?.transfer(record.node);
                break;
            case "move":
                record.oldParent?.move(
                    record.node,
                    record.newParent!,
                    NodeLinkedListHistoryRecord.normalizePrevious(record.newPrevious, record.newParent),
                );
                break;
            case "insertAfter":
                record.newParent?.insertAfter(record.newPrevious, record.node);
                break;
            case "insertBefore":
                record.newParent?.insertBefore(record.newPrevious?.nextSibling, record.node);
                break;
        }
    }

    undo(): void {
        for (let i = this.records.length - 1; i >= 0; i--) {
            this.handleUndo(this.records[i]);
        }
    }

    redo(): void {
        this.records.forEach((record) => this.handleRedo(record));
    }
}

export class ArrayRecord implements IHistoryRecord {
    readonly records: Array<IHistoryRecord> = [];

    constructor(readonly name: string) {}

    dispose(): void {
        this.records.forEach((r) => r.dispose());
    }

    undo() {
        for (let index = this.records.length - 1; index >= 0; index--) {
            this.records[index].undo();
        }
    }

    redo() {
        for (const record of this.records) {
            record.redo();
        }
    }
}
