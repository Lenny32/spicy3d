// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Logger } from "./foundation";

/**
 * Settings of one deployment that must not be baked into the build, so the same build runs on a
 * LAN-only server and on a public host: `deployment.json` next to `index.html` (the app's folder),
 * `{}` by default (`public/deployment.json`). An operator replaces it (e.g. mounts a file over it in
 * the web image) to point the MCP panel's downloads at the server or offer an on-prem LLM endpoint.
 *
 * Core only fetches and holds the object; each module reads and validates its own section
 * (`ai`, `mcpBridge`, …) with `DeploymentConfig.section`, so an invalid section never breaks others.
 */
export class DeploymentConfig {
    static readonly FILE = "deployment.json";
    static readonly TIMEOUT_MS = 5000;

    private static data: Readonly<Record<string, unknown>> = {};

    /** The loaded settings; `{}` before `load` and whenever the file is missing or invalid. */
    static get current(): Readonly<Record<string, unknown>> {
        return DeploymentConfig.data;
    }

    /** One module's section, or undefined when absent or not an object. */
    static section(name: string): Readonly<Record<string, unknown>> | undefined {
        const value = DeploymentConfig.data[name];
        return isRecord(value) ? value : undefined;
    }

    /** Replaces the settings (tests, or a caller that got them elsewhere). */
    static set(data: Record<string, unknown>) {
        DeploymentConfig.data = Object.freeze({ ...data });
    }

    static reset() {
        DeploymentConfig.data = {};
    }

    /**
     * `GET <baseUrl>/deployment.json`. Never fails: a missing file, invalid JSON, no network (the
     * server is down, the page came from the HTTP cache) or no answer in time leaves the defaults.
     */
    static async load(options: DeploymentConfigLoadOptions = {}): Promise<Readonly<Record<string, unknown>>> {
        const base = options.baseUrl ?? appFolderUrl();
        const url = new URL(DeploymentConfig.FILE, base.endsWith("/") ? base : `${base}/`).href;
        const fetchFn = options.fetch ?? ((request: Request) => globalThis.fetch(request));
        // A server that accepts the connection but never answers must not hold up the start.
        const timeoutMs = options.timeoutMs ?? DeploymentConfig.TIMEOUT_MS;
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
                controller.abort();
                reject(new Error(`no answer within ${timeoutMs} ms`));
            }, timeoutMs);
        });
        try {
            // Revalidated on every start: an operator's change applies on the next reload.
            const request = new Request(url, {
                cache: "no-cache",
                credentials: "same-origin",
                signal: controller.signal,
            });
            const response = await Promise.race([fetchFn(request), timeout]);
            if (!response.ok) {
                if (response.status !== 404) Logger.warn(`[deployment] ${url} answered ${response.status}`);
                DeploymentConfig.reset();
                return DeploymentConfig.data;
            }
            const value: unknown = JSON.parse(await Promise.race([response.text(), timeout]));
            if (!isRecord(value)) {
                Logger.warn(`[deployment] ${url} is not a JSON object; using the defaults`);
                DeploymentConfig.reset();
            } else {
                DeploymentConfig.set(value);
            }
        } catch (error) {
            Logger.warn(`[deployment] could not read ${url}: ${error}`);
            DeploymentConfig.reset();
        } finally {
            clearTimeout(timer);
        }
        return DeploymentConfig.data;
    }
}

export interface DeploymentConfigLoadOptions {
    /** The folder `deployment.json` is in; defaults to the page's folder. */
    baseUrl?: string;
    fetch?: (request: Request) => Promise<Response>;
    /** How long to wait for the file before starting with the defaults (`DeploymentConfig.TIMEOUT_MS`). */
    timeoutMs?: number;
}

/** The folder of the page (`https://host/sub/` for `https://host/sub/index.html?x`). */
export function appFolderUrl(): string {
    const page = globalThis.document?.baseURI ?? globalThis.location?.href ?? "http://localhost/";
    return new URL(".", page).href;
}

/**
 * `value` as an absolute URL, resolved against the app's folder when relative
 * (`downloads/mcp-bridge/` → `https://host/sub/downloads/mcp-bridge/`); undefined when invalid.
 */
export function resolveAppUrl(value: string, base: string = appFolderUrl()): string | undefined {
    try {
        return new URL(value, base).href;
    } catch {
        return undefined;
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
