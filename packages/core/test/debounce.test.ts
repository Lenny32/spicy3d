// Part of the Spicy3D Project, derived from Chili3D, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { rs } from "@rstest/core";
import { debounce } from "../src";

describe("debounce function", () => {
    beforeEach(() => {
        rs.useFakeTimers();
    });

    afterEach(() => {
        rs.useRealTimers();
    });

    test("should return a function", () => {
        const result = debounce(() => {}, 100);
        expect(typeof result).toBe("function");
    });

    test("should delay function execution", () => {
        const func = rs.fn(() => {});
        const debouncedFunc = debounce(func, 50);

        debouncedFunc();
        expect(func).not.toHaveBeenCalled();

        rs.advanceTimersByTime(60);
        expect(func).toHaveBeenCalledTimes(1);
    });

    test("should call function with correct arguments", () => {
        const func = rs.fn((_arg1: string, _arg2: number, _arg3: { key: string }) => {});
        const debouncedFunc = debounce(func, 50);

        debouncedFunc("arg1", 123, { key: "value" });

        rs.advanceTimersByTime(60);
        expect(func).toHaveBeenCalledWith("arg1", 123, { key: "value" });
    });

    test("should only call function once when called multiple times within delay period", () => {
        const func = rs.fn(() => {});
        const debouncedFunc = debounce(func, 50);

        debouncedFunc();
        debouncedFunc();
        debouncedFunc();

        rs.advanceTimersByTime(60);
        expect(func).toHaveBeenCalledTimes(1);
    });

    test("should call function again after delay when called multiple times", () => {
        const func = rs.fn(() => {});
        const debouncedFunc = debounce(func, 50);

        debouncedFunc();
        rs.advanceTimersByTime(60);
        expect(func).toHaveBeenCalledTimes(1);

        debouncedFunc();
        rs.advanceTimersByTime(60);
        expect(func).toHaveBeenCalledTimes(2);
    });

    test("should reset timer on each call", () => {
        const func = rs.fn(() => {});
        const debouncedFunc = debounce(func, 50);

        debouncedFunc();
        rs.advanceTimersByTime(30);
        expect(func).not.toHaveBeenCalled();

        debouncedFunc();
        rs.advanceTimersByTime(30);
        expect(func).not.toHaveBeenCalled();

        rs.advanceTimersByTime(30);
        expect(func).toHaveBeenCalledTimes(1);
    });

    test("should handle zero delay", () => {
        const func = rs.fn(() => {});
        const debouncedFunc = debounce(func, 0);

        debouncedFunc();
        debouncedFunc();

        rs.advanceTimersByTime(10);
        expect(func).toHaveBeenCalledTimes(1);
    });

    test("should handle large delay", () => {
        const func = rs.fn(() => {});
        const debouncedFunc = debounce(func, 200);

        debouncedFunc();
        rs.advanceTimersByTime(150);
        expect(func).not.toHaveBeenCalled();

        rs.advanceTimersByTime(60);
        expect(func).toHaveBeenCalledTimes(1);
    });

    test("should work with no arguments function", () => {
        const func = rs.fn(() => {});
        const debouncedFunc = debounce(func, 50);

        debouncedFunc();

        rs.advanceTimersByTime(60);
        expect(func).toHaveBeenCalledTimes(1);
    });

    test("should handle concurrent debounced functions", () => {
        const func1 = rs.fn(() => {});
        const func2 = rs.fn(() => {});
        const debouncedFunc1 = debounce(func1, 50);
        const debouncedFunc2 = debounce(func2, 50);

        debouncedFunc1();
        debouncedFunc2();

        rs.advanceTimersByTime(30);

        debouncedFunc1();
        debouncedFunc2();

        rs.advanceTimersByTime(60);

        expect(func1).toHaveBeenCalledTimes(1);
        expect(func2).toHaveBeenCalledTimes(1);
    });
});
