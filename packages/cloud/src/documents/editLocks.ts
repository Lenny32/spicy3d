// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Logger } from "@spicy3d/core";
import type { IEditGuard } from "./repository";

/** The part of the Web Locks API used here (`navigator.locks`). */
export interface LockManagerLike {
    request(
        name: string,
        options: { ifAvailable?: boolean; steal?: boolean; signal?: AbortSignal },
        callback: (lock: unknown) => Promise<void> | void,
    ): Promise<unknown>;
}

/** The part of `BroadcastChannel` used here. */
export interface ChannelLike {
    postMessage(message: unknown): void;
    onmessage: ((event: MessageEvent) => void) | null;
    close(): void;
}

/** `editing`: this tab saves the document. `readOnly`: another tab of this browser edits it. */
export type EditMode = "editing" | "readOnly";

interface HandoverMessage {
    type: "handover" | "released";
    id: string;
}

/** How long "edit here instead" waits for the other tab to save and let go before taking over. */
export const HANDOVER_TIMEOUT_MS = 5000;

const lockName = (id: string) => `spicy3d.document.${id}`;

function defaultLocks(): LockManagerLike | undefined {
    return (globalThis.navigator as { locks?: LockManagerLike } | undefined)?.locks;
}

function defaultChannel(): ChannelLike | undefined {
    return typeof BroadcastChannel === "undefined" ? undefined : new BroadcastChannel("spicy3d.documents");
}

/**
 * One editing tab per cloud document in this browser: opening takes a Web Lock named after the
 * document; a tab that can't get it shows the document read-only (it can't save). "Edit here
 * instead" asks the editing tab over a BroadcastChannel to save and let go, then takes the lock
 * (stealing it if the other tab doesn't answer in time). Without Web Locks every tab edits.
 */
export class EditLocks implements IEditGuard {
    private readonly held = new Map<string, () => void>();
    private readonly readOnly = new Set<string>();
    private readonly listeners = new Set<(id: string, mode: EditMode) => void>();
    private readonly releasedListeners = new Set<(id: string) => void>();
    /** Called in the editing tab before it lets go (e.g. to save unsaved changes). */
    handoverHandler: ((id: string) => Promise<void>) | undefined;

    constructor(
        private readonly locks: LockManagerLike | undefined = defaultLocks(),
        private readonly channel: ChannelLike | undefined = defaultChannel(),
    ) {
        if (this.channel) this.channel.onmessage = (event) => void this.onMessage(event.data);
    }

    isReadOnly(id: string): boolean {
        return this.readOnly.has(id);
    }

    modeOf(id: string): EditMode {
        return this.readOnly.has(id) ? "readOnly" : "editing";
    }

    /** Returns the unsubscribe function. */
    onChanged(listener: (id: string, mode: EditMode) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    /** Takes the document for this tab if no other tab edits it. */
    async acquire(id: string): Promise<EditMode> {
        if (!this.locks || this.held.has(id)) return "editing";
        const got = await this.lock(id, { ifAvailable: true });
        this.setMode(id, got ? "editing" : "readOnly");
        return this.modeOf(id);
    }

    /** Lets the document go (closed, or handed over); a read-only tab just forgets it. */
    release(id: string): void {
        const release = this.held.get(id);
        this.held.delete(id);
        release?.();
        this.readOnly.delete(id);
        // Other tabs may now take it (e.g. to push changes it left pending).
        if (release) this.channel?.postMessage({ type: "released", id } satisfies HandoverMessage);
    }

    /** Another tab of this browser let a document go. Returns the unsubscribe function. */
    onReleasedElsewhere(listener: (id: string) => void): () => void {
        this.releasedListeners.add(listener);
        return () => this.releasedListeners.delete(listener);
    }

    /** "Edit here instead". Resolves `true` once this tab edits the document. */
    async takeOver(id: string, timeoutMs = HANDOVER_TIMEOUT_MS): Promise<boolean> {
        if (!this.locks) return true;
        if (this.held.has(id)) return true;
        this.channel?.postMessage({ type: "handover", id } satisfies HandoverMessage);
        let got = await this.lock(id, { signal: AbortSignal.timeout(timeoutMs) });
        if (!got) {
            Logger.warn(`[cloud] the tab editing ${id} did not answer, taking over`);
            got = await this.lock(id, { steal: true });
        }
        this.setMode(id, got ? "editing" : "readOnly");
        return got;
    }

    dispose(): void {
        for (const id of [...this.held.keys()]) this.release(id);
        this.readOnly.clear();
        if (this.channel) {
            this.channel.onmessage = null;
            this.channel.close();
        }
    }

    private lock(
        id: string,
        options: { ifAvailable?: boolean; steal?: boolean; signal?: AbortSignal },
    ): Promise<boolean> {
        const locks = this.locks!;
        return new Promise((resolve) => {
            let granted = false;
            locks
                .request(lockName(id), options, (lock) => {
                    if (!lock) {
                        resolve(false);
                        return;
                    }
                    granted = true;
                    resolve(true);
                    return new Promise<void>((release) => this.held.set(id, release));
                })
                .catch(() => {
                    if (!granted) {
                        resolve(false);
                    } else if (this.held.has(id)) {
                        // Stolen by another tab's "edit here instead".
                        this.held.delete(id);
                        this.setMode(id, "readOnly");
                    }
                });
        });
    }

    private async onMessage(data: unknown) {
        const message = data as Partial<HandoverMessage> | null;
        if (typeof message?.id !== "string") return;
        if (message.type === "released") {
            for (const listener of [...this.releasedListeners]) listener(message.id);
            return;
        }
        if (message.type !== "handover") return;
        const id = message.id;
        if (!this.held.has(id)) return;
        try {
            await this.handoverHandler?.(id);
        } catch (error) {
            Logger.warn(`[cloud] saving before the handover of ${id} failed: ${error}`);
        }
        const release = this.held.get(id);
        this.held.delete(id);
        release?.();
        this.setMode(id, "readOnly");
    }

    private setMode(id: string, mode: EditMode) {
        const changed = this.modeOf(id) !== mode;
        if (mode === "readOnly") this.readOnly.add(id);
        else this.readOnly.delete(id);
        if (!changed) return;
        for (const listener of [...this.listeners]) listener(id, mode);
    }
}
