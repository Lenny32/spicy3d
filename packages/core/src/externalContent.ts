// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { DeploymentConfig } from "./deploymentConfig";

/**
 * What the app loads from a URL it did not choose itself: a plugin (`?plugin=`, the plugin manager
 * — code that runs with the page's full rights, the signed-in session included) or a file to open
 * (`?url=` / `?model=`).
 */
export type ExternalContentKind = "plugin" | "file";

export type ExternalContentDecision =
    /** Same origin, or allowlisted by the deployment (or, signed out, a plugin origin the user trusted). */
    | { readonly verdict: "allowed"; readonly url: URL }
    /** Anything else: loaded only after the user confirms a prompt naming `url.origin`. */
    | { readonly verdict: "ask"; readonly url: URL }
    /** Not an http(s) URL: never loaded. */
    | { readonly verdict: "refused"; readonly reason: string };

export interface ExternalContentOptions {
    /** The page's own URL (default `location.href`). */
    pageUrl?: string;
    /**
     * Plugin origins (or, from older versions, hosts) the user chose to trust while signed out
     * (`Config.trustedDomains`). Ignored while a cloud session may exist.
     */
    trusted?: readonly string[];
}

/** The `deployment.json` keys of each kind's allowlist, in its `security` section. */
const ALLOWLIST_KEYS: Record<ExternalContentKind, string> = {
    plugin: "pluginOrigins",
    file: "fileOrigins",
};

const ORIGIN_PATTERN = /^https?:\/\/(\*\.)?[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*(:\d{1,5})?$/;

/**
 * Which external URLs load without asking (CLOUD-17). The rules:
 *
 * - only `http:` / `https:` URLs, resolved against the page (so `plugins/x/` is the app's own);
 * - the page's own origin and the deployment's allowlist (`deployment.json`:
 *   `{ "security": { "pluginOrigins": [...], "fileOrigins": [...] } }`, entries like
 *   `https://plugins.example.com`, or a subdomain wildcard: `*.` before the host) load at once;
 * - a plugin origin the user trusted earlier loads at once only while **no** cloud session may
 *   exist: signed in (or not known yet), every other plugin asks again, naming its origin;
 * - everything else asks, every time for files.
 *
 * The cloud tells the policy whether a session may exist with {@link setSessionProbe}; without a
 * cloud there is none.
 */
export class ExternalContentPolicy {
    private static sessionProbe: () => boolean = () => false;

    /**
     * Whether a cloud session may exist in this tab (signed in, expired or not known yet); returns
     * the function that removes the probe.
     */
    static setSessionProbe(probe: () => boolean): () => void {
        ExternalContentPolicy.sessionProbe = probe;
        return () => {
            if (ExternalContentPolicy.sessionProbe === probe)
                ExternalContentPolicy.sessionProbe = () => false;
        };
    }

    static get hasSession(): boolean {
        try {
            return ExternalContentPolicy.sessionProbe();
        } catch {
            return true; // unknown: the safe answer
        }
    }

    /** The deployment's allowlisted origins for `kind`; invalid entries are ignored. */
    static allowedOrigins(kind: ExternalContentKind): string[] {
        const list = DeploymentConfig.section("security")?.[ALLOWLIST_KEYS[kind]];
        if (!Array.isArray(list)) return [];
        return list
            .filter((x): x is string => typeof x === "string")
            .map((x) => x.trim().replace(/\/+$/, "").toLowerCase())
            .filter((x) => ORIGIN_PATTERN.test(x));
    }

    static evaluate(
        raw: string,
        kind: ExternalContentKind,
        options: ExternalContentOptions = {},
    ): ExternalContentDecision {
        const pageUrl = options.pageUrl ?? globalThis.location?.href ?? "http://localhost/";
        let url: URL;
        try {
            url = new URL(raw.trim(), pageUrl);
        } catch {
            return { verdict: "refused", reason: "not a URL" };
        }
        if (url.protocol !== "https:" && url.protocol !== "http:") {
            return { verdict: "refused", reason: `${url.protocol} URLs are not loaded` };
        }
        if (url.username || url.password) {
            return { verdict: "refused", reason: "URLs with credentials are not loaded" };
        }
        if (url.origin === safeOrigin(pageUrl)) return { verdict: "allowed", url };
        if (ExternalContentPolicy.allowedOrigins(kind).some((entry) => originMatches(entry, url))) {
            return { verdict: "allowed", url };
        }
        if (kind === "plugin" && !ExternalContentPolicy.hasSession) {
            const trusted = options.trusted ?? [];
            // Older versions stored the host alone: kept for https only (http could be anyone on the way).
            if (trusted.includes(url.origin) || (url.protocol === "https:" && trusted.includes(url.host))) {
                return { verdict: "allowed", url };
            }
        }
        return { verdict: "ask", url };
    }
}

function safeOrigin(url: string): string | undefined {
    try {
        return new URL(url).origin;
    } catch {
        return undefined;
    }
}

/** An entry matches that origin only; with `*.` before its host, any subdomain of that host (not the host itself). */
export function originMatches(entry: string, url: URL): boolean {
    const wildcard = /^(https?:)\/\/\*\.(.+)$/.exec(entry);
    if (!wildcard) return entry === url.origin;
    const [, protocol, rest] = wildcard;
    if (url.protocol !== protocol) return false;
    const host = url.port ? `${url.hostname}:${url.port}` : url.hostname;
    return host.endsWith(`.${rest}`);
}
