// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { I18n } from "../../i18n";

// The server stores and returns UTC only; the client shows it in the browser's locale and time zone.
// Every cloud timestamp goes through these helpers (`test/dateTimeGuard.test.ts` enforces it): parse with
// `parseUtc`, format at render time — never keep a formatted string in long-lived state, the zone can
// change while the app is open (travel, DST) and relative labels age.

/**
 * The locale every date is formatted in: `undefined` = the browser's locale, deliberately not the UI
 * language (an English UI on a French system still shows "27 sept. 2026"). The one place to change that.
 */
export const DATE_LOCALE: string | undefined = undefined;

/**
 * An ISO 8601 date-time that states its offset: `Z` or `±hh:mm`. Seconds and a fraction are optional;
 * a date alone, a space instead of `T`, a basic-format offset (`+0200`) or no offset at all are refused.
 */
const ISO_WITH_ZONE =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?(?:Z|([+-])(\d{2}):(\d{2}))$/i;

/**
 * A server timestamp as epoch milliseconds, or `NaN` when it isn't a valid ISO 8601 date-time with a
 * zone designator: `Date` would read `2026-03-29T00:30:00` as local time (and `2026-03-29` as UTC, and
 * `2026-02-30` as 2 March), which is never what the server meant. `NaN` rather than a `Result` so a
 * bad value flows through `formatDateTime` & co. as an empty string; test with `Number.isFinite`.
 */
export function parseUtc(iso: string): number {
    if (typeof iso !== "string") return Number.NaN;
    const match = ISO_WITH_ZONE.exec(iso.trim());
    if (!match) return Number.NaN;
    const [, y, mo, d, h, mi, s = "0", fraction = "", sign, oh = "0", om = "0"] = match;
    const [year, month, day, hour, minute, second] = [y, mo, d, h, mi, s].map(Number);
    const local = Date.UTC(year, month - 1, day, hour, minute, second);
    const check = new Date(local);
    const valid =
        check.getUTCFullYear() === year &&
        check.getUTCMonth() === month - 1 &&
        check.getUTCDate() === day &&
        check.getUTCHours() === hour &&
        check.getUTCMinutes() === minute &&
        check.getUTCSeconds() === second &&
        Number(oh) <= 23 &&
        Number(om) <= 59;
    if (!valid) return Number.NaN;
    const millis = Number(fraction.padEnd(3, "0").slice(0, 3));
    const offset = (sign === "-" ? -1 : 1) * (Number(oh) * 60 + Number(om)) * 60_000;
    return local + millis - offset;
}

export interface DateTimeFormatOptions {
    /** Defaults to `DATE_LOCALE`: the browser's locale (not the UI language). */
    locale?: string | string[];
    /** Defaults to the system time zone; tests pin it. */
    timeZone?: string;
}

export interface RelativeTimeOptions extends DateTimeFormatOptions {
    /** The local clock by default — used for display only, never for ordering. */
    now?: number;
}

const locale = (options: DateTimeFormatOptions) => options.locale ?? DATE_LOCALE;

/**
 * Date and time in the browser's locale and time zone, e.g. "27 Sept 2026, 14:05"; empty for an
 * invalid time.
 */
export function formatDateTime(epochMs: number, options: DateTimeFormatOptions = {}): string {
    if (!Number.isFinite(epochMs)) return "";
    return new Intl.DateTimeFormat(locale(options), {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: options.timeZone,
    }).format(epochMs);
}

/** The date only, e.g. "27 Sept 2026"; empty for an invalid time. */
export function formatDate(epochMs: number, options: DateTimeFormatOptions = {}): string {
    if (!Number.isFinite(epochMs)) return "";
    return new Intl.DateTimeFormat(locale(options), {
        dateStyle: "medium",
        timeZone: options.timeZone,
    }).format(epochMs);
}

/** The time only, in the browser's locale and time zone, e.g. "14:05"; empty for an invalid time. */
export function formatTime(epochMs: number, options: DateTimeFormatOptions = {}): string {
    if (!Number.isFinite(epochMs)) return "";
    return new Intl.DateTimeFormat(locale(options), {
        timeStyle: "short",
        timeZone: options.timeZone,
    }).format(epochMs);
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** Beyond this many calendar days, a relative label gives way to the date. */
const RELATIVE_DAYS = 7;

/** The calendar day of an instant in a time zone, as a day count (days since 1970-01-01 there). */
export function localDayNumber(epochMs: number, timeZone?: string): number {
    const parts = new Intl.DateTimeFormat("en-US", {
        year: "numeric",
        month: "numeric",
        day: "numeric",
        timeZone,
    }).formatToParts(epochMs);
    const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value);
    return Math.round(Date.UTC(part("year"), part("month") - 1, part("day")) / (24 * HOUR));
}

/**
 * How many calendar days `epochMs` lies before `now` in the time zone (0 = same day, 1 = yesterday):
 * counted on the calendar, not as 24 h spans, so a 23 h or 25 h DST day is still one day.
 */
export function calendarDaysAgo(epochMs: number, now: number, timeZone?: string): number {
    return localDayNumber(now, timeZone) - localDayNumber(epochMs, timeZone);
}

/**
 * "just now", "5 minutes ago", "3 hours ago", "yesterday", "4 days ago" — then the date once it is a
 * week old or more; empty for an invalid time. A time slightly in the future (clock skew) reads "now".
 * Show `formatDateTime` next to it, e.g. in a tooltip (`setRelativeTime`).
 */
export function formatRelative(epochMs: number, options: RelativeTimeOptions = {}): string {
    if (!Number.isFinite(epochMs)) return "";
    const now = options.now ?? Date.now();
    const elapsed = Math.max(0, now - epochMs);
    const format = new Intl.RelativeTimeFormat(locale(options), { numeric: "auto" });
    if (elapsed < 45_000) return format.format(0, "second");
    if (elapsed < 45 * MINUTE) return format.format(-Math.max(1, Math.round(elapsed / MINUTE)), "minute");
    const days = calendarDaysAgo(epochMs, now, options.timeZone);
    if (elapsed < 22 * HOUR || days === 0)
        return format.format(-Math.max(1, Math.round(elapsed / HOUR)), "hour");
    if (days < RELATIVE_DAYS) return format.format(-days, "day");
    return formatDate(epochMs, options);
}

/** Set on elements that `setRelativeTime` filled, so `refreshRelativeTimes` can find them again. */
const RELATIVE_TIME_ATTRIBUTE = "data-relative-time";

/**
 * Shows a relative time in `element` with the full date and time as its tooltip (`title`), and marks
 * it for `refreshRelativeTimes`. An invalid time leaves both empty. Returns the element.
 */
export function setRelativeTime<T extends HTMLElement>(
    element: T,
    epochMs: number,
    options: RelativeTimeOptions = {},
): T {
    element.textContent = formatRelative(epochMs, options);
    element.title = formatDateTime(epochMs, options);
    if (Number.isFinite(epochMs)) element.setAttribute(RELATIVE_TIME_ATTRIBUTE, String(epochMs));
    else element.removeAttribute(RELATIVE_TIME_ATTRIBUTE);
    return element;
}

/**
 * A sentence around a relative time, e.g. `(time) => I18n.translate("account.session.lastSeen{0}", time)`
 * → `["Last active ", <span title="27 Sept 2026, 14:05">5 minutes ago</span>, ""]`: the words come
 * from the translation, the time is its own element so `refreshRelativeTimes` can update it alone.
 */
export function relativeTimeParts(
    sentence: (time: string) => string,
    epochMs: number,
    options: RelativeTimeOptions = {},
): (string | HTMLElement)[] {
    const marker = "\u0000";
    const [before, after = ""] = sentence(marker).split(marker);
    return [before, setRelativeTime(document.createElement("span"), epochMs, options), after];
}

/** Formats again every relative time under `root` (they age; the zone may have changed). */
export function refreshRelativeTimes(root: ParentNode, options: RelativeTimeOptions = {}): void {
    for (const element of root.querySelectorAll<HTMLElement>(`[${RELATIVE_TIME_ATTRIBUTE}]`)) {
        setRelativeTime(element, Number(element.getAttribute(RELATIVE_TIME_ATTRIBUTE)), options);
    }
}

/**
 * Keeps the relative times under `root` fresh: every minute while the page is visible, and when the
 * page becomes visible again. Returns the stop function; call it when `root` goes away.
 */
export function watchRelativeTimes(root: ParentNode, intervalMs = MINUTE): () => void {
    const refresh = () => {
        if (globalThis.document?.visibilityState !== "hidden") refreshRelativeTimes(root);
    };
    const timer = setInterval(refresh, intervalMs);
    globalThis.document?.addEventListener("visibilitychange", refresh);
    return () => {
        clearInterval(timer);
        globalThis.document?.removeEventListener("visibilitychange", refresh);
    };
}

export interface DateGroup<T> {
    /** Stable across renders: `today`, `yesterday`, `last7Days`, or `YYYY-MM` for a month. */
    key: string;
    label: string;
    items: T[];
}

/**
 * Groups items by local calendar day, the way the version history shows them: "Today", "Yesterday",
 * "Last 7 days" (2 to 6 days ago), then one group per month ("August 2026"). Computed in the local time
 * zone on calendar days, so DST switches don't move items across groups. Keeps the items' order (pass
 * them newest first); a time in the future (clock skew) counts as today, an invalid one goes last.
 */
export function groupByLocalDay<T>(
    items: readonly T[],
    timeOf: (item: T) => number,
    options: RelativeTimeOptions = {},
): DateGroup<T>[] {
    const now = options.now ?? Date.now();
    const month = new Intl.DateTimeFormat(locale(options), {
        year: "numeric",
        month: "long",
        timeZone: options.timeZone,
    });
    const groups = new Map<string, DateGroup<T>>();
    const add = (key: string, label: () => string, item: T) => {
        let group = groups.get(key);
        if (!group) {
            group = { key, label: label(), items: [] };
            groups.set(key, group);
        }
        group.items.push(item);
    };
    const invalid: T[] = [];
    for (const item of items) {
        const time = timeOf(item);
        if (!Number.isFinite(time)) {
            invalid.push(item);
            continue;
        }
        const days = calendarDaysAgo(time, now, options.timeZone);
        if (days <= 0) add("today", () => I18n.translate("dateTime.today"), item);
        else if (days === 1) add("yesterday", () => I18n.translate("dateTime.yesterday"), item);
        else if (days < RELATIVE_DAYS) add("last7Days", () => I18n.translate("dateTime.last7Days"), item);
        else {
            const parts = new Intl.DateTimeFormat("en-US", {
                year: "numeric",
                month: "2-digit",
                timeZone: options.timeZone,
            }).formatToParts(time);
            const key = `${parts.find((p) => p.type === "year")?.value}-${parts.find((p) => p.type === "month")?.value}`;
            add(key, () => month.format(time), item);
        }
    }
    const result = [...groups.values()];
    if (invalid.length > 0) {
        result.push({ key: "unknown", label: I18n.translate("dateTime.unknown"), items: invalid });
    }
    return result;
}
