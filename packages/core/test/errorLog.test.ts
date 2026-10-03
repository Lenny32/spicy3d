// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { ErrorLog } from "../src/errorLog";
import { PubSub } from "../src/foundation/pubsub";

describe("ErrorLog", () => {
    afterEach(() => ErrorLog.clear());

    test("report stores an entry and notifies listeners", () => {
        const seen: (number | undefined)[] = [];
        const stop = ErrorLog.subscribe((e) => seen.push(e?.id));
        const entry = ErrorLog.report("boom", { details: "stack" });
        stop();
        expect(ErrorLog.entries).toEqual([entry]);
        expect(entry.message).toBe("boom");
        expect(entry.details).toBe("stack");
        expect(seen).toEqual([entry.id]);
    });

    test("clear empties the list and notifies with undefined", () => {
        ErrorLog.report("a");
        const seen: unknown[] = [];
        const stop = ErrorLog.subscribe((e) => seen.push(e));
        ErrorLog.clear();
        stop();
        expect(ErrorLog.entries).toHaveLength(0);
        expect(seen).toEqual([undefined]);
    });

    test("keeps only the newest 200 entries", () => {
        for (let i = 0; i < 205; i++) ErrorLog.report(`e${i}`);
        expect(ErrorLog.entries).toHaveLength(200);
        expect(ErrorLog.entries[199]?.message).toBe("e204");
    });

    test("install logs displayError once, however often it runs", () => {
        ErrorLog.install();
        ErrorLog.install();
        PubSub.default.pub("displayError", "red toast");
        expect(ErrorLog.entries.map((e) => e.message)).toEqual(["red toast"]);
    });

    test("install logs uncaught errors and rejections", () => {
        ErrorLog.install();
        window.dispatchEvent(new ErrorEvent("error", { message: "oops", error: new Error("oops") }));
        const rejection = new Event("unhandledrejection") as Event & { reason?: unknown };
        rejection.reason = new Error("nope");
        window.dispatchEvent(rejection);
        expect(ErrorLog.entries.map((e) => [e.source, e.message])).toEqual([
            ["uncaught", "oops"],
            ["promise", "nope"],
        ]);
    });
});
