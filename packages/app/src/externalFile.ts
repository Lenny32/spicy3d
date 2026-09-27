// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { ExternalContentPolicy, I18n, Logger, PubSub, redactUrl } from "@spicy3d/core";
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
