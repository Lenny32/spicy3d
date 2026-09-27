// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { PubSub } from "@spicy3d/core";

export const INSECURE_CONTEXT_BANNER_ID = "app.insecureContext";

/** Hosts browsers treat as a secure context even over plain HTTP. */
export function isLoopbackHost(hostname: string): boolean {
    const host = hostname.toLowerCase();
    return (
        host === "localhost" ||
        host.endsWith(".localhost") ||
        /^127(\.\d{1,3}){3}$/.test(host) ||
        host === "[::1]" ||
        host === "::1"
    );
}

/**
 * Whether the page lost the secure-context features (`crypto.subtle`, Web Locks, clipboard, File
 * System Access, the server's `__Host-`/Secure session cookie): plain HTTP on anything but this
 * machine, e.g. a LAN address or name. `undefined` (no such API) counts as secure.
 */
export function isInsecureRemoteContext(secure: boolean | undefined, hostname: string): boolean {
    return secure === false && !isLoopbackHost(hostname);
}

/** The startup banner explaining that HTTPS is needed; dismissible, the app keeps working locally. */
export function warnIfInsecureContext(
    secure: boolean | undefined = globalThis.isSecureContext,
    hostname: string = globalThis.location?.hostname ?? "",
): boolean {
    if (!isInsecureRemoteContext(secure, hostname)) return false;
    PubSub.default.pub("showBanner", {
        id: INSECURE_CONTEXT_BANNER_ID,
        level: "warn",
        message: "app.insecureContext",
    });
    return true;
}
