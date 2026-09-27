// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../../..");

/**
 * Every place that can talk to the network without `CloudClient` — which adds the CSRF header
 * (`X-Spicy3D-Request: 1`) to each unsafe request — with how many network references it holds
 * (calls, and `fetch` passed on by reference). Each one was reviewed (CLOUD-17): none sends a
 * state-changing request to the server's `/api` with the session cookie. A new file, or a new
 * reference in a listed one, fails here until it is reviewed and the count updated.
 */
const REVIEWED: Record<string, { count: number; why: string }> = {
    "packages/ai/src/mcp/pageTransport.ts": { count: 1, why: "WebSocket to /ws/mcp-page (Origin checked)" },
    "packages/app/src/application.ts": {
        count: 1,
        why: "GET of a ?url= file, through ExternalContentPolicy",
    },
    "packages/app/src/pluginManager.ts": {
        count: 7,
        why: "GETs of plugin files, through ExternalContentPolicy",
    },
    "packages/builder/src/appBuilder.ts": { count: 1, why: "GET of the app's own plugins/plugins.json" },
    "packages/cloud/src/client.ts": { count: 4, why: "CloudClient itself" },
    "packages/cloud/src/config.ts": { count: 3, why: "GET /api/config (anonymous, safe method)" },
    "packages/cloud/src/settings/userSettings.ts": {
        count: 4,
        why: "a method named fetch; its requests go through Account.call",
    },
    "packages/cloud/src/sync/events.ts": { count: 1, why: "WebSocket to /ws/events (Origin checked)" },
    "packages/core/src/deploymentConfig.ts": { count: 3, why: "GET of the app's own deployment.json" },
    "packages/ui/src/mainWindow.ts": { count: 1, why: "GET of the app's own iconfont.js" },
};

/**
 * `fetch` as a call or a reference (`fetch(`, `options.fetch ??`, `fetch: …`, `= fetch;`) — not the
 * word in a message ("failed to fetch the file") — plus sockets, beacons and XHR.
 */
const NETWORK =
    /\bfetch\b(?=\s*[(.;,)?:=\]}]|\s*$)|\bXMLHttpRequest\b|\bsendBeacon\b|\bWebSocket\s*\(|\bEventSource\s*\(/gm;

/** The code without its comments, so prose in them does not count. */
function code(text: string): string {
    return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/.*$/gm, "$1");
}

function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) return name === "node_modules" ? [] : sources(path);
        return /\.(ts|mjs|js)$/.test(path) && !path.endsWith(".generated.ts") && !path.endsWith(".d.ts")
            ? [path]
            : [];
    });
}

test("network access outside CloudClient is limited to the reviewed places", () => {
    const packages = readdirSync(join(root, "packages")).filter((name) =>
        statSync(join(root, "packages", name, "src"), { throwIfNoEntry: false })?.isDirectory(),
    );
    const found: Record<string, number> = {};
    for (const path of packages.flatMap((name) => sources(join(root, "packages", name, "src")))) {
        const count = code(readFileSync(path, "utf8")).match(NETWORK)?.length ?? 0;
        if (count > 0) found[relative(root, path).replaceAll("\\", "/")] = count;
    }

    expect(found).toEqual(
        Object.fromEntries(Object.entries(REVIEWED).map(([path, { count }]) => [path, count])),
    );
});

test("the scan sees calls and references, not prose", () => {
    const sample = [
        "// fetch in a comment",
        'const message = "failed to fetch the file";',
        "await fetch(url);",
        "const f = options.fetch ?? globalThis.fetch;",
        "new WebSocket(u);",
    ].join("\n");
    expect(code(sample).match(NETWORK)).toHaveLength(4);
});
