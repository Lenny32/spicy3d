// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { MessageType } from "../foundation/messageType";
import type { I18nKeys } from "../i18n/keys";

export interface BannerAction {
    label: I18nKeys;
    run: () => void;
}

/**
 * A non-blocking message pinned to the top of the window until dismissed (or replaced), e.g.
 * "Spicy3D was updated, reload". Unlike a toast it stays; unlike a dialog it never blocks work.
 */
export interface BannerOptions {
    /** Showing a banner with the id of one already shown replaces it. */
    id: string;
    level: MessageType;
    message: I18nKeys;
    args?: unknown[];
    action?: BannerAction;
    /** More than one action (shown after `action`, in order). */
    actions?: BannerAction[];
    /** Offers a close button; `true` when omitted. */
    dismissible?: boolean;
}
