// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { formatDateTime, formatTime, parseUtc } from "../src";

describe("parseUtc", () => {
    test.each([
        ["2026-03-29T00:30:00Z", Date.UTC(2026, 2, 29, 0, 30)],
        ["2026-03-29T00:30:00.123Z", Date.UTC(2026, 2, 29, 0, 30, 0, 123)],
        ["2026-03-29T00:30:00.1234567z", Date.UTC(2026, 2, 29, 0, 30, 0, 123)],
        ["2026-03-29T02:30:00+02:00", Date.UTC(2026, 2, 29, 0, 30)],
        ["2026-03-28T19:30:00-05:00", Date.UTC(2026, 2, 29, 0, 30)],
        ["2026-03-29T00:30Z", Date.UTC(2026, 2, 29, 0, 30)],
    ])("reads %s", (iso, expected) => {
        expect(parseUtc(iso)).toBe(expected);
    });

    test.each([
        "2026-03-29T00:30:00",
        "2026-03-29",
        "2026-03-29 00:30:00Z",
        "",
        "yesterday",
    ])("rejects %j (no zone designator or not a date-time)", (iso) => {
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
