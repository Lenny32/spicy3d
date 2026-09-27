// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import type { LoggerLevel } from "../src";
import { Logger } from "../src";

// In non-production builds logger.ts replaces Logger.debug/info/warn/error with the
// corresponding console methods at module load time, so the level filter does not
// apply in this test environment.
const originalDebug = Logger.debug;
const originalInfo = Logger.info;
const originalWarn = Logger.warn;
const originalError = Logger.error;

describe("Logger class", () => {
    beforeEach(() => {
        Logger.level = "info";
    });

    afterEach(() => {
        Logger.debug = originalDebug;
        Logger.info = originalInfo;
        Logger.warn = originalWarn;
        Logger.error = originalError;
        Logger.level = "info";
    });

    describe("level getter/setter", () => {
        test("default level should be info", () => {
            expect(Logger.level).toBe("info");
        });

        test("should set and get every valid level", () => {
            const levels: LoggerLevel[] = ["debug", "info", "warn", "error"];
            for (const level of levels) {
                Logger.level = level;
                expect(Logger.level).toBe(level);
            }
        });
    });

    describe("non-production console wiring", () => {
        test("debug should be the console.debug function", () => {
            expect(Logger.debug).toBe(console.debug);
        });

        test("info should be the console.log function", () => {
            expect(Logger.info).toBe(console.log);
        });

        test("warn should be the console.warn function", () => {
            expect(Logger.warn).toBe(console.warn);
        });

        test("error should be the console.error function", () => {
            expect(Logger.error).toBe(console.error);
        });
    });

    // Logger.* hold the console references captured at module load, so spying on
    // console afterwards cannot intercept them; re-wire the same way logger.ts does
    // at startup to route the calls through the spies.
    describe("console output", () => {
        test("debug should forward all arguments to console.debug", () => {
            const spy = rs.spyOn(console, "debug").mockImplementation(() => {});
            Logger.debug = console.debug;

            const obj = { key: "value" };
            Logger.debug("test", obj, 123);

            expect(spy).toHaveBeenCalledTimes(1);
            expect(spy).toHaveBeenCalledWith("test", obj, 123);
            spy.mockRestore();
        });

        test("info should forward all arguments to console.log", () => {
            const spy = rs.spyOn(console, "log").mockImplementation(() => {});
            Logger.info = console.log;

            Logger.info("a", 1, true);

            expect(spy).toHaveBeenCalledTimes(1);
            expect(spy).toHaveBeenCalledWith("a", 1, true);
            spy.mockRestore();
        });

        test("warn should forward all arguments to console.warn", () => {
            const spy = rs.spyOn(console, "warn").mockImplementation(() => {});
            Logger.warn = console.warn;

            Logger.warn("warning", { code: 42 });

            expect(spy).toHaveBeenCalledTimes(1);
            expect(spy).toHaveBeenCalledWith("warning", { code: 42 });
            spy.mockRestore();
        });

        test("error should forward all arguments to console.error", () => {
            const spy = rs.spyOn(console, "error").mockImplementation(() => {});
            Logger.error = console.error;

            const err = new Error("test");
            Logger.error("failed", err);

            expect(spy).toHaveBeenCalledTimes(1);
            expect(spy).toHaveBeenCalledWith("failed", err);
            spy.mockRestore();
        });
    });

    describe("isEnabled", () => {
        test("should enable exactly the levels at or above the current level", () => {
            const expectations: Record<LoggerLevel, Record<LoggerLevel, boolean>> = {
                debug: { debug: true, info: true, warn: true, error: true },
                info: { debug: false, info: true, warn: true, error: true },
                warn: { debug: false, info: false, warn: true, error: true },
                error: { debug: false, info: false, warn: false, error: true },
            };
            for (const [current, levels] of Object.entries(expectations) as [
                LoggerLevel,
                Record<LoggerLevel, boolean>,
            ][]) {
                Logger.level = current;
                for (const [level, expected] of Object.entries(levels) as [LoggerLevel, boolean][]) {
                    expect(Logger.isEnabled(level)).toBe(expected);
                }
            }
        });
    });

    describe("level filtering", () => {
        test("debug should still write to console when a higher level is set", () => {
            const spy = rs.spyOn(console, "debug").mockImplementation(() => {});
            Logger.debug = console.debug;
            Logger.level = "error";

            Logger.debug("still logged");

            expect(spy).toHaveBeenCalledTimes(1);
            expect(spy).toHaveBeenCalledWith("still logged");
            spy.mockRestore();
        });

        test("error should still write to console when a lower level is set", () => {
            const spy = rs.spyOn(console, "error").mockImplementation(() => {});
            Logger.error = console.error;
            Logger.level = "debug";

            Logger.error("still logged");

            expect(spy).toHaveBeenCalledTimes(1);
            expect(spy).toHaveBeenCalledWith("still logged");
            spy.mockRestore();
        });
    });
});
