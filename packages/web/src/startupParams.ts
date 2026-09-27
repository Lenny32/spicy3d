// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type AccountLink, parseAccountLink } from "@spicy3d/cloud/src/links";

export interface StartupParams {
    readonly plugins: string[];
    readonly fileUrl: string | undefined;
}

/**
 * Parse the startup query string: each repeated `plugin` param is loaded as a
 * plugin, and `url` (falling back to `model`) points to a file to open.
 */
export function parseStartupParams(search: string): StartupParams {
    const params = new URLSearchParams(search);
    return {
        plugins: params.getAll("plugin").filter((x) => x.trim().length > 0),
        fileUrl: params.get("url") ?? params.get("model") ?? undefined,
    };
}

/**
 * Takes the account email link the page was opened with (`/verify-email?userId=…&token=…`,
 * `/reset-password?…`, `/confirm-email-change?…`): the address bar goes back to the app's own path
 * at once, so the single-use token leaves the URL and the history, and relative URLs (plugins,
 * `api/`) resolve from the app's folder as usual.
 */
export function takeAccountLink(location: Location, history: History): AccountLink | undefined {
    const route = parseAccountLink(location.pathname, location.search);
    if (!route) return undefined;
    history.replaceState(history.state, "", `${route.appPath}${location.hash}`);
    return route.link;
}
