// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

// Runtime discovery of the server. Imports nothing but types beyond core, so the local-only path
// (static hosting, no server) never loads the API client.

import { Logger, ObjectStorage } from "@spicy3d/core";
import type { ConfigResponse } from "./api";

/**
 * The `apiVersion` majors this client speaks. The server bumps `apiVersion` on a breaking change of
 * the HTTP contract; widen `max` once the client handles the new version.
 */
export const SUPPORTED_API_VERSIONS = { min: 1, max: 1 } as const;

export type ApiVersionRange = { readonly min: number; readonly max: number };

/** `serverNewer`: the app is outdated, a reload fetches the matching one. `serverOlder`: the server is. */
export type ApiCompatibility = "compatible" | "serverNewer" | "serverOlder";

export type CloudDiscovery =
    /** No Spicy3D server answers here (static hosting, dev server, offline): the app is local-only. */
    | { status: "dormant" }
    /** A server answers, but with a contract this client doesn't speak. */
    | {
          status: "incompatible";
          config: ConfigResponse;
          compatibility: Exclude<ApiCompatibility, "compatible">;
      }
    /** `offline`: the server is out of reach, `config` is the one it answered last time. */
    | { status: "ready"; config: ConfigResponse; offline?: boolean };

export interface DiscoveryOptions {
    /** See `CloudClientOptions.baseUrl`; defaults to the folder the app is served from. */
    baseUrl?: string;
    fetch?: (request: Request) => Promise<Response>;
    signal?: AbortSignal;
    /**
     * Remembers the server's config (`localStorage`, `cloud.config`), so the cloud starts when the
     * server is out of reach (a LAN server down, the network gone): cached documents and pending
     * saves stay usable. `true` = `ObjectStorage.default`.
     */
    offlineCache?: boolean | ObjectStorage;
}

const CONFIG_CACHE_KEY = "cloud.config";

function cacheOf(option: DiscoveryOptions["offlineCache"]): ObjectStorage | undefined {
    if (!option) return undefined;
    return option === true ? ObjectStorage.default : option;
}

/** The folder of the page without trailing slash, so an app under `/sub/` finds `/sub/api`. */
export function defaultBaseUrl(): string {
    const page = globalThis.document?.baseURI ?? globalThis.location?.href ?? "http://localhost/";
    return new URL(".", page).href.replace(/\/+$/, "");
}

/** Where `apiVersion` (`"1"`, `"2.1"`: the major counts) falls relative to `range`. */
export function checkApiVersion(
    apiVersion: string,
    range: ApiVersionRange = SUPPORTED_API_VERSIONS,
): ApiCompatibility {
    const match = /^\s*v?(\d+)(?:\.\d+)*\s*$/i.exec(apiVersion);
    // A version this client can't even parse comes from a server newer than it.
    if (!match) return "serverNewer";
    const major = Number(match[1]);
    if (major > range.max) return "serverNewer";
    if (major < range.min) return "serverOlder";
    return "compatible";
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Enough of `ConfigResponse` to tell a Spicy3D server from anything else answering at that URL. */
function isConfig(value: unknown): value is ConfigResponse {
    if (!isRecord(value)) return false;
    const config: { readonly [K in keyof ConfigResponse]?: unknown } = value;
    return (
        // A string in the first contract, an integer since (SpicySrv 908bf51 and before).
        (typeof config.apiVersion === "string" || typeof config.apiVersion === "number") &&
        typeof config.version === "string" &&
        isRecord(config.features)
    );
}

/**
 * `GET /api/config` (anonymous). Every answer that isn't a Spicy3D config — 404 from static hosting,
 * the app's own placeholder (`public/api/config`), HTML, invalid JSON, no network — means dormant:
 * never an error, never a toast.
 */
export async function discoverCloud(options: DiscoveryOptions = {}): Promise<CloudDiscovery> {
    const baseUrl = (options.baseUrl ?? defaultBaseUrl()).replace(/\/+$/, "");
    const fetchFn = options.fetch ?? ((request: Request) => globalThis.fetch(request));
    const request = new Request(`${baseUrl}/api/config`, {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
        headers: { Accept: "application/json" },
        signal: options.signal,
    });

    const cache = cacheOf(options.offlineCache);
    // The server is down or something else answers in its place (a proxy's 502, a captive
    // portal's page): the last config starts the cloud offline, and stays cached.
    const outOfReach = (reason: string): CloudDiscovery => {
        const cached = readCachedConfig(cache);
        if (cached && checkApiVersion(String(cached.apiVersion)) === "compatible") {
            Logger.info(`[cloud] ${request.url} ${reason}; starting offline with the last config`);
            return { status: "ready", config: cached, offline: true };
        }
        return dormant(`${request.url} ${reason}`);
    };
    let config: unknown;
    let response: Response;
    try {
        response = await fetchFn(request);
    } catch {
        return outOfReach("is unreachable");
    }
    // Only a definite "nothing here" (404 from a reachable origin) forgets the cached server.
    if (response.status === 404) return dormant(`${request.url} answered 404`, cache);
    if (!response.ok) {
        return response.status >= 500
            ? outOfReach(`answered ${response.status}`)
            : dormant(`${request.url} answered ${response.status}`);
    }
    try {
        config = JSON.parse(await response.text());
    } catch {
        return outOfReach("answered something that is not JSON");
    }
    // JSON, but no config (the app's own placeholder): no server now; the cached one is kept.
    if (!isConfig(config)) return dormant(`${request.url} is not a Spicy3D server`);

    const compatibility = checkApiVersion(String(config.apiVersion));
    if (compatibility !== "compatible") {
        Logger.warn(
            `[cloud] server API ${config.apiVersion} is outside the supported range ` +
                `${SUPPORTED_API_VERSIONS.min}–${SUPPORTED_API_VERSIONS.max}`,
        );
        cache?.remove(CONFIG_CACHE_KEY);
        return { status: "incompatible", config, compatibility };
    }
    cache?.setValue(CONFIG_CACHE_KEY, config);
    return { status: "ready", config };
}

function readCachedConfig(cache: ObjectStorage | undefined): ConfigResponse | undefined {
    try {
        const config = cache?.value<unknown>(CONFIG_CACHE_KEY, undefined);
        return isConfig(config) ? config : undefined;
    } catch {
        return undefined;
    }
}

/** A definite answer that no Spicy3D server is here (`cache` given) also forgets the one cached. */
function dormant(reason: string, cache?: ObjectStorage): CloudDiscovery {
    Logger.info(`[cloud] no server (${reason}); local-only`);
    cache?.remove(CONFIG_CACHE_KEY);
    return { status: "dormant" };
}
