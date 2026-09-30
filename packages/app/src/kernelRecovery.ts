// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    AutosaveHolds,
    DocumentMutations,
    type IApplication,
    type IDocument,
    type IDocumentMutationScope,
    type IKernelRecoveryContext,
    KernelRecovery,
    KernelRecoveryCheckpoints,
    type KernelRecoverySummary,
    KernelRecoveryValidation,
    KernelState,
    PubSub,
    Result,
    Transaction,
} from "@spicy3d/core";
import { Document, type PreparedRecoveredDocument } from "./document";

export interface StartKernelRecoveryOptions {
    createContext(): Promise<IKernelRecoveryContext>;
    resetProvider(): void;
}

/** Installs actual reconstruction support, healthy checkpoints and the page-wide recovery coordinator. */
export function startKernelRecovery(
    application: IApplication,
    options: StartKernelRecoveryOptions,
): () => void {
    const observers = new Map<IDocument, () => void>();
    const opened = (document: IDocument) => {
        if (document.application !== application || observers.has(document)) return;
        observers.set(document, KernelRecoveryCheckpoints.observe(document));
    };
    const closed = (document: IDocument) => {
        observers.get(document)?.();
        observers.delete(document);
    };
    PubSub.default.sub("documentOpened", opened);
    PubSub.default.sub("documentClosed", closed);
    for (const document of application.documents) opened(document);

    const uninstall = KernelRecovery.current.install(async (): Promise<Result<KernelRecoverySummary>> => {
        const releaseAutosave = AutosaveHolds.hold("main kernel recovery");
        const owners = new Map<IDocument, IDocumentMutationScope>();
        const candidates = new Map<Document, PreparedRecoveredDocument>();
        let prepared: Awaited<ReturnType<typeof KernelRecoveryCheckpoints.prepare>> | undefined;
        let published = false;
        try {
            KernelRecovery.current.quiesce();
            const command = application.executingCommand as { cancel?: () => void } | undefined;
            command?.cancel?.();
            const deadline = Date.now() + 5000;
            while (
                application.executingCommand ||
                [...application.documents].some(
                    (document) => Transaction.isActive(document) || DocumentMutations.isHeld(document),
                )
            ) {
                if (Date.now() >= deadline)
                    throw new Error("Modeling is still rolling back; retry recovery when it finishes");
                await new Promise((resolve) => setTimeout(resolve, 16));
            }
            const documents = [...application.documents];
            if (documents.some((document) => !(document instanceof Document)))
                throw new Error("An open document does not support safe kernel reconstruction");
            for (const document of documents) {
                KernelRecoveryValidation.quiesce(document);
                document.analyses.quiesceKernelRecovery();
                owners.set(document, DocumentMutations.hold(document));
            }
            await bounded(
                Promise.all(documents.map((document) => document.settled())),
                30_000,
                "A document save is still pending; retry recovery when it settles",
            );
            prepared = await KernelRecoveryCheckpoints.prepare(
                documents,
                () =>
                    bounded(
                        options.createContext(),
                        30_000,
                        "Creating the replacement kernel timed out",
                        (context) => context.dispose(),
                    ),
                (document, checkpoint) => {
                    const concrete = document as Document;
                    const owner = owners.get(document)!;
                    const candidate = owner.run(() => concrete.prepareKernelRecovery(checkpoint));
                    candidates.set(concrete, candidate);
                    return { dispose: () => owner.run(() => candidate.dispose()) };
                },
            );
            if (
                documents.length !== application.documents.size ||
                documents.some((document) => !application.documents.has(document))
            ) {
                throw new Error(
                    "Open documents changed during kernel recovery; retry with the current documents",
                );
            }
            // Every fallible native reconstruction happened before this synchronous publication turn.
            options.resetProvider();
            for (const [document, candidate] of candidates)
                owners.get(document)!.run(() => candidate.adopt());
            prepared.context.publish();
            KernelState.current.reset();
            published = true;
            const failures: string[] = [];
            for (const [document, candidate] of candidates) {
                try {
                    owners.get(document)!.run(() => candidate.finish());
                } catch (error) {
                    failures.push(error instanceof Error ? error.message : String(error));
                }
            }
            for (const document of documents) KernelRecoveryCheckpoints.capture(document);
            KernelRecovery.current.notifyRecovered(documents);
            for (const [document, candidate] of candidates) {
                try {
                    owners.get(document)!.run(() => candidate.notify());
                } catch (error) {
                    failures.push(error instanceof Error ? error.message : String(error));
                }
            }
            if (failures.length) throw new Error(failures.join("; "));
            return Result.ok({ documentIds: documents.map((document) => document.id), undoReset: true });
        } catch (error) {
            if (!published)
                for (const [document, candidate] of candidates)
                    owners.get(document)!.run(() => candidate.rollbackAdoption());
            const message = error instanceof Error ? error.message : String(error);
            return Result.err(
                published ? `Kernel recovered, but refreshing the document failed: ${message}` : message,
            );
        } finally {
            try {
                prepared?.dispose();
            } finally {
                for (const owner of owners.values()) owner.release();
                releaseAutosave();
            }
        }
    });
    return () => {
        uninstall();
        PubSub.default.remove("documentOpened", opened);
        PubSub.default.remove("documentClosed", closed);
        for (const release of observers.values()) release();
        observers.clear();
    };
}

/** A late-created candidate is retired instead of becoming an unowned native generation. */
function bounded<T>(
    promise: Promise<T>,
    milliseconds: number,
    message: string,
    discard?: (value: T) => void,
): Promise<T> {
    return new Promise((resolve, reject) => {
        let expired = false;
        const timer = setTimeout(() => {
            expired = true;
            reject(new Error(message));
        }, milliseconds);
        promise.then(
            (value) => {
                clearTimeout(timer);
                if (expired) discard?.(value);
                else resolve(value);
            },
            (error) => {
                clearTimeout(timer);
                if (!expired) reject(error);
            },
        );
    });
}
