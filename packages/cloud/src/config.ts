// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

// Runtime discovery of the server. Imports nothing but types beyond core, so the local-only path
// (static hosting, no server) never loads the API client.

import { Logger } from "@spicy3d/core";
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
    | { status: "ready"; config: ConfigResponse };

export interface DiscoveryOptions {
    /** See `CloudClientOptions.baseUrl`; defaults to the folder the app is served from. */
    baseUrl?: string;
    fetch?: (request: Request) => Promise<Response>;
    signal?: AbortSignal;
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
        typeof config.apiVersion === "string" &&
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

    let config: unknown;
    try {
        const response = await fetchFn(request);
        if (!response.ok) return dormant(`${request.url} answered ${response.status}`);
        config = JSON.parse(await response.text());
    } catch {
        return dormant(`${request.url} is unreachable or not JSON`);
    }
    if (!isConfig(config)) return dormant(`${request.url} is not a Spicy3D server`);

    const compatibility = checkApiVersion(config.apiVersion);
    if (compatibility !== "compatible") {
        Logger.warn(
            `[cloud] server API ${config.apiVersion} is outside the supported range ` +
                `${SUPPORTED_API_VERSIONS.min}–${SUPPORTED_API_VERSIONS.max}`,
        );
        return { status: "incompatible", config, compatibility };
    }
    return { status: "ready", config };
}

function dormant(reason: string): CloudDiscovery {
    Logger.info(`[cloud] no server (${reason}); local-only`);
    return { status: "dormant" };
}
