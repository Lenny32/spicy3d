// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { REDACTED, redactSecrets } from "../foundation/redact";

const MAX_MESSAGE = 1000;
const MAX_STACK = 4000;

/** Quoted text in a message is usually user content (a name, a value typed in a form). */
const QUOTED_PATTERN = /"[^"\n]*"|'[^'\n]*'|“[^”\n]*”|‘[^’\n]*’|«[^»\n]*»/g;
/** File names (`part.step`), with any path in front of them. */
const FILE_PATTERN =
    /(?:\b[A-Za-z]:[\\/])?(?:[\w.~-]*[\\/])*[\w().~-]+\.(?:spicy|cd|step|stp|iges|igs|brep|brp|stl|obj|ply|3mf|svg|dxf|gltf|glb|json|zip|png|jpe?g)\b/gi;
/** Absolute filesystem paths (`/home/x/…`, `C:\Users\…`). */
const PATH_PATTERN = /(?:\b[A-Za-z]:\\|(?<![\w:/])\/(?:home|Users|tmp|var|mnt|media)\/)[^\s"'<>]*/g;

/**
 * How much of a message or stack is looked at. Cut before any pattern runs, so redaction stays
 * cheap however long the (uncontrolled) text is; what is sent is capped shorter still.
 */
const MAX_INPUT = 2 * MAX_STACK;

function truncate(text: string, max: number): string {
    return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * A log message as it may leave the browser: credentials and URL queries masked
 * ({@link redactSecrets}), quoted text, file names and filesystem paths replaced, length capped.
 */
export function telemetryMessage(text: string): string {
    return truncate(
        redactSecrets(text.slice(0, MAX_INPUT))
            .replace(QUOTED_PATTERN, (match) => `${match[0]}${REDACTED}${match[match.length - 1]}`)
            .replace(PATH_PATTERN, REDACTED)
            .replace(FILE_PATTERN, REDACTED),
        MAX_MESSAGE,
    );
}

/**
 * A stack trace as it may leave the browser. The frames point at the app's own scripts; their
 * first line repeats the message, which goes through {@link telemetryMessage}.
 */
export function telemetryStack(stack: string): string {
    const [first, ...frames] = stack.slice(0, MAX_INPUT).split("\n");
    return truncate([telemetryMessage(first), ...frames.map(redactSecrets)].join("\n"), MAX_STACK);
}

/** Browser and OS families only (no versions, no full user agent). */
export function browserFamily(userAgent: string): { browser: string; os: string } {
    const browser = /\bEdg\//.test(userAgent)
        ? "Edge"
        : /\b(?:OPR|Opera)\//.test(userAgent)
          ? "Opera"
          : /\bFirefox\//.test(userAgent)
            ? "Firefox"
            : /(?:Chrome|CriOS|Chromium)\//.test(userAgent)
              ? "Chrome"
              : /\bSafari\//.test(userAgent)
                ? "Safari"
                : "Other";
    const os = /\b(?:iPhone|iPad|iPod)\b/.test(userAgent)
        ? "iOS"
        : /\bAndroid\b/.test(userAgent)
          ? "Android"
          : /\bWindows\b/.test(userAgent)
            ? "Windows"
            : /\bMac OS X\b|\bMacintosh\b/.test(userAgent)
              ? "macOS"
              : /\bCrOS\b/.test(userAgent)
                ? "ChromeOS"
                : /\bLinux\b/.test(userAgent)
                  ? "Linux"
                  : "Other";
    return { browser, os };
}
