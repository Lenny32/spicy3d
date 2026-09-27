// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type AccountLink, parseAccountLink } from "@spicy3d/cloud/src/links";

export interface StartupParams {
    readonly plugins: string[];
    readonly fileUrl: string | undefined;
    readonly mcpUrl: string | undefined;
}

/**
 * Parse the startup query string: each repeated `plugin` param is loaded as a
 * plugin, `url` (falling back to `model`) points to a file to open, and `mcp` is the local
 * MCP bridge to expose this tab through.
 */
export function parseStartupParams(search: string): StartupParams {
    const params = new URLSearchParams(search);
    return {
        plugins: params.getAll("plugin").filter((x) => x.trim().length > 0),
        fileUrl: params.get("url") ?? params.get("model") ?? undefined,
        mcpUrl: params.get("mcp") ?? undefined,
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

/** Startup params that may carry a secret (`?mcp=` holds the local bridge URL with its pairing `?token=`). */
const SECRET_PARAMS = ["mcp"];

/**
 * Takes the secret-carrying startup params out of the address bar and the history once they are
 * read (the rest stays, so a reload still loads the same plugins and file), so the token is not
 * shown, bookmarked, shared or kept in the history.
 */
export function dropSecretParams(location: Location, history: History): void {
    const params = new URLSearchParams(location.search);
    if (!SECRET_PARAMS.some((name) => params.has(name))) return;
    for (const name of SECRET_PARAMS) params.delete(name);
    const query = params.toString();
    history.replaceState(
        history.state,
        "",
        `${location.pathname}${query ? `?${query}` : ""}${location.hash}`,
    );
}
