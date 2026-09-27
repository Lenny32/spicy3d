// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IApplication } from "./application";
import { AutosaveHolds } from "./autosave";

export interface UserActivityOptions {
    /** Whether a modal dialog is open (default: any open `<dialog>`). */
    isDialogOpen?: () => boolean;
}

const anyDialogOpen = () => globalThis.document?.querySelector("dialog[open]") != null;

/**
 * Whether the user is in the middle of something that background work (an autosave, applying a
 * newer version from another device) must not interrupt: a command, a drag (pointer pressed), a
 * modal dialog, an {@link AutosaveHolds} hold (a sketch session, resolving a conflict). Shared by
 * the autosave service and the cloud sync. The pointer is only tracked between `start()` and the
 * returned stop (reference-counted, so several users share one set of listeners).
 */
export class UserActivity {
    static readonly current: UserActivity = new UserActivity();

    private pointerDown = false;
    private users = 0;
    private removeHoldListener?: () => void;
    private readonly idleListeners = new Set<() => void>();
    private readonly isDialogOpen: () => boolean;

    constructor(options: UserActivityOptions = {}) {
        this.isDialogOpen = options.isDialogOpen ?? anyDialogOpen;
    }

    /** Starts tracking the pointer; returns the stop function (idempotent). */
    start(): () => void {
        if (this.users++ === 0) {
            globalThis.addEventListener?.("pointerdown", this.onPointerDown, true);
            globalThis.addEventListener?.("pointerup", this.onPointerUp, true);
            globalThis.addEventListener?.("pointercancel", this.onPointerUp, true);
            globalThis.addEventListener?.("blur", this.onPointerUp);
            globalThis.document?.addEventListener("visibilitychange", this.onVisibilityChange);
            this.removeHoldListener = AutosaveHolds.onReleased(this.notifyIdle);
        }
        let stopped = false;
        return () => {
            if (stopped) return;
            stopped = true;
            if (--this.users > 0) return;
            globalThis.removeEventListener?.("pointerdown", this.onPointerDown, true);
            globalThis.removeEventListener?.("pointerup", this.onPointerUp, true);
            globalThis.removeEventListener?.("pointercancel", this.onPointerUp, true);
            globalThis.removeEventListener?.("blur", this.onPointerUp);
            globalThis.document?.removeEventListener("visibilitychange", this.onVisibilityChange);
            this.removeHoldListener?.();
            this.removeHoldListener = undefined;
            this.pointerDown = false;
        };
    }

    /** Whether the user is in the middle of something (`app`: its running command counts). */
    isBusy(app?: IApplication): boolean {
        return (
            app?.executingCommand !== undefined ||
            AutosaveHolds.isHeld ||
            this.pointerDown ||
            this.isDialogOpen()
        );
    }

    /**
     * Called when the user may just have become idle: the pointer released (or the window left),
     * the last hold released. Commands ending and dialogs closing are not signalled here: watch the
     * application's `executingCommand` and poll. Returns the unsubscribe function.
     */
    onMaybeIdle(listener: () => void): () => void {
        this.idleListeners.add(listener);
        return () => this.idleListeners.delete(listener);
    }

    private readonly notifyIdle = () => {
        for (const listener of [...this.idleListeners]) listener();
    };

    private readonly onPointerDown = () => {
        this.pointerDown = true;
    };

    /** Also on blur: a release outside the window (alt-tab mid-drag) never reaches it. */
    private readonly onPointerUp = () => {
        this.pointerDown = false;
        this.notifyIdle();
    };

    private readonly onVisibilityChange = () => {
        if (globalThis.document?.visibilityState === "hidden") this.onPointerUp();
    };
}
