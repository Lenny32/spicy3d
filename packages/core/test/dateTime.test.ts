// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import {
    calendarDaysAgo,
    DATE_LOCALE,
    formatDate,
    formatDateTime,
    formatRelative,
    formatTime,
    groupByLocalDay,
    I18n,
    parseUtc,
    refreshRelativeTimes,
    relativeTimeParts,
    setRelativeTime,
    watchRelativeTimes,
} from "../src";

describe("parseUtc", () => {
    test.each([
        ["2026-03-29T00:30:00Z", Date.UTC(2026, 2, 29, 0, 30)],
        ["2026-03-29T00:30:00.123Z", Date.UTC(2026, 2, 29, 0, 30, 0, 123)],
        ["2026-03-29T00:30:00.1234567z", Date.UTC(2026, 2, 29, 0, 30, 0, 123)],
        ["2026-03-29T02:30:00+02:00", Date.UTC(2026, 2, 29, 0, 30)],
        ["2026-03-28T19:30:00-05:00", Date.UTC(2026, 2, 29, 0, 30)],
        ["2026-03-29T00:30Z", Date.UTC(2026, 2, 29, 0, 30)],
        ["2026-03-29T00:30:00,5Z", Date.UTC(2026, 2, 29, 0, 30, 0, 500)],
        ["2026-03-29T06:00:00+05:30", Date.UTC(2026, 2, 29, 0, 30)],
        ["2024-02-29T12:00:00Z", Date.UTC(2024, 1, 29, 12)],
        ["  2026-03-29T00:30:00Z ", Date.UTC(2026, 2, 29, 0, 30)],
    ])("reads %s", (iso, expected) => {
        expect(parseUtc(iso)).toBe(expected);
    });

    test.each([
        "2026-03-29T00:30:00",
        "2026-03-29",
        "2026-03-29 00:30:00Z",
        "2026-03-29T00:30:00+0200",
        "2026-03-29T00:30:00+02",
        "2026-03-29T00:30:00+24:00",
        "2026-03-29T00:30:00+02:60",
        "2026-02-30T00:30:00Z",
        "2026-02-29T00:30:00Z",
        "2026-13-01T00:30:00Z",
        "2026-03-29T24:00:00Z",
        "2026-03-29T00:60:00Z",
        "2026-03-29T00:30:60Z",
        "20260329T003000Z",
        "Sun, 29 Mar 2026 00:30:00 GMT",
        "",
        "yesterday",
    ])("rejects %j (no zone designator, local form or not a valid date-time)", (iso) => {
        expect(parseUtc(iso)).toBeNaN();
    });
});

describe("formatDateTime", () => {
    const instant = Date.UTC(2026, 2, 29, 0, 30);

    test("formats in the given time zone, across the DST switch", () => {
        const paris = formatDateTime(instant, { locale: "en-GB", timeZone: "Europe/Paris" });
        const newYork = formatDateTime(instant, { locale: "en-GB", timeZone: "America/New_York" });

        expect(paris).toBe("29 Mar 2026, 01:30");
        expect(newYork).toBe("28 Mar 2026, 20:30");
    });

    test("the default locale is the browser's, not the UI language", () => {
        expect(DATE_LOCALE).toBeUndefined();
        expect(formatDateTime(instant, { timeZone: "UTC" })).toBe(
            new Intl.DateTimeFormat(undefined, {
                dateStyle: "medium",
                timeStyle: "short",
                timeZone: "UTC",
            }).format(instant),
        );
    });

    test("uses the locale's conventions", () => {
        expect(formatDateTime(instant, { locale: "en-US", timeZone: "UTC" })).toBe("Mar 29, 2026, 12:30 AM");
    });

    test("an invalid time formats as an empty string", () => {
        expect(formatDateTime(parseUtc("2026-03-29T00:30:00"))).toBe("");
    });
});

describe("formatTime", () => {
    const instant = Date.UTC(2026, 8, 27, 12, 5);

    test("the time only, in the given zone and locale", () => {
        expect(formatTime(instant, { locale: "en-GB", timeZone: "Europe/Paris" })).toBe("14:05");
        expect(formatTime(instant, { locale: "en-US", timeZone: "UTC" })).toBe("12:05 PM");
    });

    test("an invalid time formats as an empty string", () => {
        expect(formatTime(Number.NaN)).toBe("");
    });
});

describe("formatDate", () => {
    test("the date only, in the given zone", () => {
        const instant = parseUtc("2026-03-29T00:30:00Z");
        expect(formatDate(instant, { locale: "en-GB", timeZone: "Europe/Paris" })).toBe("29 Mar 2026");
        expect(formatDate(instant, { locale: "en-GB", timeZone: "America/New_York" })).toBe("28 Mar 2026");
        expect(formatDate(Number.NaN)).toBe("");
    });
});

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("formatRelative", () => {
    const now = parseUtc("2026-09-27T12:00:00Z");
    const paris = { locale: "en", timeZone: "Europe/Paris", now };

    test.each([
        [0, "now"],
        [44 * SECOND, "now"],
        [45 * SECOND, "1 minute ago"],
        [5 * MINUTE, "5 minutes ago"],
        [44 * MINUTE, "44 minutes ago"],
        [45 * MINUTE, "1 hour ago"],
        [3 * HOUR, "3 hours ago"],
        [21 * HOUR, "21 hours ago"],
        [23 * HOUR, "yesterday"],
        [2 * DAY, "2 days ago"],
        [6 * DAY, "6 days ago"],
        [7 * DAY, "Sep 20, 2026"],
        [400 * DAY, "Aug 23, 2025"],
    ])("%d ms ago reads %j", (ago, expected) => {
        expect(formatRelative(now - ago, paris)).toBe(expected);
    });

    test("a time slightly in the future (clock skew) reads now", () => {
        expect(formatRelative(now + 5 * MINUTE, paris)).toBe("now");
    });

    test("the same calendar day stays in hours, even past 22 h", () => {
        const late = parseUtc("2026-09-27T21:30:00Z"); // 23:30 in Paris
        expect(formatRelative(parseUtc("2026-09-26T22:05:00Z"), { ...paris, now: late })).toBe(
            "23 hours ago",
        );
    });

    test("2026-03-29T00:30:00Z is a week old: its date depends on the zone", () => {
        const instant = parseUtc("2026-03-29T00:30:00Z");
        const later = instant + 10 * DAY;
        expect(formatRelative(instant, { locale: "en-GB", timeZone: "Europe/Paris", now: later })).toBe(
            "29 Mar 2026",
        );
        expect(formatRelative(instant, { locale: "en-GB", timeZone: "America/New_York", now: later })).toBe(
            "28 Mar 2026",
        );
    });

    test("2026-03-29T00:30:00Z is yesterday in New York but today in Paris at 23:00 UTC", () => {
        const instant = parseUtc("2026-03-29T00:30:00Z");
        const evening = parseUtc("2026-03-29T21:00:00Z"); // 23:00 in Paris, 17:00 in New York
        expect(formatRelative(instant, { locale: "en", timeZone: "Europe/Paris", now: evening })).toBe(
            "21 hours ago",
        );
        expect(calendarDaysAgo(instant, evening, "Europe/Paris")).toBe(0);
        expect(calendarDaysAgo(instant, evening, "America/New_York")).toBe(1);
    });

    test("an invalid time formats as an empty string", () => {
        expect(formatRelative(parseUtc("2026-03-29"))).toBe("");
    });
});

describe("relative time elements", () => {
    const now = parseUtc("2026-09-27T12:00:00Z");
    const options = { locale: "en", timeZone: "UTC", now };

    test("setRelativeTime shows the relative time with the full date and time as its tooltip", () => {
        const element = setRelativeTime(document.createElement("span"), now - 5 * MINUTE, options);

        expect(element.textContent).toBe("5 minutes ago");
        expect(element.title).toBe(formatDateTime(now - 5 * MINUTE, options));
        expect(element.title).toBe("Sep 27, 2026, 11:55 AM");
    });

    test("an invalid time leaves the element empty and unmarked", () => {
        const element = setRelativeTime(document.createElement("span"), Number.NaN, options);

        expect(element.textContent).toBe("");
        expect(element.title).toBe("");
        expect(element.hasAttribute("data-relative-time")).toBe(false);
    });

    test("refreshRelativeTimes formats the marked elements again for a new now", () => {
        const root = document.createElement("div");
        const element = setRelativeTime(document.createElement("span"), now - 5 * MINUTE, options);
        root.append(element);

        refreshRelativeTimes(root, { ...options, now: now + HOUR });

        expect(element.textContent).toBe("1 hour ago");
    });

    test("relativeTimeParts keeps the translated words around the time element", () => {
        const [before, time, after] = relativeTimeParts(
            (t) => I18n.translate("home.trash.deleted{0}", t),
            now - 2 * DAY,
            options,
        );
        const text = I18n.translate("home.trash.deleted{0}", "2 days ago");
        expect(`${before}${(time as HTMLElement).textContent}${after}`).toBe(text);
        expect((time as HTMLElement).title).toBe(formatDateTime(now - 2 * DAY, options));
    });

    test("watchRelativeTimes refreshes every minute and when the page shows again, until stopped", () => {
        rs.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
        const root = document.createElement("div");
        const element = setRelativeTime(document.createElement("span"), Date.now() - 5 * MINUTE);
        root.append(element);
        const stop = watchRelativeTimes(root);
        try {
            element.textContent = "stale";
            rs.advanceTimersByTime(MINUTE);
            expect(element.textContent).toBe(formatRelative(Number(element.dataset["relativeTime"])));

            element.textContent = "stale";
            document.dispatchEvent(new Event("visibilitychange"));
            expect(element.textContent).not.toBe("stale");

            stop();
            element.textContent = "stale";
            rs.advanceTimersByTime(MINUTE);
            document.dispatchEvent(new Event("visibilitychange"));
            expect(element.textContent).toBe("stale");
        } finally {
            stop();
            rs.useRealTimers();
        }
    });
});

describe("groupByLocalDay", () => {
    const groups = (times: string[], now: string, timeZone: string) =>
        groupByLocalDay(times, parseUtc, { locale: "en-US", timeZone, now: parseUtc(now) }).map((g) => [
            g.key,
            g.items,
        ]);

    test("today, yesterday, the last 7 days, then months — newest first, order kept", () => {
        const result = groupByLocalDay(
            [
                "2026-09-27T09:00:00Z",
                "2026-09-27T01:00:00Z",
                "2026-09-26T12:00:00Z",
                "2026-09-22T12:00:00Z",
                "2026-09-20T12:00:00Z",
                "2026-08-31T12:00:00Z",
                "2026-07-01T12:00:00Z",
                "2025-07-01T12:00:00Z",
            ],
            parseUtc,
            { locale: "en-US", timeZone: "Europe/Paris", now: parseUtc("2026-09-27T12:00:00Z") },
        );

        expect(result.map((g) => [g.key, g.label, g.items.length])).toEqual([
            ["today", I18n.translate("dateTime.today"), 2],
            ["yesterday", I18n.translate("dateTime.yesterday"), 1],
            ["last7Days", I18n.translate("dateTime.last7Days"), 1],
            ["2026-09", "September 2026", 1],
            ["2026-08", "August 2026", 1],
            ["2026-07", "July 2026", 1],
            ["2025-07", "July 2025", 1],
        ]);
    });

    test("2026-03-29T00:30:00Z is today in Paris but yesterday in New York", () => {
        const now = "2026-03-29T21:00:00Z";
        expect(groups(["2026-03-29T00:30:00Z"], now, "Europe/Paris")).toEqual([
            ["today", ["2026-03-29T00:30:00Z"]],
        ]);
        expect(groups(["2026-03-29T00:30:00Z"], now, "America/New_York")).toEqual([
            ["yesterday", ["2026-03-29T00:30:00Z"]],
        ]);
    });

    test("spring forward (a 23 h day): calendar days, not 24 h spans", () => {
        // Paris, 29 March 2026 has 23 hours. Now: 30 March 00:30 local.
        const now = "2026-03-29T22:30:00Z";
        // 29 March 00:30 local, 23 h ago: yesterday. 28 March 23:59 local, 23 h 31 min ago: two days back.
        expect(groups(["2026-03-28T23:30:00Z", "2026-03-28T22:59:00Z"], now, "Europe/Paris")).toEqual([
            ["yesterday", ["2026-03-28T23:30:00Z"]],
            ["last7Days", ["2026-03-28T22:59:00Z"]],
        ]);
    });

    test("fall back (a 25 h day): calendar days, not 24 h spans", () => {
        // Paris, 25 October 2026 has 25 hours. Now: 26 October 00:10 local.
        const now = "2026-10-25T23:10:00Z";
        // 25 October 00:05 local, 25 h 5 min ago: still yesterday.
        expect(groups(["2026-10-24T22:05:00Z", "2026-10-24T21:55:00Z"], now, "Europe/Paris")).toEqual([
            ["yesterday", ["2026-10-24T22:05:00Z"]],
            ["last7Days", ["2026-10-24T21:55:00Z"]],
        ]);
        // New York falls back on 1 November 2026. Now: 2 November 00:10 local (EST).
        expect(groups(["2026-11-01T04:05:00Z"], "2026-11-02T05:10:00Z", "America/New_York")).toEqual([
            ["yesterday", ["2026-11-01T04:05:00Z"]],
        ]);
    });

    test("months are local too: the last evening of August in New York is September in Paris", () => {
        const time = "2026-09-01T02:00:00Z";
        const now = "2026-10-20T12:00:00Z";
        expect(groups([time], now, "Europe/Paris")).toEqual([["2026-09", [time]]]);
        expect(groups([time], now, "America/New_York")).toEqual([["2026-08", [time]]]);
    });

    test("a future time (clock skew) is today; an invalid one goes last", () => {
        const now = "2026-09-27T12:00:00Z";
        expect(groups(["2026-09-27T12:05:00Z", "2026-09-27T12:00:00"], now, "UTC")).toEqual([
            ["today", ["2026-09-27T12:05:00Z"]],
            ["unknown", ["2026-09-27T12:00:00"]],
        ]);
    });
});
