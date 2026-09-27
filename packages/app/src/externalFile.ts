// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    appFolderUrl,
    ExternalContentPolicy,
    I18n,
    Logger,
    PLUGIN_FILE_EXTENSION,
    PubSub,
    redactUrl,
} from "@spicy3d/core";
import { div, hr } from "@spicy3d/element";

/**
 * The URL of a file to open from `?url=` / `?model=` once it may be fetched, or undefined: the
 * app's own origin and the deployment's `security.fileOrigins` at once, any other http(s) origin only
 * after the user confirms a prompt naming it (every time: a link must never make the app fetch from
 * an arbitrary host silently), anything else never.
 */
export async function approveExternalFile(raw: string): Promise<URL | undefined> {
    const decision = ExternalContentPolicy.evaluate(raw, "file");
    if (decision.verdict === "refused") {
        Logger.warn(`[file] not opening ${redactUrl(raw)}: ${decision.reason}`);
        PubSub.default.pub("showToast", "warning.file.refused{0}", decision.reason);
        return undefined;
    }
    if (decision.verdict === "allowed") return decision.url;
    const { url } = decision;
    const confirmed = await new Promise<boolean>((resolve) => {
        const where = div({ textContent: redactUrl(url) });
        where.dataset["origin"] = url.origin;
        PubSub.default.pub(
            "showDialog",
            "common.warning",
            div(I18n.translate("warning.file.fromOrigin"), hr(), where),
            [
                // Escape picks Cancel.
                { content: "common.cancel", onclick: () => resolve(false) },
                { content: "warning.file.open", onclick: () => resolve(true) },
            ],
        );
    });
    return confirmed ? url : undefined;
}

/** The decoded last path segment of `url` (`%2E` and the like included): what the file is called. */
export function urlFileName(url: URL): string {
    const last = url.pathname.substring(url.pathname.lastIndexOf("/") + 1);
    try {
        return decodeURIComponent(last);
    } catch {
        return last;
    }
}

/** Whether `raw` names a `.spicyplugin` (by its path, decoded; never by its query). */
export function isPluginUrl(raw: string): boolean {
    try {
        const url = new URL(raw, appFolderUrl());
        return urlFileName(url).toLowerCase().endsWith(PLUGIN_FILE_EXTENSION);
    } catch {
        return false;
    }
}
