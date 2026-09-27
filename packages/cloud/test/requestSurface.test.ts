// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../../..");

/**
 * Every place that talks to the network without `CloudClient` — which adds the CSRF header
 * (`X-Spicy3D-Request: 1`) to each unsafe request. Each one was reviewed (CLOUD-17): none sends a
 * state-changing request to the server's `/api`. A new one fails here until it is reviewed and
 * added, with the reason.
 */
const REVIEWED: Record<string, string> = {
    "packages/ai/src/mcp/pageTransport.ts": "WebSocket to /ws/mcp-page (the server checks its Origin)",
    "packages/app/src/application.ts": "GET of a ?url= file, through ExternalContentPolicy",
    "packages/app/src/pluginManager.ts": "GET of plugin files, through ExternalContentPolicy",
    "packages/builder/src/appBuilder.ts": "GET of the app's own plugins/plugins.json",
    "packages/cloud/src/client.ts": "CloudClient itself",
    "packages/cloud/src/config.ts": "GET /api/config (anonymous, safe method)",
    "packages/cloud/src/settings/userSettings.ts": "a method named fetch; requests go through Account.call",
    "packages/cloud/src/sync/events.ts": "WebSocket to /ws/events (the server checks its Origin)",
    "packages/core/src/deploymentConfig.ts": "GET of the app's own deployment.json",
    "packages/ui/src/mainWindow.ts": "GET of the app's own iconfont.js",
};

const NETWORK = /\bfetch\(|XMLHttpRequest|sendBeacon|new WebSocket\(|new EventSource\(/;

function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) return name === "node_modules" ? [] : sources(path);
        return path.endsWith(".ts") && !path.endsWith(".generated.ts") ? [path] : [];
    });
}

test("network access outside CloudClient is limited to the reviewed places", () => {
    const packages = readdirSync(join(root, "packages")).filter((name) =>
        statSync(join(root, "packages", name, "src"), { throwIfNoEntry: false })?.isDirectory(),
    );
    const found = packages
        .flatMap((name) => sources(join(root, "packages", name, "src")))
        .filter((path) => NETWORK.test(readFileSync(path, "utf8")))
        .map((path) => relative(root, path).replaceAll("\\", "/"))
        .sort();

    expect(found).toEqual(Object.keys(REVIEWED).sort());
});
