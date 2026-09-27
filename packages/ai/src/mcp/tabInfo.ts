// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { getCurrentApplication, type IDocument, type IView, PubSub } from "@spicy3d/core";
import type { TabInfo } from "./pageTransport";

function activeDocument(): IDocument | undefined {
    try {
        return getCurrentApplication().activeView?.document;
    } catch {
        return undefined; // no application yet (tests, early startup)
    }
}

/** What the relay should know about this tab now; `deviceName` comes from the account settings. */
export function currentTabInfo(deviceName: string): TabInfo {
    const document = activeDocument();
    return {
        // "" clears the relay's value (it stores empty strings as "none").
        documentId: document?.id ?? "",
        documentName: document?.name ?? "",
        deviceName,
        focused: globalThis.document?.hasFocus?.() ?? false,
    };
}

/**
 * Calls `onChange` with the fields that changed: the active document (switch, rename) and the
 * window gaining focus — the relay targets the user's most recently focused tab by default.
 */
export function watchTabInfo(onChange: (info: TabInfo) => void): () => void {
    let watched: IDocument | undefined;
    const onName = (property: string | number | symbol) => {
        if (property === "name" && watched) onChange({ documentName: watched.name });
    };
    const watch = (document: IDocument | undefined) => {
        watched?.removePropertyChanged(onName);
        watched = document;
        watched?.onPropertyChanged(onName);
    };
    const onView = (view: IView | undefined) => {
        watch(view?.document);
        onChange({ documentId: view?.document.id ?? "", documentName: view?.document.name ?? "" });
    };
    const onFocus = () => onChange({ focused: true });

    watch(activeDocument());
    PubSub.default.sub("activeViewChanged", onView);
    globalThis.addEventListener?.("focus", onFocus);
    return () => {
        watch(undefined);
        PubSub.default.remove("activeViewChanged", onView);
        globalThis.removeEventListener?.("focus", onFocus);
    };
}
