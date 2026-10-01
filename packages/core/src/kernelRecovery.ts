// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IDocument } from "./document";
import { DocumentRebuilds } from "./documentRebuilds";
import { type IDisposable, Logger, Observable, Result, Transaction } from "./foundation";
import type { INode } from "./model";
import type { Serialized } from "./serialize";
import { KernelState } from "./shape/kernelState";

/** Runtime cache of the last committed edit, independent of repository save positions. */
export interface KernelRecoveryCheckpoint {
    readonly data: Serialized;
    readonly position: object;
    readonly dirty: boolean;
}

export interface IKernelRecoveryContext extends IDisposable {
    /** A synchronous private turn in the candidate native instance, never a public installation. */
    run<T>(action: () => T): T;
    /** Install only after all documents have adopted successfully validated candidate graphs. */
    publish(): void;
}

export interface PreparedKernelRecovery extends IDisposable {
    readonly context: IKernelRecoveryContext;
    readonly candidates: readonly IDisposable[];
}

export class KernelRecoveryCheckpoints {
    private static readonly checkpoints = new WeakMap<IDocument, KernelRecoveryCheckpoint>();
    private static readonly revisions = new WeakMap<IDocument, number>();

    /** Never flush derived work or snapshot an open transaction into the committed checkpoint. */
    static capture(document: IDocument, force = false): boolean {
        if (
            KernelState.current.isCrashed ||
            document.history.disabled ||
            Transaction.isActive(document) ||
            DocumentRebuilds.pending(document)
        ) {
            return false;
        }
        const position = document.history.position();
        const previous = KernelRecoveryCheckpoints.checkpoints.get(document);
        const revision = DocumentRebuilds.revision(document);
        if (
            !force &&
            previous?.position === position &&
            KernelRecoveryCheckpoints.revisions.get(document) === revision
        ) {
            return true;
        }
        const data = structuredClone(document.serialize());
        if (KernelState.current.isCrashed || position !== document.history.position()) return false;
        KernelRecoveryCheckpoints.checkpoints.set(document, { data, position, dirty: document.isDirty });
        KernelRecoveryCheckpoints.revisions.set(document, revision);
        return true;
    }

    /** Attach only while recovery support is enabled; failures leave the previous checkpoint explicit. */
    static observe(document: IDocument): () => void {
        let disposed = false;
        const refresh = () => {
            try {
                if (KernelRecoveryCheckpoints.capture(document)) return;
            } catch (error) {
                Logger.warn(`kernel recovery checkpoint unavailable: ${String(error)}`);
                return;
            }
            const position = document.history.position();
            void DocumentRebuilds.settled(document).then(() => {
                if (disposed || position !== document.history.position()) return;
                try {
                    KernelRecoveryCheckpoints.capture(document);
                } catch (error) {
                    Logger.warn(`kernel recovery checkpoint unavailable: ${String(error)}`);
                }
            });
        };
        document.history.onChanged.sub(refresh);
        const releaseCommit = Transaction.onCommitted(document, refresh);
        refresh();
        return () => {
            disposed = true;
            document.history.onChanged.remove(refresh);
            releaseCommit();
        };
    }

    /** Reading after a crash accesses only cached JSON and metadata, never old native handles. */
    static read(document: IDocument): KernelRecoveryCheckpoint {
        const checkpoint = KernelRecoveryCheckpoints.checkpoints.get(document);
        if (!checkpoint || checkpoint.position !== document.history.position()) {
            throw new Error(
                "No healthy checkpoint for the current committed document state; reload the page to reopen the last saved document",
            );
        }
        return { ...checkpoint, dirty: document.isDirty, data: structuredClone(checkpoint.data) };
    }

    /** Prepare every open document before a caller may consider publication; this API cannot publish. */
    static async prepare(
        documents: readonly IDocument[],
        createContext: () => Promise<IKernelRecoveryContext>,
        prepareDocument: (document: IDocument, checkpoint: KernelRecoveryCheckpoint) => IDisposable,
    ): Promise<PreparedKernelRecovery> {
        const snapshots = documents.map((document) => KernelRecoveryCheckpoints.read(document));
        const context = await createContext();
        const candidates: IDisposable[] = [];
        let disposed = false;
        const dispose = () => {
            if (disposed) return;
            disposed = true;
            try {
                context.run(() => {
                    for (const candidate of candidates) candidate.dispose();
                });
            } finally {
                context.dispose();
            }
        };
        try {
            context.run(() => {
                for (let index = 0; index < documents.length; index++) {
                    const document = documents[index];
                    if (document.history.position() !== snapshots[index].position) {
                        throw new Error("Committed document changed during recovery preparation");
                    }
                    candidates.push(prepareDocument(document, snapshots[index]));
                }
            });
            return { context, candidates, dispose };
        } catch (error) {
            dispose();
            throw error;
        }
    }
}

export interface KernelRecoverySummary {
    readonly documentIds: readonly string[];
    readonly undoReset: true;
}

/** Public runtime capability; availability means a concrete healthy-checkpoint recovery installer exists. */
export class KernelRecovery extends Observable {
    static readonly current = new KernelRecovery();
    private handler?: () => Promise<Result<KernelRecoverySummary>>;
    private readonly quiesceHandlers = new Set<() => void>();
    private readonly recoveredHandlers = new Set<(documents: readonly IDocument[]) => void>();
    private running?: Promise<Result<KernelRecoverySummary>>;

    get available(): boolean {
        return this.getPrivateValue("available", false);
    }
    get status(): "idle" | "recovering" | "failed" {
        return this.getPrivateValue("status", "idle");
    }
    get error(): string | undefined {
        return this.getPrivateValue("error", undefined);
    }

    install(handler: () => Promise<Result<KernelRecoverySummary>>): () => void {
        this.handler = handler;
        this.setProperty("available", true);
        return () => {
            if (this.handler !== handler) return;
            this.handler = undefined;
            this.setProperty("available", false);
        };
    }

    addQuiesce(handler: () => void): () => void {
        this.quiesceHandlers.add(handler);
        return () => this.quiesceHandlers.delete(handler);
    }
    quiesce(): void {
        for (const handler of this.quiesceHandlers) handler();
    }

    addRecovered(handler: (documents: readonly IDocument[]) => void): () => void {
        this.recoveredHandlers.add(handler);
        return () => this.recoveredHandlers.delete(handler);
    }
    notifyRecovered(documents: readonly IDocument[]): void {
        for (const handler of this.recoveredHandlers) handler(documents);
    }

    recover(): Promise<Result<KernelRecoverySummary>> {
        if (this.running) return this.running;
        if (!this.handler) return Promise.resolve(Result.err("Main kernel recovery is unavailable"));
        if (!KernelState.current.isCrashed)
            return Promise.resolve(Result.err("The main kernel has not crashed"));
        this.setProperty("status", "recovering");
        this.setProperty("error", undefined);
        const handler = this.handler;
        this.running = (async () => {
            let result: Result<KernelRecoverySummary>;
            try {
                result = await handler();
            } catch (error) {
                result = Result.err(error instanceof Error ? error.message : String(error));
            }
            this.setProperty("status", result.isOk ? "idle" : "failed");
            this.setProperty("error", result.isOk ? undefined : result.error);
            return result;
        })().finally(() => {
            this.running = undefined;
        });
        return this.running;
    }
}

/** Module-specific synchronous rebuild policy and cancellation, without core depending on feature packages. */
export class KernelRecoveryValidation {
    private static readonly scopes = new Set<(document: IDocument, action: () => void) => void>();
    private static readonly nodeValidators = new Set<(node: INode) => void>();
    private static readonly cancellers = new Set<(document: IDocument) => void>();
    static register(
        scope: (document: IDocument, action: () => void) => void,
        cancel: (document: IDocument) => void,
        validateNode?: (node: INode) => void,
    ): void {
        KernelRecoveryValidation.scopes.add(scope);
        KernelRecoveryValidation.cancellers.add(cancel);
        if (validateNode) KernelRecoveryValidation.nodeValidators.add(validateNode);
    }
    static run(document: IDocument, action: () => void): void {
        const scopes = [...KernelRecoveryValidation.scopes];
        const next = (index: number): void => {
            if (index === scopes.length) action();
            else scopes[index](document, () => next(index + 1));
        };
        next(0);
    }
    static validateNode(node: INode): void {
        for (const validate of KernelRecoveryValidation.nodeValidators) validate(node);
    }
    static quiesce(document: IDocument): void {
        for (const cancel of KernelRecoveryValidation.cancellers) cancel(document);
    }
}
