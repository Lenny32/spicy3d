// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { parseArgs } from "node:util";

export const DEFAULT_APP_URL = "http://localhost:8080/";
export const DEFAULT_PORT = 7777;

export const USAGE = `Usage: spicy3d-mcp-bridge [options]

MCP stdio server whose tools run in your Spicy3D browser tab. Your MCP client
(Claude Code, Claude Desktop, Cursor, ...) starts it; the Spicy3D page connects
to it from the MCP panel. Copy the ready-made command from that panel.

Options:
  -u, --app-url <url>        Address of the Spicy3D page, e.g. https://cad.example.com/
                             Only pages from this origin may connect.   [env SPICY3D_APP_URL, default ${DEFAULT_APP_URL}]
  -p, --port <n>             WebSocket port on 127.0.0.1                [env SPICY3D_BRIDGE_PORT, default ${DEFAULT_PORT}]
  -t, --token <secret>       Pairing token shown in the MCP panel       [env SPICY3D_BRIDGE_TOKEN, default random]
      --no-token             Accept the page without a token. INSECURE: any program
                             on this machine can then drive the tab.    [env SPICY3D_BRIDGE_NO_TOKEN=1]
      --allow-origin <url>   Also accept pages from this origin (repeatable) [env SPICY3D_ALLOWED_ORIGINS, comma-separated]
  -h, --help                 Show this help
  -v, --version              Show the version
`;

/**
 * Bridge options from argv and the environment; a flag wins over its variable. Throws with a
 * user-facing message on invalid input.
 * @param {string[]} argv
 * @param {Record<string, string | undefined>} env
 */
export function parseOptions(argv, env) {
    const { values } = parseArgs({
        args: argv,
        strict: true,
        options: {
            "app-url": { type: "string", short: "u" },
            port: { type: "string", short: "p" },
            token: { type: "string", short: "t" },
            "no-token": { type: "boolean" },
            "allow-origin": { type: "string", multiple: true },
            help: { type: "boolean", short: "h" },
            version: { type: "boolean", short: "v" },
        },
    });

    const appUrlText = values["app-url"] ?? env["SPICY3D_APP_URL"] ?? DEFAULT_APP_URL;
    let appUrl;
    try {
        appUrl = new URL(appUrlText);
    } catch {
        throw new Error(`--app-url is not a valid URL: ${appUrlText}`);
    }
    if (appUrl.protocol !== "http:" && appUrl.protocol !== "https:") {
        throw new Error(`--app-url must be an http(s) address, got ${appUrlText}`);
    }

    const portText = values.port ?? env["SPICY3D_BRIDGE_PORT"] ?? String(DEFAULT_PORT);
    const port = Number(portText);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`--port must be an integer between 1 and 65535, got ${portText}`);
    }

    const noToken = values["no-token"] === true || env["SPICY3D_BRIDGE_NO_TOKEN"] === "1";
    const token = noToken ? "" : (values.token ?? env["SPICY3D_BRIDGE_TOKEN"] ?? "");
    if (values.token !== undefined && values["no-token"]) {
        throw new Error("--token and --no-token cannot be used together");
    }

    const extraOrigins = [
        ...(values["allow-origin"] ?? []),
        ...(env["SPICY3D_ALLOWED_ORIGINS"] ?? "").split(","),
    ]
        .map((o) => o.trim())
        .filter(Boolean)
        .map((o) => {
            try {
                return new URL(o).origin;
            } catch {
                throw new Error(`--allow-origin is not a valid URL: ${o}`);
            }
        });

    return {
        help: values.help === true,
        version: values.version === true,
        appUrl: appUrl.toString(),
        port,
        noToken,
        /** Empty when unset (the caller generates one) or in no-token mode. */
        token,
        allowedOrigins: new Set([appUrl.origin, ...extraOrigins]),
    };
}
