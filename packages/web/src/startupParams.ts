// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

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
