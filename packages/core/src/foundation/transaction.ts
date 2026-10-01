// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IDocument } from "../document";
import { DocumentMutations, type IDocumentMutationScope } from "../documentMutations";
import { DocumentRebuilds } from "../documentRebuilds";
import { ArrayRecord, type IHistoryRecord } from "./history";
import { Logger } from "./logger";

export class Transaction {
    private static readonly committed = new WeakMap<IDocument, Set<() => void>>();
    static onCommitted(document: IDocument, listener: () => void): () => void {
        let listeners = Transaction.committed.get(document);
        if (!listeners) {
            listeners = new Set();
            Transaction.committed.set(document, listeners);
        }
        listeners.add(listener);
        return () => listeners.delete(listener);
    }

    private static readonly _transactionMap: WeakMap<IDocument, ArrayRecord> = new WeakMap();

    constructor(
        readonly document: IDocument,
        readonly name: string,
    ) {}

    static isActive(document: IDocument): boolean {
        return Transaction._transactionMap.has(document);
    }

    static add(document: IDocument, record: IHistoryRecord) {
        DocumentMutations.assertWritable(document);
        if (document.history.disabled) return;
        DocumentRebuilds.edited(document);
        const arrayRecord = Transaction._transactionMap.get(document);
        if (arrayRecord !== undefined) {
            arrayRecord.records.push(record);
        } else {
            Transaction.addToHistory(document, record);
        }
    }

    static addToHistory(document: IDocument, record: IHistoryRecord) {
        document.history.add(record);
        Logger.info(`history added ${record.name}`);
    }

    /**
     * Opens a transaction, runs `action` and commits it — or, when the document already has
     * one open, joins that one: the records merge, so undoing reverts both halves together.
     *
     * The join is what makes a listener that edits a second time work. Editing the parameter
     * table re-solves the live sketch, which commits its own data — one user action, one undo
     * step. Opening a second transaction used to throw inside the notification, where the
     * observer swallowed it: the inner edit was lost with no error anywhere.
     */
    static execute(document: IDocument, name: string, action: () => void) {
        DocumentMutations.assertWritable(document);
        if (Transaction._transactionMap.has(document)) {
            action();
            return;
        }
        const trans = new Transaction(document, name);
        trans.start();
        try {
            action();
            trans.commit();
        } catch (e) {
            trans.rollback();
            throw e;
        }
    }

    static async executeAsync(
        document: IDocument,
        name: string,
        action: () => Promise<void>,
        owner?: IDocumentMutationScope,
    ) {
        const run = <T>(callback: () => T): T => (owner ? owner.run(callback) : callback());
        run(() => DocumentMutations.assertWritable(document));
        if (Transaction._transactionMap.has(document)) {
            await run(action);
            return;
        }
        const trans = new Transaction(document, name);
        run(() => trans.start());
        try {
            await run(action);
            run(() => trans.commit());
        } catch (error) {
            run(() => trans.rollback());
            throw error;
        }
    }

    start(name?: string) {
        DocumentMutations.assertWritable(this.document);
        const transactionName = name ?? this.name;
        if (Transaction._transactionMap.has(this.document)) {
            throw new Error(`The document has started a transaction ${this.name}`);
        }
        Transaction._transactionMap.set(this.document, new ArrayRecord(transactionName));
    }

    commit() {
        DocumentMutations.assertWritable(this.document);
        const arrayRecord = Transaction._transactionMap.get(this.document);
        if (!arrayRecord) {
            throw new Error("Transaction has not started");
        }
        if (arrayRecord.records.length > 0) Transaction.addToHistory(this.document, arrayRecord);
        Transaction._transactionMap.delete(this.document);
        for (const listener of Transaction.committed.get(this.document) ?? []) listener();
    }

    rollback() {
        DocumentMutations.assertWritable(this.document);
        const transaction = Transaction._transactionMap.get(this.document);
        Transaction._transactionMap.delete(this.document);

        if (transaction) this.document.history.rollback(transaction);
    }
}
