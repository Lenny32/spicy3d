// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

// The server stores and returns UTC only; the client shows it in the browser's locale and time zone.
// CLOUD-08 extends these helpers (relative times, grouping); every cloud timestamp goes through them.

/** An ISO 8601 date-time that states its offset: `Z` or `±hh:mm` (`±hhmm`, `±hh`). */
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:Z|[+-]\d{2}(?::?\d{2})?)$/i;

/**
 * A server timestamp as epoch milliseconds, or `NaN` when it isn't an ISO 8601 date-time with a zone
 * designator: `Date` would read `2026-03-29T00:30:00` as local time, which is never what the server meant.
 */
export function parseUtc(iso: string): number {
    if (typeof iso !== "string" || !ISO_WITH_ZONE.test(iso.trim())) return Number.NaN;
    return Date.parse(iso.trim().replace(",", "."));
}

export interface DateTimeFormatOptions {
    /** Defaults to the browser's locale (not the UI language). */
    locale?: string | string[];
    /** Defaults to the system time zone; tests pin it. */
    timeZone?: string;
}

/**
 * Date and time in the browser's locale and time zone, e.g. "27 Sept 2026, 14:05"; empty for an
 * invalid time. Format at render time: the zone can change while the app is open (travel, DST).
 */
export function formatDateTime(epochMs: number, options: DateTimeFormatOptions = {}): string {
    if (!Number.isFinite(epochMs)) return "";
    return new Intl.DateTimeFormat(options.locale, {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: options.timeZone,
    }).format(epochMs);
}
