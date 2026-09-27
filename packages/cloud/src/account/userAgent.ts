// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

export interface DeviceDescription {
    browser?: string;
    os?: string;
}

const BROWSERS: [RegExp, string][] = [
    [/\bEdg(?:e|A|iOS)?\//, "Edge"],
    [/\b(?:OPR|Opera)\//, "Opera"],
    [/\bVivaldi\//, "Vivaldi"],
    [/\bSamsungBrowser\//, "Samsung Internet"],
    [/\b(?:Firefox|FxiOS)\//, "Firefox"],
    [/\b(?:Chrome|CriOS|Chromium)\//, "Chrome"],
    [/\bVersion\/[\d.]+.*\bSafari\//, "Safari"],
];

const SYSTEMS: [RegExp, string][] = [
    [/\bWindows\b/, "Windows"],
    [/\bAndroid\b/, "Android"],
    [/\b(?:iPhone|iPad|iPod)\b/, "iOS"],
    [/\bCrOS\b/, "ChromeOS"],
    [/\bMac OS X\b|\bMacintosh\b/, "macOS"],
    [/\bLinux\b/, "Linux"],
];

/**
 * A readable device for the sessions list ("Firefox", "Windows") from a user agent. A client that
 * isn't a browser (`curl/8.5.0`) reads as its product name; nothing recognizable gives `{}`.
 */
export function describeUserAgent(userAgent: string | null | undefined): DeviceDescription {
    if (!userAgent) return {};
    const browser = BROWSERS.find(([pattern]) => pattern.test(userAgent))?.[1];
    const os = SYSTEMS.find(([pattern]) => pattern.test(userAgent))?.[1];
    if (browser || os) return { browser, os };
    const product = /^([A-Za-z][\w.-]*)\//.exec(userAgent)?.[1];
    return product ? { browser: product } : {};
}
