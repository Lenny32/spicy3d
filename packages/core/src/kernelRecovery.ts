// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IDocument } from "./document";
import { DocumentRebuilds } from "./documentRebuilds";
import { type IDisposable, Logger, Transaction } from "./foundation";
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
}

export interface PreparedKernelRecovery extends IDisposable {
    readonly context: IKernelRecoveryContext;
    readonly candidates: readonly IDisposable[];
}

export class KernelRecoveryCheckpoints {
    private static readonly checkpoints = new WeakMap<IDocument, KernelRecoveryCheckpoint>();

    /** Never flush derived work or snapshot an open transaction into the committed checkpoint. */
    static capture(document: IDocument): boolean {
        if (
            KernelState.current.isCrashed ||
            Transaction.isActive(document) ||
            DocumentRebuilds.pending(document)
        ) {
            return false;
        }
        const position = document.history.position();
        const data = structuredClone(document.serialize());
        if (KernelState.current.isCrashed || position !== document.history.position()) return false;
        KernelRecoveryCheckpoints.checkpoints.set(document, { data, position, dirty: document.isDirty });
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
        refresh();
        return () => {
            disposed = true;
            document.history.onChanged.remove(refresh);
        };
    }

    /** Reading after a crash accesses only cached JSON and metadata, never old native handles. */
    static read(document: IDocument): KernelRecoveryCheckpoint {
        const checkpoint = KernelRecoveryCheckpoints.checkpoints.get(document);
        if (!checkpoint || checkpoint.position !== document.history.position()) {
            throw new Error("No checkpoint for the current committed document state");
        }
        return { ...checkpoint, data: structuredClone(checkpoint.data) };
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
